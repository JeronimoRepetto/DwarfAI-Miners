// A `ProcessControl` double for the resolver (17 §2.2 `Stub<Provider>Cli`): every spawn is recorded
// by the kernel's FakeProcessControl, and a scripted program answers on stdout and exits, the way a
// CLI's `--version`, the login shell's PATH read or `xattr` would. An unscripted program exits 127
// with no output, as a missing command does; a `hang` program never answers until it is killed.
import type { Readable } from 'node:stream'
import type { PassThrough } from 'node:stream'
import { FakeProcessControl, type RecordedSpawn } from '../../../kernel/fakes/FakeProcessControl'
import type {
  EndOutcome,
  ProcessControl,
  ProcessIdentity,
  SpawnSpec,
  SpawnedProcess
} from '../../../kernel/ports/processControl'

/** What a scripted program does when it runs. */
export type ScriptedRun = { stdout: string; code?: number } | 'hang'

/** Decides a run from the spawn; `undefined` = not scripted (exit 127). */
export type RunScript = (spec: SpawnSpec) => ScriptedRun | undefined

export class StubCliProcessControl implements ProcessControl {
  readonly fake = new FakeProcessControl()
  private readonly scripts: RunScript[] = []

  /** Every spawn so far, in order. */
  get spawns(): readonly RecordedSpawn[] {
    return this.fake.spawns
  }

  /** Adds a script; the latest script that answers decides the run (a test overrides a machine). */
  script(run: RunScript): void {
    this.scripts.push(run)
  }

  probe(pid: number): Promise<ProcessIdentity | 'absent' | 'unknown'> {
    return this.fake.probe(pid)
  }

  sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
    return this.fake.sameProcess(a, b)
  }

  spawn(spec: SpawnSpec): SpawnedProcess {
    const spawned = this.fake.spawn(spec)
    const run = this.decide(spec)
    if (run !== 'hang') {
      void spawned.identity.then((identity) => {
        const stdout = spawned.stdout as (Readable & PassThrough) | null
        if (stdout !== null) stdout.end(run.stdout)
        spawned.stderr?.resume()
        this.fake.exit(identity.pid, { code: run.code ?? 0, signal: null })
      })
    }
    return spawned
  }

  killTree(
    target: ProcessIdentity,
    opts: { graceMs: number; group: 'owned' | 'foreign' }
  ): Promise<EndOutcome> {
    return this.fake.killTree(target, opts)
  }

  currentBootIdentity(): ReturnType<ProcessControl['currentBootIdentity']> {
    return this.fake.currentBootIdentity()
  }

  private decide(spec: SpawnSpec): ScriptedRun {
    for (const script of [...this.scripts].reverse()) {
      const run = script(spec)
      if (run !== undefined) return run
    }
    return { stdout: '', code: 127 }
  }
}
