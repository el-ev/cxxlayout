/// <reference types="emscripten" />
export interface CxxLayoutModule extends EmscriptenModule {
    ccall: typeof ccall;
    _cleanup(): void;
    _getRecordList(): number;
    _analyzeSource(source: number): void;
    _getLayoutForRecord(id: number): number;
    _setArgs(newArgs: number): void;
    _malloc(size: number): number;
    _free(ptr: number): void;
    stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
    UTF8ToString(ptr: number): string;
}

declare const CxxLayoutModule: EmscriptenModuleFactory<CxxLayoutModule>;
export default CxxLayoutModule;
