import type { HookFsLike } from './hookFs'

/**
 * Both separators collapse to one, exactly like the providers' FakeFs, so a
 * test can register a fixture with POSIX paths and still match a path the
 * installer built with node:path.join on Windows.
 */
function normalize(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '')
}

/**
 * In-memory HookFsLike for the installer tests. Directories are explicit
 * (addDir / ensureDir) because "does this Claude root exist at all" is a
 * decision the installer makes, and a fake that invented directories would
 * hide it.
 */
export class FakeHookFs implements HookFsLike {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()
  /**
   * The mode `writeSecretText` recorded for a path (#588 T6 security fix), so
   * a test can assert a secret was asked to be written owner-only without a
   * real filesystem. `writeText` clears any entry, so an ordinary file is
   * never left reading as forced-restrictive from an earlier secret write to
   * the same path.
   */
  private readonly modes = new Map<string, number>()

  /** Set by a test to make the next write of a given path fail. */
  failWrite?: (path: string) => Error | null

  /** Set by a test to make a file removal fail (#588 T6). */
  failRemove?: (path: string) => Error | null

  addFile(path: string, content: string): void {
    this.files.set(normalize(path), content)
  }

  addDir(path: string): void {
    this.dirs.add(normalize(path))
  }

  read(path: string): string | undefined {
    return this.files.get(normalize(path))
  }

  paths(): string[] {
    return [...this.files.keys()].sort()
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(normalize(path)) ?? null
  }

  async writeText(path: string, content: string): Promise<void> {
    const failure = this.failWrite?.(path)
    if (failure) throw failure
    this.files.set(normalize(path), content)
    this.modes.delete(normalize(path))
  }

  async writeSecretText(path: string, content: string): Promise<void> {
    const failure = this.failWrite?.(path)
    if (failure) throw failure
    this.files.set(normalize(path), content)
    this.modes.set(normalize(path), 0o600)
  }

  /** The mode `writeSecretText` recorded for `path`, or undefined when nothing forced one. */
  modeOf(path: string): number | undefined {
    return this.modes.get(normalize(path))
  }

  async exists(path: string): Promise<boolean> {
    const key = normalize(path)
    return this.files.has(key) || this.dirs.has(key)
  }

  async copyFile(from: string, to: string): Promise<void> {
    const content = this.files.get(normalize(from))
    if (content === undefined) throw new Error(`FakeHookFs: no such file ${from}`)
    this.files.set(normalize(to), content)
  }

  async remove(path: string): Promise<void> {
    const failure = this.failRemove?.(path)
    if (failure) throw failure
    this.files.delete(normalize(path))
  }

  async ensureDir(path: string): Promise<void> {
    this.dirs.add(normalize(path))
  }

  async removeEmptyDir(path: string): Promise<void> {
    const key = normalize(path)
    const prefix = `${key}\\`
    const occupied =
      [...this.files.keys()].some((file) => file.startsWith(prefix)) ||
      [...this.dirs].some((dir) => dir.startsWith(prefix))
    if (!occupied) this.dirs.delete(key)
  }
}
