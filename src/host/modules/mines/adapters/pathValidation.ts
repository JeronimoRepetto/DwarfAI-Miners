// The Host's path probe (18 C-17, T-35; ADR-019 item 9): the OS's own answers about a path a UI
// named, for `resolveFileInMine` (`application/resolveFile.ts`). Synchronous because
// `MinesQueries` is (16 §4.1); the kernel `FileSystem` (16 §3) is asynchronous and has no
// realpath, so this adapter reads `node:fs` itself, as `FsGitRepoInspector` takes the OS realpath.
//
// - `realpath` is the OS's (`realpath.native`): every symlink and junction followed to the end and
//   `..` taken as the OS takes it, so the path compared is the path the OS would open. Node's
//   JavaScript realpath resolves the spelling's `..` before following links, which is the escape
//   C-17 refuses. Anything unreadable answers null and never throws.
// - `kindOf` does not follow links (`lstat`); it is asked about a real path, which holds none.
//   A FIFO, a device or a socket is `other`.
import { lstatSync, realpathSync } from 'node:fs'
import type { EntryKind, MinePathProbe } from '../application/resolveFile'

export class NodePathProbe implements MinePathProbe {
  realpath(path: string): string | null {
    try {
      return realpathSync.native(path)
    } catch {
      return null
    }
  }

  kindOf(realPath: string): EntryKind | null {
    try {
      const stats = lstatSync(realPath)
      if (stats.isFile()) return 'file'
      if (stats.isDirectory()) return 'directory'
      return 'other'
    } catch {
      return null
    }
  }
}
