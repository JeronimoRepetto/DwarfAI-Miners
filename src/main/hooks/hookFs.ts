import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write-capable filesystem port, separate from the read-only `FsLike` the
 * providers use.
 *
 * Only the hook installer needs to write, and what it writes is the user's own
 * global Claude Code configuration — so keeping this surface tiny and injected
 * is what lets the merge logic be tested exhaustively without ever touching a
 * real settings.json.
 */
export interface HookFsLike {
  /** File contents, or null when the file does not exist. */
  readText(path: string): Promise<string | null>
  writeText(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  copyFile(from: string, to: string): Promise<void>
  /** Deletes a file; a missing file is not an error. */
  remove(path: string): Promise<void>
  /** Creates a directory and its parents; an existing directory is not an error. */
  ensureDir(path: string): Promise<void>
}

/** Real Node implementation used by the running app. */
export class NodeHookFs implements HookFsLike {
  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * Write through a sibling temp file and rename over the target, so a crash
   * or a concurrent reader never observes a half-written settings.json.
   *
   * Windows can refuse the rename when another process holds the destination
   * open; falling back to a direct write there is no worse than not having
   * tried, and still beats failing the install outright.
   */
  async writeText(path: string, content: string): Promise<void> {
    const temporary = `${path}.dwarfai-tmp`
    try {
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, path)
    } catch {
      await rm(temporary, { force: true })
      await writeFile(path, content, 'utf8')
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  async copyFile(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true })
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }
}
