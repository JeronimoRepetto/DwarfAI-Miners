// The GitRepoInspector double (16 §4.1 row `MineIdentityResolver` / `GitHeadWatchPort`, 16 §2.8):
// both ADR-030 ports over a FakeFs, for the consumers of the mines module. It reads the same `.git`
// facts as FsGitRepoInspector and passes the same conformance suite (`runGitRepoInspectorContract`)
// over the ADR-030 fixture trees, in Windows and POSIX path rules on any host. Links (a second
// spelling of a folder) are registered with `link`, as the OS realpath would follow them.
//
// Ports are type-only (R2), so this double carries its own small path rules instead of importing
// the domain's; the shared suite is what keeps the two in step. Never imported by production code
// (R14).
import type { Instant } from '../../../../kernel/domain/values'
import type { FakeFs } from '../../../../kernel/fakes/FakeFs'
import type { Clock } from '../../../../kernel/ports/clock'
import type { PathStyle } from '../../domain/minePath'
import type { DwarfWorkplace } from '../../domain/worktreeFold'
import type { GitHead, GitHeadWatchPort } from '../gitHeadWatchPort'
import type { MineIdentityResolver } from '../mineIdentityResolver'

/** The same lifetime as the adapter's resolver cache (ADR-030 item 4). */
const TTL_MS = 30_000

const NO_HEAD: GitHead = { kind: 'none' }

export interface FakeGitRepoInspectorOptions {
  readonly fs: FakeFs
  readonly clock: Clock
  readonly style: PathStyle
  /** Whether mine keys fold case (`caseFoldFor` of the volume the test stands for). */
  readonly caseFold: boolean
}

interface Resolution {
  mineKey: string
  workplace?: DwarfWorkplace
}

/** The nearest `.git` and, for a `.git` file, the admin folder it points at. */
interface Checkout {
  readonly folder: string
  /** The admin folder: `<folder>/.git` for a `.git` directory, the pointer's target for a file. */
  readonly gitdir: string | null
  readonly isDirectory: boolean
}

export class FakeGitRepoInspector implements MineIdentityResolver, GitHeadWatchPort {
  private readonly links = new Map<string, string>()
  private readonly resolutions = new Map<string, { at: Instant; value: Resolution }>()
  private readonly headFiles = new Map<string, { at: Instant; value: string | null }>()
  private readonly heads = new Map<string, { mtimeMs: number; head: GitHead }>()

  constructor(private readonly options: FakeGitRepoInspectorOptions) {}

  /** A second spelling: every path under `link` is really under `target`. */
  link(link: string, target: string): void {
    this.links.set(this.normalize(link), this.normalize(target))
  }

  async resolve(cwd: string): Promise<Resolution> {
    if (!this.isAbsolute(cwd)) {
      throw new Error('FakeGitRepoInspector.resolve needs an absolute cwd')
    }
    const now = this.options.clock.now()
    const cached = this.resolutions.get(cwd)
    if (cached !== undefined && now - cached.at < TTL_MS) return cached.value
    const value = await this.resolveUncached(cwd)
    this.resolutions.set(cwd, { at: now, value })
    return value
  }

  async head(cwd: string): Promise<GitHead> {
    if (!this.isAbsolute(cwd)) return NO_HEAD
    const now = this.options.clock.now()
    let cached = this.headFiles.get(cwd)
    if (cached === undefined || now - cached.at >= TTL_MS) {
      const checkout = await this.checkoutOf((await this.realpath(cwd)) ?? this.normalize(cwd))
      const gitdir = checkout?.gitdir ?? null
      cached = { at: now, value: gitdir === null ? null : this.join(gitdir, 'HEAD') }
      this.headFiles.set(cwd, cached)
    }
    if (cached.value === null) return NO_HEAD
    const stat = await this.options.fs.stat(cached.value)
    if (stat === null || stat.isDirectory) return NO_HEAD
    const known = this.heads.get(cached.value)
    if (known !== undefined && known.mtimeMs === stat.mtimeMs) return known.head
    const head = headOf(await this.read(cached.value))
    this.heads.set(cached.value, { mtimeMs: stat.mtimeMs, head })
    return head
  }

  private async resolveUncached(cwd: string): Promise<Resolution> {
    const real = (await this.realpath(cwd)) ?? this.normalize(cwd)
    const own: Resolution = { mineKey: this.key(real) }
    const checkout = await this.checkoutOf(real)
    if (checkout === null || checkout.isDirectory || checkout.gitdir === null) return own
    // A worktree's admin folder names the common `.git`; a submodule's has no `commondir`.
    const commondir = firstLine(await this.read(this.join(checkout.gitdir, 'commondir')))
    if (commondir === null) return own
    const commonDir = this.absolute(commondir, checkout.gitdir)
    const name = commonDir.slice(commonDir.lastIndexOf(this.sep) + 1)
    if ((this.options.style === 'win32' ? name.toLowerCase() : name) !== '.git') return own
    // The main working tree must be a folder that owns a `.git` DIRECTORY (not a bare repository).
    const mainTree = this.parent(commonDir)
    const treeStat = await this.options.fs.stat(mainTree)
    const gitStat = await this.options.fs.stat(this.join(mainTree, '.git'))
    if (treeStat === null || !treeStat.isDirectory || gitStat === null || !gitStat.isDirectory) {
      return own
    }
    const mineKey = this.key((await this.realpath(mainTree)) ?? mainTree)
    if (mineKey === own.mineKey) return own
    const head = headOf(await this.read(this.join(checkout.gitdir, 'HEAD')))
    return {
      mineKey,
      workplace: head.kind === 'branch' ? { path: real, branch: head.name } : { path: real }
    }
  }

  private async checkoutOf(real: string): Promise<Checkout | null> {
    let folder = real
    for (;;) {
      const stat = await this.options.fs.stat(this.join(folder, '.git'))
      if (stat !== null) {
        if (stat.isDirectory)
          return { folder, gitdir: this.join(folder, '.git'), isDirectory: true }
        const line = firstLine(await this.read(this.join(folder, '.git')))
        const pointer = line === null ? undefined : /^gitdir:\s*(.+)$/.exec(line)?.[1]?.trim()
        const gitdir =
          pointer === undefined || pointer === '' ? null : this.absolute(pointer, folder)
        return { folder, gitdir, isDirectory: false }
      }
      const parent = this.parent(folder)
      if (parent === folder) return null
      folder = parent
    }
  }

  /** Links followed; null when nothing is there. */
  private async realpath(path: string): Promise<string | null> {
    let real = this.normalize(path)
    for (const [link, target] of this.links) {
      if (real === link || real.startsWith(link + this.sep)) {
        real = target + real.slice(link.length)
        break
      }
    }
    return (await this.options.fs.stat(real)) === null ? null : real
  }

  private async read(path: string): Promise<string | null> {
    try {
      return await this.options.fs.readTextHead(path, 4096)
    } catch {
      return null
    }
  }

  private get sep(): string {
    return this.options.style === 'win32' ? '\\' : '/'
  }

  private isAbsolute(path: string): boolean {
    return this.options.style === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/')
  }

  private normalize(path: string): string {
    const unified = this.options.style === 'win32' ? path.replace(/\//g, '\\') : path
    const collapsed = unified.split(this.sep).filter((part, i) => i === 0 || part !== '')
    const joined = collapsed.join(this.sep)
    return collapsed.length === 1 ? joined + this.sep : joined
  }

  private key(real: string): string {
    return this.options.caseFold ? real.toLowerCase() : real
  }

  private join(...parts: string[]): string {
    return this.normalize(parts.join(this.sep))
  }

  private parent(path: string): string {
    const at = path.lastIndexOf(this.sep)
    const root = at === path.indexOf(this.sep)
    return root ? path.slice(0, at + 1) : path.slice(0, at)
  }

  /** A pointer made absolute against the folder that named it, `.` and `..` resolved. */
  private absolute(pointer: string, from: string): string {
    const base = this.isAbsolute(pointer) ? pointer : `${from}${this.sep}${pointer}`
    const out: string[] = []
    for (const part of this.normalize(base).split(this.sep)) {
      if (part === '.') continue
      if (part === '..') {
        if (out.length > 1) out.pop()
        continue
      }
      out.push(part)
    }
    return this.normalize(out.join(this.sep))
  }
}

function firstLine(text: string | null): string | null {
  const line = text?.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line === '' ? null : line
}

function headOf(text: string | null): GitHead {
  const line = firstLine(text) ?? ''
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(line)?.[1]?.trim()
  if (branch !== undefined && branch !== '') return { kind: 'branch', name: branch }
  return /^[0-9a-f]{40,}$/i.test(line) ? { kind: 'detached', shortSha: line.slice(0, 7) } : NO_HEAD
}
