// The `InstallResolver` double (16 §4.4 as amended, ISSUE-146): a table of the CLIs a test says
// are installed, by binary name, with what the real resolver would answer for each: the resolved
// target, its version and how it was found. A quarantined install is answered as quarantined
// (ADR-009 D5: treated as not installed); the double starts no process at all, so nothing is ever
// spawned through it. An optional delay on the injected Scheduler
// models a slow detection for the 500 ms budget. Passes runInstallResolverContract.
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { InstallResolver, ResolvedInstall } from '../installResolver'

/** One installed CLI as the double holds it. */
export interface FakeInstall {
  /** The resolved target the real resolver would answer (a shim's target, never the shim). */
  path: string
  version?: string
  /** Default `path`, or `login-shell-path` for a `loginShellOnly` install. */
  resolvedVia?: 'path' | 'package-manager-dir' | 'login-shell-path'
  /** Quarantined by the OS: answered as quarantined, never spawned (ADR-009 D5, HR R2). */
  quarantined?: boolean
  /** Visible only on the login shell's PATH: answered by the retry, which runs only on a miss. */
  loginShellOnly?: boolean
}

export interface FakeInstallResolverOptions {
  /** Needed only for `delayMs`: the answer arrives when this scheduler reaches the delay. */
  scheduler?: Scheduler
}

export class FakeInstallResolver implements InstallResolver {
  /** Every `resolve` call, its binaries copied, in order. */
  readonly calls: (readonly string[])[] = []
  /** How many times the login-shell PATH was read: only when nothing else was found. */
  loginShellReads = 0
  /** The double never starts a process; kept for the contract's "never spawned" assertions. */
  readonly spawned: readonly string[] = []
  /** Every later answer arrives this many ms after the call (needs `scheduler`). */
  delayMs = 0

  private readonly installs = new Map<string, FakeInstall>()

  constructor(private readonly options: FakeInstallResolverOptions = {}) {}

  install(binary: string, install: FakeInstall): void {
    this.installs.set(binary, { ...install })
  }

  uninstall(binary: string): void {
    this.installs.delete(binary)
  }

  async resolve(binaries: readonly string[]): Promise<ResolvedInstall | null> {
    this.calls.push([...binaries])
    if (this.delayMs > 0) await this.wait(this.delayMs)
    const answer = this.lookup(binaries, false)
    if (answer !== null && !('quarantined' in answer)) return answer
    this.loginShellReads += 1
    return this.lookup(binaries, true) ?? answer
  }

  /** The first usable install; a quarantined one is the answer only when no other is usable. */
  private lookup(binaries: readonly string[], loginShell: boolean): ResolvedInstall | null {
    let quarantined: ResolvedInstall | null = null
    for (const binary of binaries) {
      const install = this.installs.get(binary)
      if (install === undefined) continue
      if ((install.loginShellOnly === true) !== loginShell) continue
      if (install.quarantined === true) {
        quarantined ??= { path: install.path, quarantined: true }
        continue
      }
      const resolvedVia = install.resolvedVia ?? (loginShell ? 'login-shell-path' : 'path')
      return install.version === undefined
        ? { path: install.path, resolvedVia }
        : { path: install.path, version: install.version, resolvedVia }
    }
    return quarantined
  }

  private wait(ms: number): Promise<void> {
    const scheduler = this.options.scheduler
    if (scheduler === undefined) {
      throw new Error('FakeInstallResolver: delayMs needs a scheduler')
    }
    return new Promise((resolve) => scheduler.after(ms, resolve))
  }
}
