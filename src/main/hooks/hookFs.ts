import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
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
  /**
   * Same write as `writeText`, owner-only (#588 T6 security fix): for a file
   * that itself holds a secret in plaintext -- the hook token, or the
   * OpenCode plugin with that token baked in. A bare `writeText` leaves a
   * NEW file at whatever the process umask allows (0644 under the common 022
   * default), readable by every local account -- wider than the same-user
   * threat model Settings' consent copy describes. POSIX gets 0o600; Windows
   * maps a Node `mode` only to the read-only attribute, never to an ACL, and
   * a user-profile directory there is already per-user ACL'd by the OS, so
   * 0o600 is a harmless no-op on that platform rather than a real
   * restriction -- read once here rather than in every caller, per
   * platform-ports.
   */
  writeSecretText(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  copyFile(from: string, to: string): Promise<void>
  /** Deletes a file; a missing file is not an error. */
  remove(path: string): Promise<void>
  /** Creates a directory and its parents; an existing directory is not an error. */
  ensureDir(path: string): Promise<void>
  /**
   * Removes a directory only while it is empty (#588 T6): the OpenCode plugin
   * directory this app may have created is shared with the person's own
   * plugins, so a directory that gained anything else stays. A missing or
   * non-empty directory is not an error.
   */
  removeEmptyDir(path: string): Promise<void>
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

  async writeSecretText(path: string, content: string): Promise<void> {
    const temporary = `${path}.dwarfai-tmp`
    try {
      // `mode` applies to the temp file at CREATION; `rename` then replaces
      // the target's inode with this one wholesale, so the target ends up
      // owner-only regardless of whatever mode it carried before -- no
      // separate chmod needed on this, the normal, path.
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } catch {
      await rm(temporary, { force: true })
      await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
      // Unlike the temp+rename path above, this can overwrite a file that
      // already existed -- and `mode` on `writeFile` is a no-op for a file it
      // did not create, so an explicit chmod is the only way to still land
      // owner-only here. Best-effort: a failure must not turn an otherwise
      // successful write into a reported one.
      await chmod(path, 0o600).catch(() => undefined)
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

  async removeEmptyDir(path: string): Promise<void> {
    try {
      // Non-recursive on purpose: rmdir refuses a directory with anything in
      // it, which is exactly the refusal wanted here.
      await rmdir(path)
    } catch {
      // ENOENT (already gone) and ENOTEMPTY (the person's own plugins) are
      // both the outcome this method promises, not failures.
    }
  }
}
