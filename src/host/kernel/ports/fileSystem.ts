// Kernel driven port (05 §3, 16 §3 row `FileSystem`). The read half is today's `FsLike`
// (adapters/fsLike.ts), kept as is: same members, same names, same error behaviour, so every
// transplanted test runs unchanged. The typed half carries what the same 16 §3 row asks beyond it:
// writes (the external-config writer and diagnostics) and `ENOENT` etc. mapped to typed results
// where the caller branches on them (16 §2.1: no OS error string crosses the port).
import type { Result } from '../domain/values'

/** One entry of a directory listing. */
export interface DirEntry {
  name: string
  isDirectory: boolean
}

/** One entry of a sized directory listing: a directory's size is 0. */
export interface SizedDirEntry {
  name: string
  isDirectory: boolean
  size: number
}

/** Subset of stat information the app needs. */
export interface FileStat {
  mtimeMs: number
  size: number
  isDirectory: boolean
}

/**
 * Why a typed file operation failed. `busy` and `access-denied` are the locked-file family
 * (`EBUSY`; `EPERM`, `EACCES`) the external-config writer reports as `'locked'` (16 §7.4);
 * `no-space` is disk full (`ENOSPC`, 13 FM-104); every other OS failure is `io`.
 */
export type FsError = 'not-found' | 'no-space' | 'busy' | 'access-denied' | 'io'

export interface FileSystem {
  // --- today's FsLike, kept as is ---------------------------------------------------------
  // Error contract: readTextTail/readTextHead/readJson reject when the file is missing;
  // listDir resolves to [] for a missing directory; stat resolves to null for a missing path.

  /** Read up to `maxBytes` from the END of a UTF-8 text file (bounded tail, ADR-006 item 3). */
  readTextTail(path: string, maxBytes: number): Promise<string>
  /** Read up to `maxBytes` from the START of a UTF-8 text file. */
  readTextHead(path: string, maxBytes: number): Promise<string>
  readJson(path: string): Promise<unknown>
  listDir(path: string): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat | null>
  exists(path: string): Promise<boolean>

  // --- typed results: never rejects on an OS failure --------------------------------------

  /** The whole file's bytes, or why they could not be read. */
  readFile(path: string): Promise<Result<Uint8Array, FsError>>
  /** Names, kinds and sizes of a directory's entries; a missing directory is `not-found`. */
  listDirWithSizes(path: string): Promise<Result<SizedDirEntry[], FsError>>
  /**
   * Replaces the file's content by writing a temporary sibling and renaming it over the target,
   * so a reader sees the old bytes or the new bytes, never a partial file; on failure no
   * temporary file is left behind. A missing parent directory is `not-found`.
   */
  writeFileAtomic(path: string, data: Uint8Array | string): Promise<Result<void, FsError>>
}
