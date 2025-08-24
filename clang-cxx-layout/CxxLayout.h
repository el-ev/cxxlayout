#include "clang/AST/CharUnits.h"
#include "llvm/ADT/SmallVector.h"
#include <cstdint>
#include <string>

namespace cxxlayout {

enum class FieldType : uint8_t {
  Simple,
  Record,
  BitField,
  NVBase,
  VBase,
  VPtr,
};

inline constexpr std::string_view fieldTypeToString(FieldType ft) {
  switch (ft) {
  case FieldType::Record:
    return "Record";
  case FieldType::VPtr:
    return "VPtr";
  case FieldType::NVBase:
    return "NVBase";
  case FieldType::BitField:
    return "BitField";
  case FieldType::Simple:
    return "Simple";
  default:
    return "Unknown";
  }
}

class FieldInfo;
using FieldInfoPtr = std::unique_ptr<FieldInfo>;

class FieldInfo {
public:
  bool isValid;
  FieldType fieldType;
  std::string name;
  std::string type;
  uint64_t offset; // in bits
  clang::CharUnits size;
  clang::CharUnits align;
  uint64_t bitWidth; // for bitfields
  llvm::SmallVector<FieldInfoPtr> subFields;
};

} // namespace cxxlayout
