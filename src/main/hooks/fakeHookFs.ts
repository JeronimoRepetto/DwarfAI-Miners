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

  /** Set by a test to make the next write of a given path fail. */
  failWrite?: (path: string) => Error | null

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
    this.files.delete(normalize(path))
  }

  async ensureDir(path: string): Promise<void> {
    this.dirs.add(normalize(path))
  }
}
