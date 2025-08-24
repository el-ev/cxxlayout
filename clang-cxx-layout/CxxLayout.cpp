#include "clang/AST/ASTConsumer.h"
#include "clang/AST/Decl.h"
#include "clang/AST/DeclCXX.h"
#include "clang/AST/RecordLayout.h"
#include "clang/AST/RecursiveASTVisitor.h"
#include "clang/Frontend/CompilerInstance.h"
#include "clang/Tooling/Tooling.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/Support/Signals.h"
#include <memory>

#include "CxxLayout.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

using namespace clang::tooling;
using namespace llvm;

using namespace cxxlayout;

namespace cxxlayout {

static const std::string DEFAULT_ARGS = "--target=x86_64-pc-linux-gnu";

struct LayoutContext {
  std::string args = DEFAULT_ARGS;
  std::string recordList;
  std::map<int64_t, FieldInfoPtr> records;
};

inline static LayoutContext &getContext() {
  static LayoutContext C;
  return C;
}

static void writeEscaped(llvm::raw_ostream &OS, llvm::StringRef S) {
  for (unsigned i = 0, e = S.size(); i < e; ++i) {
    unsigned char C = static_cast<unsigned char>(S[i]);
    switch (C) {
    case '"':
      OS << "\\\"";
      break;
    case '\\':
      OS << "\\\\";
      break;
    case '\b':
      OS << "\\b";
      break;
    case '\f':
      OS << "\\f";
      break;
    case '\n':
      OS << "\\n";
      break;
    case '\r':
      OS << "\\r";
      break;
    case '\t':
      OS << "\\t";
      break;
    default:
      if (C < 0x20) {
        static const char Hex[] = "0123456789ABCDEF";
        OS << "\\u00" << Hex[(C >> 4) & 0xF] << Hex[C & 0xF];
      } else {
        OS << S[i];
      }
    }
  }
}

static std::vector<std::string> splitArgs(const std::string &Args) {
  std::vector<std::string> Result;
  std::string Current;
  for (char C : Args) {
    if (C == ' ') {
      if (!Current.empty()) {
        Result.push_back(Current);
        Current.clear();
      }
    } else {
      Current.push_back(C);
    }
  }
  if (!Current.empty())
    Result.push_back(Current);
  return Result;
}

static char *dupJson(const std::string &S) {
  char *Buf = static_cast<char *>(std::malloc(S.size() + 1));
  if (!Buf)
    return nullptr;
  std::memcpy(Buf, S.c_str(), S.size() + 1);
  return Buf;
}

static FieldInfoPtr analyzeRecord(const clang::ASTContext &Ctx,
                                  const clang::CXXRecordDecl *RD) {
  assert(Ctx.getTargetInfo().getCXXABI().isItaniumFamily() &&
         "Only Itanium ABI is supported for now");
  FieldInfoPtr Info = std::make_unique<FieldInfo>();

  const clang::ASTRecordLayout &Layout = Ctx.getASTRecordLayout(RD);
  Info->isValid = !RD->isInvalidDecl();
  Info->fieldType = FieldType::Record;
  Info->type = RD->getQualifiedNameAsString();
  Info->size = Layout.getSize();
  Info->align = Layout.getAlignment();

  // First the vptr if any
  if (Layout.hasOwnVFPtr()) {
    FieldInfoPtr VPtrInfo = std::make_unique<FieldInfo>();
    VPtrInfo->isValid = true;
    VPtrInfo->fieldType = FieldType::VPtr;
    VPtrInfo->type = "vptr";
    VPtrInfo->offset = 0; // always at offset 0
    VPtrInfo->size = Ctx.toCharUnitsFromBits(
        Ctx.getTargetInfo().getPointerWidth(clang::LangAS::Default));
    VPtrInfo->align = Ctx.toCharUnitsFromBits(
        Ctx.getTargetInfo().getPointerAlign(clang::LangAS::Default));
    Info->subFields.push_back(std::move(VPtrInfo));
  }

  // Then the non-virtual bases
  SmallVector<FieldInfoPtr> Bases;
  for (const auto &Base : RD->bases()) {
    const clang::CXXRecordDecl *BaseDecl = Base.getType()->getAsCXXRecordDecl();
    if (Base.isVirtual())
      continue; // VBase isn't here
    FieldInfoPtr BaseInfo = analyzeRecord(Ctx, BaseDecl);
    BaseInfo->fieldType = FieldType::NVBase;
    BaseInfo->offset = Layout.getBaseClassOffset(BaseDecl).getQuantity() * 8;
    Info->isValid &= BaseInfo->isValid;
    Bases.push_back(std::move(BaseInfo));
  }
  llvm::sort(Bases, [](const FieldInfoPtr &A, const FieldInfoPtr &B) {
    return A->offset < B->offset;
  });
  Info->subFields.insert(Info->subFields.end(),
                         std::make_move_iterator(Bases.begin()),
                         std::make_move_iterator(Bases.end()));

  // Now the fields
  uint64_t fieldIndex = 0;
  for (const auto *Field : RD->fields()) {
    FieldInfoPtr SubFieldInfo;
    uint64_t Offset = Layout.getFieldOffset(fieldIndex);

    if (const clang::CXXRecordDecl *FieldRecord =
            Field->getType()->getAsCXXRecordDecl()) {
      SubFieldInfo = analyzeRecord(Ctx, FieldRecord);
      SubFieldInfo->name = Field->getNameAsString();
      SubFieldInfo->offset = Offset;
      Info->isValid &= SubFieldInfo->isValid;
      Info->subFields.push_back(std::move(SubFieldInfo));
    } else {
      SubFieldInfo = std::make_unique<FieldInfo>();
      SubFieldInfo->isValid = !Field->isInvalidDecl();
      Info->isValid &= SubFieldInfo->isValid;
      SubFieldInfo->name = Field->getNameAsString();
      SubFieldInfo->type = Field->getType().getAsString();
      SubFieldInfo->offset = Offset;
      SubFieldInfo->size = Ctx.getTypeSizeInChars(Field->getType());
      SubFieldInfo->align = Ctx.getTypeAlignInChars(Field->getType());
      if (Field->isBitField()) {
        SubFieldInfo->fieldType = FieldType::BitField;
        SubFieldInfo->bitWidth = Field->getBitWidthValue();
        Info->subFields.push_back(std::move(SubFieldInfo));
      } else {
        SubFieldInfo->fieldType = FieldType::Simple;
        Info->subFields.push_back(std::move(SubFieldInfo));
      }
    }

    ++fieldIndex;
  }

  // TODO: Virtual bases

  return Info;
}

class RecursiveDeclVisitor
    : public clang::RecursiveASTVisitor<RecursiveDeclVisitor> {
  LayoutContext &LCtx;

public:
  RecursiveDeclVisitor() : LCtx(getContext()) {}
  bool VisitCXXRecordDecl(clang::CXXRecordDecl *RD) {
    if (!RD || !RD->isCompleteDefinition())
      return true;
    int64_t Id = RD->getID();
    if (LCtx.records.find(Id) != LCtx.records.end())
      return true;
    FieldInfoPtr Info = analyzeRecord(RD->getASTContext(), RD);
    LCtx.records[Id] = std::move(Info);
    return true;
  }
};

class Consumer : public clang::ASTConsumer {
  LayoutContext &LCtx;

public:
  Consumer(clang::CompilerInstance &CI) : LCtx(getContext()) {}
  void HandleTranslationUnit(clang::ASTContext &Ctx) override {
    RecursiveDeclVisitor V;
    V.TraverseDecl(Ctx.getTranslationUnitDecl());
  }
};

class Action : public clang::ASTFrontendAction {
  LayoutContext &LCtx;

public:
  Action() : LCtx(getContext()) {}
  std::unique_ptr<clang::ASTConsumer>
  CreateASTConsumer(clang::CompilerInstance &CI, StringRef InFile) override {
    return std::make_unique<Consumer>(CI);
  }
};

} // namespace cxxlayout

extern "C" {
void EMSCRIPTEN_KEEPALIVE cleanup() {
  auto &Ctx = cxxlayout::getContext();
  Ctx.recordList.clear();
  Ctx.records.clear();
}

const char *EMSCRIPTEN_KEEPALIVE getRecordList() {
  auto &Ctx = cxxlayout::getContext();
  auto &RecordList = Ctx.recordList;
  RecordList.clear();
  RecordList.reserve(128);
  RecordList.append("[");
  bool first = true;
  for (const auto &R : Ctx.records) {
    if (!first)
      RecordList.push_back(',');
    RecordList.append("{\"id\":\"");
    RecordList.append(llvm::utostr(R.first));
    RecordList.append("\",\"name\":\"");
    std::string Escaped;
    {
      std::string Tmp;
      llvm::raw_string_ostream OS(Tmp);
      writeEscaped(OS, R.second->type);
      OS.flush();
      Escaped = std::move(Tmp);
    }
    RecordList.append(Escaped);
    RecordList.append("\"}");
    first = false;
  }
  RecordList.append("]");
  return dupJson(RecordList);
}

void EMSCRIPTEN_KEEPALIVE analyzeSource(const char *source) {
  auto &Ctx = cxxlayout::getContext();
  std::string localArgs;
  Ctx.recordList.clear();
  Ctx.records.clear();
  localArgs = Ctx.args;
  runToolOnCodeWithArgs(std::make_unique<Action>(), source,
                        splitArgs(localArgs), "input.cpp");
}

const char *EMSCRIPTEN_KEEPALIVE getLayoutForRecord(int64_t id) {
  auto &Ctx = cxxlayout::getContext();
  const cxxlayout::FieldInfo *Root = nullptr;
  auto it = Ctx.records.find(id);
  if (it == Ctx.records.end())
    return dupJson("{}");
  Root = it->second.get();

  std::string Json;
  llvm::raw_string_ostream OS(Json);

  std::function<void(const cxxlayout::FieldInfo &, llvm::raw_ostream &,
                     unsigned)>
      writeField = [&](const cxxlayout::FieldInfo &F, llvm::raw_ostream &Out,
                       unsigned Depth) {
        Out << '{';
        Out << "\"fieldType\":\"" << fieldTypeToString(F.fieldType) << "\"";
        if (!F.name.empty()) {
          Out << ',';
          Out << "\"name\":\"";
          writeEscaped(Out, F.name);
          Out << "\"";
        }
        Out << ',';
        Out << "\"type\":\"";
        writeEscaped(Out, F.type);
        Out << "\"";
        Out << ',';
        Out << "\"size\":" << F.size.getQuantity();
        Out << ',';
        Out << "\"align\":" << F.align.getQuantity();
        Out << ',';
        Out << "\"offset\":" << (F.offset >> 3);
        if (F.fieldType == cxxlayout::FieldType::BitField) {
          Out << ',';
          Out << "\"bitWidth\":" << F.bitWidth;
        }
        if (F.fieldType == FieldType::Record ||
            F.fieldType == FieldType::NVBase) {
          Out << ',';
          Out << "\"subFields\": [";
          bool first = true;
          for (const auto &SFptr : F.subFields) {
            if (!SFptr)
              continue;
            if (!first)
              Out << ',';
            writeField(*SFptr, Out, Depth + 4);
            first = false;
          }
          Out << ']';
        }
        Out << '}';
      };
  writeField(*Root, OS, 0);
  OS.flush();
  return dupJson(Json);
}

void EMSCRIPTEN_KEEPALIVE setArgs(const char *newArgs) {
  auto &Ctx = cxxlayout::getContext();
  if (newArgs && newArgs[0])
    Ctx.args = std::string(newArgs);
  else
    Ctx.args = DEFAULT_ARGS;
}
}
