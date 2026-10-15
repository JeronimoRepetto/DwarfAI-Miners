// The recording spawn of the conformance harness (15 §6 "fake spawner", AMENDMENT-10 A10-09): a
// `ProcessControl` over the kernel's `FakeProcessControl`, which records every `SpawnSpec`
// (`executable`, `args`, `cwd`, `env`; `shell: false` is the adapter's, never in the spec) and mints
// the identity. What the spawned process does is scripted per spawn: hand back a fixture
// transport's stdio, fail to start (`ENOENT`, `EACCES`, `EPERM`, `EINVAL`: the same rejected
// `identity` / `exited` pair the real adapter returns), or write some output and exit after a
// delay on the FakeScheduler. It never starts or signals a real process.
import { PassThrough } from 'node:stream'
import { FakeProcessControl, type RecordedSpawn } from '../../../kernel/fakes/FakeProcessControl'
import type { Clock } from '../../../kernel/ports/clock'
import type {
  EndOutcome,
  ProcessControl,
  ProcessIdentity,
  SpawnSpec,
  SpawnedProcess
} from '../../../kernel/ports/processControl'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { FixtureTransport } from './fixtureTransport'

export type SpawnErrorCode = 'ENOENT' | 'EACCES' | 'EPERM' | 'EINVAL'

/** What one spawn does. */
export type SpawnScript =
  | { readonly kind: 'fixture'; readonly transport: FixtureTransport }
  | { readonly kind: 'fail'; readonly code: SpawnErrorCode }
  | {
      readonly kind: 'exit'
      readonly afterMs: number
      readonly code: number | null
      readonly stdout?: string
      readonly stderr?: string
    }

/** Decides each spawn from its spec; called once per spawn, in order. */
export type SpawnDecision = (spec: SpawnSpec) => SpawnScript

export interface RecordingSpawnOptions {
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly decide: SpawnDecision
}

export class RecordingSpawn implements ProcessControl {
  readonly fake: FakeProcessControl
  /** The order of what happened: `spawn <pid>`, `spawn-failed <code>` (the harness adds its own marks). */
  readonly log: string[] = []
  private killTrees = 0

  constructor(private readonly options: RecordingSpawnOptions) {
    this.fake = new FakeProcessControl({ clock: options.clock })
  }

  /** Every spawn attempt so far, failed ones included, in order. */
  get spawns(): readonly RecordedSpawn[] {
    return this.fake.spawns
  }

  /** How many times anything asked to kill a tree (a driver never may: 15 §4, ADR-014). */
  get killTreeCalls(): number {
    return this.killTrees
  }

  spawn(spec: SpawnSpec): SpawnedProcess {
    const script = this.options.decide(spec)
    const spawned = this.fake.spawn(spec)
    if (script.kind === 'fail') return this.failed(spawned, script.code)
    void spawned.identity.then((identity) => this.log.push(`spawn ${identity.pid}`))
    if (script.kind === 'fixture') {
      const { transport } = script
      void spawned.identity.then((identity) => {
        transport.onEnd(() => this.fake.exit(identity.pid, { code: null, signal: null }))
        transport.start()
      })
      return {
        identity: spawned.identity,
        stdin: transport.stdin,
        stdout: transport.stdout,
        stderr: transport.stderr,
        exited: spawned.exited
      }
    }
    const stdout = spawned.stdout as PassThrough | null
    const stderr = spawned.stderr as PassThrough | null
    void spawned.identity.then((identity) => {
      this.options.scheduler.after(script.afterMs, () => {
        stdout?.end(script.stdout ?? '')
        stderr?.end(script.stderr ?? '')
        this.fake.exit(identity.pid, { code: script.code, signal: null })
      })
    })
    return spawned
  }

  /** The real adapter's shape for a spawn that never started (NodeProcessControl `notStarted`). */
  private failed(spawned: SpawnedProcess, code: SpawnErrorCode): SpawnedProcess {
    this.log.push(`spawn-failed ${code}`)
    void spawned.identity.then((identity) => this.fake.exit(identity.pid))
    const error = Object.assign(new Error(`spawn ${code}`), { code })
    const rejected = Promise.reject(error)
    rejected.catch(() => {})
    return { identity: rejected, stdin: null, stdout: null, stderr: null, exited: rejected }
  }

  probe(pid: number): Promise<ProcessIdentity | 'absent' | 'unknown'> {
    return this.fake.probe(pid)
  }

  isRunning(pid: number): 'running' | 'absent' | 'unknown' {
    return this.fake.isRunning(pid)
  }

  listProcesses(filter: { stems: readonly string[] }): ReturnType<ProcessControl['listProcesses']> {
    return this.fake.listProcesses(filter)
  }

  sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
    return this.fake.sameProcess(a, b)
  }

  killTree(
    target: ProcessIdentity,
    opts: { graceMs: number; group: 'owned' | 'foreign' }
  ): Promise<EndOutcome> {
    this.killTrees += 1
    return this.fake.killTree(target, opts)
  }

  currentBootIdentity(): ReturnType<ProcessControl['currentBootIdentity']> {
    return this.fake.currentBootIdentity()
  }
}
