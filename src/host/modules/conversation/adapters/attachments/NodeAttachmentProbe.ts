// The OS's own answers about a path a UI named, for `FsAttachmentReader` (18 C-17, T-35; ADR-019
// item 9). The kernel `FileSystem` (16 §3) has no realpath and no file type beyond "directory", so
// this adapter reads `node:fs` itself, as mines' `NodePathProbe` (adapters/pathValidation.ts) and
// `FsGitRepoInspector` do. Nothing here opens a file or reads a byte of it (INV-62, NFR-PRIV-04).
//
// - `realpath` is the OS's (`realpath.native`): every symlink and junction followed to the end and
//   `..` taken as the OS takes it, so the path checked is the path a driver would open. Node's
//   JavaScript realpath resolves the spelling's `..` before following links, which is the escape
//   C-17 refuses.
// - `entry` does not follow links (`lstat`): a symlink is `symlink`, a FIFO, a device or a socket is
//   `other`.
// - `readable` asks the OS whether the Host may open the file for reading (`access(R_OK)`).
// Anything that fails answers null or false and never throws.
import { constants, realpath } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { AttachmentFileProbe, AttachmentEntry } from './FsAttachmentReader'

/** The OS realpath (`fs/promises` has no `.native`). */
const nativeRealpath = promisify(realpath.native)

export class NodeAttachmentProbe implements AttachmentFileProbe {
  async realpath(path: string): Promise<string | null> {
    try {
      return await nativeRealpath(path)
    } catch {
      return null
    }
  }

  async entry(path: string): Promise<AttachmentEntry | null> {
    try {
      const stats = await lstat(path)
      if (stats.isFile()) return { kind: 'file', bytes: stats.size }
      if (stats.isDirectory()) return { kind: 'directory', bytes: 0 }
      if (stats.isSymbolicLink()) return { kind: 'symlink', bytes: 0 }
      return { kind: 'other', bytes: 0 }
    } catch {
      return null
    }
  }

  async readable(path: string): Promise<boolean> {
    try {
      await access(path, constants.R_OK)
      return true
    } catch {
      return false
    }
  }
}
