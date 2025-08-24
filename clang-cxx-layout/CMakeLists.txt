set(LLVM_LINK_COMPONENTS
  Support
)

add_clang_tool(clang-cxx-layout
  CxxLayout.cpp
)

clang_target_link_libraries(clang-cxx-layout
  PRIVATE
  clangAST
  clangBasic
  clangFrontend
  clangTooling
)
