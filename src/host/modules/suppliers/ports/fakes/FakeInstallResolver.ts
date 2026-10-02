// The `InstallResolver` double (16 §4.4): a table of the CLIs a test says are installed, by binary
// name, with what the real resolver would answer for each: the resolved target and its version. A
// quarantined install is never answered (ADR-009 D5: treated as not installed); the double starts no
// process at all, so nothing is ever spawned through it. An optional delay on the injected Scheduler
// models a slow detection for the 500 ms budget. Passes runInstallResolverContract.
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { InstallResolver } from '../installResolver'

/** One installed CLI as the double holds it. */
export interface FakeInstall {
  /** The resolved target the real resolver would answer (a shim's target, never the shim). */
  path: string
  version?: string
  /** Quarantined by the OS: resolved but never answered and never spawned (ADR-009 D5, HR R2). */
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

  async resolve(binaries: readonly string[]): Promise<{ path: string; version?: string } | null> {
    this.calls.push([...binaries])
    if (this.delayMs > 0) await this.wait(this.delayMs)
    const answer = this.lookup(binaries, false)
    if (answer !== null) return answer
    this.loginShellReads += 1
    return this.lookup(binaries, true)
  }

  private lookup(
    binaries: readonly string[],
    loginShell: boolean
  ): { path: string; version?: string } | null {
    for (const binary of binaries) {
      const install = this.installs.get(binary)
      if (install === undefined || install.quarantined === true) continue
      if ((install.loginShellOnly === true) !== loginShell) continue
      return install.version === undefined
        ? { path: install.path }
        : { path: install.path, version: install.version }
    }
    return null
  }

  private wait(ms: number): Promise<void> {
    const scheduler = this.options.scheduler
    if (scheduler === undefined) {
      throw new Error('FakeInstallResolver: delayMs needs a scheduler')
    }
    return new Promise((resolve) => scheduler.after(ms, resolve))
  }
}
