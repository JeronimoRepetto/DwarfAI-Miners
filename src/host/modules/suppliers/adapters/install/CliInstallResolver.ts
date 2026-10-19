// `CliInstallResolver` (16 §4.4): the one resolver behind every driver's `detect()` (ADR-009 D5;
// 15 §2.4). Search order, per binary name:
//
//   1. the file its override variable names, when set and present (`DWARFAI_AGY_PATH`, AMENDMENT-13);
//   2. PATH × PATHEXT;
//   3. the known package-manager directories (npm, pnpm, Volta, bun, Scoop shims, WinGet links);
//   4. `~/.local/bin`;
//   5. only when 1–4 found nothing: the directories the login shell's PATH adds (macOS, Linux).
//
// Each candidate is resolved to its target: a `.cmd` / `.bat` shim is read for the program or the
// `.js` entry it runs, a Scoop shim for its `.shim` file's `path`, a link (WinGet, npm, Homebrew) by
// its realpath; never through a shell (ADR-029 row 8). A link to a native program of another name
// is a dispatcher that reads its own name (a Volta shim) and is kept as the link. Targets are
// de-duplicated by realpath. A target the OS quarantined is skipped and never spawned (HR R2); the
// first other target is the answer, with how it was found (`resolvedVia`) and the first line of its
// own `--version`; when only a quarantined target exists it is the answer, marked `quarantined`
// (16 §4.4 as amended, ISSUE-146). The version is read through the kernel
// `ProcessControl`, an argv array, `PROBE_TIMEOUT_MS`; R17). Nothing is ever taken from a path
// DwarfAI ships (C-02): the search covers the person's own directories only.
//
// The OS is an explicit `Platform` (R18 keeps the one read of the running OS in the composition).
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { ProcessControl, SpawnedProcess } from '../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { InstallResolver, ResolvedInstall } from '../../ports/installResolver'
import {
  envValue,
  executableNames,
  localBinDir,
  overridePath,
  packageManagerDirs,
  pathDirs,
  pathModule,
  probeEnv,
  type DirKind,
  type HostEnv,
  type Platform,
  type SearchDir
} from './searchDirs'
import { PROBE_TIMEOUT_MS } from '../../application/probe'
import { batchShimTarget, scoopShimTarget } from './shims'

// 15 §0: the bound on a CLI's `--version` probe (and on the resolver's other reads). One constant
// for the resolver and the capability probe, owned by the probe use case (ISSUE-147).
export { PROBE_TIMEOUT_MS }

/** Marks the login shell's PATH in its output, so whatever its profile prints is ignored. */
export const LOGIN_SHELL_PATH_MARK = '__DWARFAI_PATH__'

/** A shim is a few hundred bytes; nothing past this is read (the found tree's bound). */
const SHIM_READ_BYTES = 8 * 1024

/** A version line longer than this is not a version line. */
const VERSION_MAX_CHARS = 200

const XATTR = '/usr/bin/xattr'
const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'

export interface CliInstallResolverDeps {
  readonly platform: Platform
  /** The Host's own environment (never handed whole to a child: `probeEnv`). */
  readonly env: HostEnv
  readonly home: string
  readonly fs: Pick<FileSystem, 'stat' | 'readTextHead'>
  /** The OS realpath: links followed to the end; null when nothing is there. */
  realpath(path: string): Promise<string | null>
  readonly processControl: ProcessControl
  readonly scheduler: Scheduler
}

/** A candidate's resolved form: what to answer, and how to ask it for its version. */
interface Target {
  path: string
  /** The program to spawn for `--version`, and the argv ahead of it (node and a `.js` entry). */
  run: { executable: string; args: string[] } | null
}

/** One search: the targets already checked, and the first quarantined one met on the way. */
interface Search {
  seen: Set<string>
  quarantined: string | null
}

export class CliInstallResolver implements InstallResolver {
  private readonly path: ReturnType<typeof pathModule>

  constructor(private readonly deps: CliInstallResolverDeps) {
    this.path = pathModule(deps.platform)
  }

  async resolve(binaries: readonly string[]): Promise<ResolvedInstall | null> {
    const search: Search = { seen: new Set(), quarantined: null }
    const found =
      (await this.firstTarget(binaries, this.searchDirs(), search)) ??
      (await this.firstTarget(binaries, await this.loginShellDirs(), search, false))
    if (found === null) {
      // Only a quarantined file was found: answered as such, never spawned (16 §4.4 as amended).
      return search.quarantined === null ? null : { path: search.quarantined, quarantined: true }
    }
    const { target, resolvedVia } = found
    const version = target.run === null ? null : await this.readVersion(target.run)
    return version === null
      ? { path: target.path, resolvedVia }
      : { path: target.path, version, resolvedVia }
  }

  /** Steps 2–4 of the search order, de-duplicated, in order. */
  private searchDirs(): SearchDir[] {
    const { env, home, platform } = this.deps
    const dirs: SearchDir[] = [
      ...pathDirs(envValue(env, 'PATH', platform), platform).map((dir): SearchDir => ({
        dir,
        kind: 'path'
      })),
      ...packageManagerDirs(env, home, platform),
      localBinDir(home, platform)
    ]
    const unique = new Set<string>()
    return dirs.filter((entry) => {
      const key = this.dirKey(entry.dir)
      if (unique.has(key)) return false
      unique.add(key)
      return true
    })
  }

  private async firstTarget(
    binaries: readonly string[],
    dirs: readonly SearchDir[],
    search: Search,
    withOverride = true
  ): Promise<{ target: Target; resolvedVia: DirKind } | null> {
    const { env, platform } = this.deps
    for (const binary of binaries) {
      const candidates: { at: string; kind: DirKind }[] = []
      // The override names the person's own file directly: it counts as found on their path.
      const override = withOverride ? overridePath(binary, env, platform) : null
      if (override !== null) candidates.push({ at: override, kind: 'path' })
      for (const { dir, kind } of dirs) {
        for (const name of executableNames(binary, env, platform)) {
          candidates.push({ at: this.path.join(dir, name), kind })
        }
      }
      for (const candidate of candidates) {
        const target = await this.usable(binary, candidate.at, search)
        if (target !== null) return { target, resolvedVia: candidate.kind }
      }
    }
    return null
  }

  /**
   * The candidate's target when it exists, is not a duplicate and is not quarantined; else null.
   * A quarantined target is remembered in `search` (the answer when nothing else is usable).
   */
  private async usable(binary: string, candidate: string, search: Search): Promise<Target | null> {
    try {
      const stat = await this.deps.fs.stat(candidate)
      if (stat === null || stat.isDirectory) return null
      const target = await this.targetOf(binary, candidate)
      if (target === null) return null
      const key = this.dirKey(target.path)
      if (search.seen.has(key)) return null
      search.seen.add(key)
      if (await this.isQuarantined(target.path)) {
        search.quarantined ??= target.path
        return null
      }
      return target
    } catch {
      return null // an unreadable candidate is not a CLI; the search goes on
    }
  }

  private async targetOf(binary: string, candidate: string): Promise<Target | null> {
    const { platform } = this.deps
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
      const shim = batchShimTarget(
        candidate,
        await this.deps.fs.readTextHead(candidate, SHIM_READ_BYTES)
      )
      if (shim === null) return null
      if (shim.kind === 'program') return this.programTarget(binary, shim.program)
      const entry = await this.deps.realpath(shim.entry)
      if (entry === null) return null
      const node = await this.nodeFor(candidate)
      return { path: entry, run: node === null ? null : { executable: node, args: [entry] } }
    }
    if (platform === 'win32' && /\.exe$/i.test(candidate)) {
      const scoop = candidate.replace(/\.exe$/i, '.shim')
      if ((await this.deps.fs.stat(scoop)) !== null) {
        const program = scoopShimTarget(await this.deps.fs.readTextHead(scoop, SHIM_READ_BYTES))
        return program === null ? null : this.programTarget(binary, program)
      }
    }
    return this.programTarget(binary, candidate)
  }

  /**
   * A program's realpath, unless the link leads to a native program of another name: that one
   * dispatches on the name it was started by (a Volta shim), so the link itself is the program.
   */
  private async programTarget(binary: string, program: string): Promise<Target | null> {
    const real = await this.deps.realpath(program)
    if (real === null) return null
    const script = /\.(c|m)?js$/i.test(real)
    const stem = (at: string): string =>
      this.path
        .basename(at)
        .replace(/\.(exe|com|cmd|bat)$/i, '')
        .toLowerCase()
    const dispatcher = !script && real !== program && stem(real) !== stem(binary)
    const path = dispatcher ? program : real
    if (script && this.deps.platform === 'win32') {
      const node = await this.nodeFor(program)
      return { path, run: node === null ? null : { executable: node, args: [path] } }
    }
    return { path, run: { executable: path, args: [] } }
  }

  /** The node a Windows shim runs its entry with: the `node.exe` beside it, else PATH's `node`. */
  private async nodeFor(shimPath: string): Promise<string | null> {
    const beside = this.path.join(this.path.dirname(shimPath), 'node.exe')
    if ((await this.deps.fs.stat(beside)) !== null) return beside
    const { env, platform } = this.deps
    for (const dir of pathDirs(envValue(env, 'PATH', platform), platform)) {
      const node = this.path.join(dir, 'node.exe')
      const stat = await this.deps.fs.stat(node)
      if (stat !== null && !stat.isDirectory) return node
    }
    return null
  }

  /** macOS Gatekeeper's attribute (HR R2): read with `xattr`, the file itself is never run. */
  private async isQuarantined(path: string): Promise<boolean> {
    if (this.deps.platform !== 'darwin') return false
    const read = await this.run(XATTR, ['-p', QUARANTINE_ATTRIBUTE, path])
    return read !== null && read.code === 0
  }

  /** The directories only the login shell's PATH has (macOS, Linux; never Windows). */
  private async loginShellDirs(): Promise<SearchDir[]> {
    const { env, platform } = this.deps
    if (platform === 'win32') return []
    const declared = envValue(env, 'SHELL', platform)
    const shell = declared !== undefined && declared.startsWith('/') ? declared : '/bin/sh'
    // The shell is the program; the one command it runs prints PATH between marks.
    const script = `printf '%s%s%s' '${LOGIN_SHELL_PATH_MARK}' "$PATH" '${LOGIN_SHELL_PATH_MARK}'`
    const read = await this.run(shell, ['-i', '-l', '-c', script])
    if (read === null) return []
    const marked = read.stdout.split(LOGIN_SHELL_PATH_MARK)
    if (marked.length < 3) return []
    const known = new Set(this.searchDirs().map((entry) => this.dirKey(entry.dir)))
    return pathDirs(marked[1], platform)
      .filter((dir) => !known.has(this.dirKey(dir)))
      .map((dir) => ({ dir, kind: 'login-shell-path' }))
  }

  private async readVersion(run: { executable: string; args: string[] }): Promise<string | null> {
    const read = await this.run(run.executable, [...run.args, '--version'])
    if (read === null) return null
    const line = read.stdout
      .split(/\r?\n/)
      .map((text) => text.trim())
      .find((text) => text !== '')
    return line === undefined || line.length > VERSION_MAX_CHARS ? null : line
  }

  /**
   * Runs one program with an argv array and the allowlisted environment, bounded by
   * PROBE_TIMEOUT_MS; a program still running then is ended by identity. Null when it could not
   * start or did not finish in time.
   */
  private async run(
    executable: string,
    args: string[]
  ): Promise<{ code: number | null; stdout: string } | null> {
    const { platform, env, home } = this.deps
    let child: SpawnedProcess
    try {
      child = this.deps.processControl.spawn({
        executable,
        args,
        cwd: home,
        env: probeEnv(env, platform),
        processGroup: 'own',
        stdio: 'pipe'
      })
    } catch {
      return null
    }
    child.identity.catch(() => undefined) // a process gone before its identity was read
    child.stdin?.end()
    child.stderr?.resume()
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < SHIM_READ_BYTES) stdout += chunk
    })
    const finished = Promise.all([
      child.exited,
      new Promise<void>((resolve) => {
        if (child.stdout === null) resolve()
        else child.stdout.once('end', () => resolve()).once('close', () => resolve())
      })
    ]).then(
      ([exit]) => ({ code: exit.code, stdout }),
      () => null
    )
    let timer: { cancel(): void } | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = this.deps.scheduler.after(PROBE_TIMEOUT_MS, () => resolve('late'))
    })
    const outcome = await Promise.race([finished, late])
    timer?.cancel()
    if (outcome !== 'late') return outcome
    void child.identity.then(
      (identity) => this.deps.processControl.killTree(identity, { graceMs: 0, group: 'owned' }),
      () => undefined
    )
    return null
  }

  private dirKey(path: string): string {
    const normalized = this.path.normalize(path)
    return this.deps.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
}
