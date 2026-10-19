// The real FileSystem adapter (16 §3 row `FileSystem`): the read half is the real half of
// adapters/fsLike.ts, transplanted as is; the typed half maps OS error codes to `FsError` so no
// OS error string crosses the port (16 §2.1). `node:fs` lives only under host/platform (R1, R3).
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat as fsStat,
  unlink
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseJsonText } from '../../../contracts/text'
import type { Result } from '../../kernel/domain/values'
import type {
  DirEntry,
  FileStat,
  FileSystem,
  FsError,
  SizedDirEntry
} from '../../kernel/ports/fileSystem'

/** The typed cause of an OS failure: the code decides, the message never crosses the port. */
export function fsErrorOf(error: unknown): FsError {
  const code = (error as { code?: unknown } | null)?.code
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found'
    case 'ENOSPC':
      return 'no-space'
    case 'EBUSY':
      return 'busy'
    case 'EPERM':
    case 'EACCES':
      return 'access-denied'
    default:
      return 'io'
  }
}

/** POSIX permission bits of a mode (`st_mode` without its file-type bits). */
const PERMISSION_BITS = 0o7777
/** What `open` creates a file with when no mode is given: Node's default, kept on Windows. */
const NODE_DEFAULT_FILE_MODE = 0o666

/**
 * The modes of a temp-and-rename write (ISSUE-227, foreman decision 2026-10-16): a file the Host
 * writes may hold a channel token in another tool's folder (ADR-016 item 1), so on POSIX a new file
 * is created owner-only (`create`, then masked by the umask as always), and a file it replaces keeps
 * the person's own permission bits (`chmod`, applied to the temp before the rename, since the rename
 * would otherwise give the target the temp's mode). Windows has no POSIX modes: Node's default,
 * nothing applied, as before.
 */
export function atomicWriteModes(
  existingMode: number | null,
  platform: NodeJS.Platform
): { create: number; chmod: number | null } {
  if (platform === 'win32') return { create: NODE_DEFAULT_FILE_MODE, chmod: null }
  return { create: 0o600, chmod: existingMode === null ? null : existingMode & PERMISSION_BITS }
}

/** The mode of every folder `makeDir` creates: owner-only on POSIX; on Windows none is given, as before. */
export function newDirMode(platform: NodeJS.Platform): number | undefined {
  return platform === 'win32' ? undefined : 0o700
}

/** Real Node implementation used by the running Host. */
export class NodeFs implements FileSystem {
  /** The OS the modes are decided for; the running one unless a test says otherwise. */
  constructor(private readonly options: { platform?: NodeJS.Platform } = {}) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  async readTextTail(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, maxBytes)
      const position = size - length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  }

  async readTextHead(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  }

  async readJson(path: string): Promise<unknown> {
    // Through parseJsonText, not JSON.parse: a document a Windows editor saved
    // opens with an invisible BOM the grammar does not admit (#555). FakeFs
    // does the same, or a green suite would say nothing about this adapter.
    return parseJsonText(await readFile(path, 'utf8'))
  }

  async listDir(path: string): Promise<DirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    } catch {
      return []
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const info = await fsStat(path)
      return { mtimeMs: info.mtimeMs, size: info.size, isDirectory: info.isDirectory() }
    } catch {
      return null
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null
  }

  async readFile(path: string): Promise<Result<Uint8Array, FsError>> {
    try {
      return { ok: true, value: new Uint8Array(await readFile(path)) }
    } catch (error) {
      return { ok: false, error: fsErrorOf(error) }
    }
  }

  async listDirWithSizes(path: string): Promise<Result<SizedDirEntry[], FsError>> {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      const sized: SizedDirEntry[] = []
      for (const entry of entries) {
        if (entry.isDirectory()) {
          sized.push({ name: entry.name, isDirectory: true, size: 0 })
          continue
        }
        try {
          const { size } = await fsStat(join(path, entry.name))
          sized.push({ name: entry.name, isDirectory: false, size })
        } catch (error) {
          // An entry removed between the listing and its stat is a benign race (16 §9
          // `LogDirectory`): it is simply no longer listed.
          if (fsErrorOf(error) !== 'not-found') throw error
        }
      }
      return { ok: true, value: sized }
    } catch (error) {
      return { ok: false, error: fsErrorOf(error) }
    }
  }

  async writeFileAtomic(path: string, data: Uint8Array | string): Promise<Result<void, FsError>> {
    // The temporary sibling lives in the target's own directory, so the rename never crosses a
    // volume and replaces the target in one step.
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    let created = false
    try {
      const modes = atomicWriteModes(await this.modeOf(path), this.platform)
      const handle = await open(temp, 'wx', modes.create)
      created = true
      try {
        await handle.writeFile(data)
        if (modes.chmod !== null) await handle.chmod(modes.chmod)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, path)
      return { ok: true, value: undefined }
    } catch (error) {
      if (created) await unlink(temp).catch(() => undefined)
      return { ok: false, error: fsErrorOf(error) }
    }
  }

  /** The current mode of `path`, `null` when there is no file to keep a mode of (absent or unreadable). */
  private async modeOf(path: string): Promise<number | null> {
    if (this.platform === 'win32') return null
    try {
      return (await fsStat(path)).mode
    } catch {
      return null
    }
  }

  async writeFileInPlace(path: string, data: Uint8Array | string): Promise<Result<void, FsError>> {
    // Owner amendment J: 'r+' opens an existing file only (a missing one is ENOENT, never
    // created); truncate, then write from offset 0, no temporary file and no rename.
    return settled(async () => {
      const handle = await open(path, 'r+')
      try {
        await handle.truncate(0)
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  async appendFile(path: string, data: Uint8Array | string): Promise<Result<void, FsError>> {
    // Flag 'a' creates a missing file but never a missing parent (ENOENT → not-found), so a
    // deleted folder is recreated only by an explicit makeDir (13 FM-108).
    return settled(() => appendFile(path, data, { flag: 'a' }))
  }

  async deleteFile(path: string): Promise<Result<void, FsError>> {
    return settled(() => unlink(path))
  }

  async makeDir(path: string): Promise<Result<void, FsError>> {
    return settled(async () => {
      // Only the folders this call creates get the mode; an existing one is left as it is.
      const mode = newDirMode(this.platform)
      await mkdir(path, mode === undefined ? { recursive: true } : { recursive: true, mode })
    })
  }
}

/** Runs one OS operation and maps its failure to the typed cause. */
async function settled(operation: () => Promise<void>): Promise<Result<void, FsError>> {
  try {
    await operation()
    return { ok: true, value: undefined }
  } catch (error) {
    return { ok: false, error: fsErrorOf(error) }
  }
}
