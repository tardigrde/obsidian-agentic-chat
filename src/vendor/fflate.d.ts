/**
 * Minimal type surface for the vendored fflate browser ESM build
 * (https://github.com/101arrowz/fflate, MIT). Only the pieces used by the
 * plugin's archive importer are declared here; the full types ship with the
 * npm package if more is ever needed.
 */
export interface GunzipOptions {
  out?: Uint8Array;
}

export interface UnzipFileInfo {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
}

export interface UnzipOptions {
  filter?: (file: UnzipFileInfo) => boolean;
}

export interface Unzipped {
  [path: string]: Uint8Array;
}

export declare function gunzipSync(data: Uint8Array, opts?: GunzipOptions): Uint8Array;

export declare function unzipSync(data: Uint8Array, opts?: UnzipOptions): Unzipped;

/** Compression side used to build archive fixtures in tests. */
export declare function gzipSync(data: Uint8Array, opts?: unknown): Uint8Array;

export declare function zipSync(data: Record<string, Uint8Array>, opts?: unknown): Uint8Array;
