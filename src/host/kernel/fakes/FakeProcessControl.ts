// The ProcessControl double (16 §3, 17 §1.4): scripted probe answers ('absent' / 'unknown' /
// an identity per pid) and a recording spawner that keeps executable, argv and env of every spawn
// (the driver conformance harness reads them). It never starts a process. Grows from the legacy
// `worktreePlatformAdapters()` seed, without its `vi.fn` mocks (17 §2.2).
import { PassThrough } from 'node:stream'
import { sameProcess, type ProbeResult, type ProcessIdentity } from '../domain/processIdentity'
import type { Clock } from '../ports/clock'
import type { ProcessProbeAndSpawn, SpawnSpec, SpawnedProcess } from '../ports/processControl'

/** One spawn as the fake received it, copied so later caller mutation cannot rewrite history. */
export interface RecordedSpawn {
  executable: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: string
  processGroup: 'own' | 'inherit'
  stdio: 'pipe' | 'ignore'
}

export interface FakeProcessControlOptions {
  /** The bootId of every identity the fake mints; default `'fake-boot'`. */
  bootId?: string
  /** The start time of a spawned process is `clock.now()`; default a clock stuck at 0. */
  clock?: Clock
  /** The pid of the first spawned process; later spawns count up from it. Default 10 000. */
  firstPid?: number
}

type ExitOutcome = { code: number | null; signal: string | null }

export class FakeProcessControl implements ProcessProbeAndSpawn {
  private readonly answers = new Map<number, ProbeResult>()
  private readonly exits = new Map<number, (outcome: ExitOutcome) => void>()
  private readonly recorded: RecordedSpawn[] = []
  private readonly bootId: string
  private readonly clock: Clock
  private nextPid: number

  constructor(options: FakeProcessControlOptions = {}) {
    this.bootId = options.bootId ?? 'fake-boot'
    this.clock = options.clock ?? { now: () => 0 }
    this.nextPid = options.firstPid ?? 10_000
  }

  /** Every spawn so far, in order. */
  get spawns(): readonly RecordedSpawn[] {
    return this.recorded
  }

  /** What `probe(pid)` answers from now on. An unscripted pid probes as `'absent'`. */
  script(pid: number, answer: ProbeResult): void {
    this.answers.set(pid, answer)
  }

  /** Ends a spawned process: its `exited` resolves with `outcome` and its pid probes as absent. */
  exit(pid: number, outcome: ExitOutcome = { code: 0, signal: null }): void {
    this.answers.set(pid, 'absent')
    const settle = this.exits.get(pid)
    this.exits.delete(pid)
    settle?.(outcome)
  }

  probe(pid: number): Promise<ProcessIdentity | 'absent' | 'unknown'> {
    const answer = this.answers.get(pid) ?? 'absent'
    return Promise.resolve(typeof answer === 'string' ? answer : { ...answer })
  }

  sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
    return sameProcess(a, b)
  }

  spawn(spec: SpawnSpec): SpawnedProcess {
    this.recorded.push({
      executable: spec.executable,
      args: [...spec.args],
      env: { ...spec.env },
      cwd: spec.cwd,
      processGroup: spec.processGroup,
      stdio: spec.stdio
    })
    const identity: ProcessIdentity = {
      pid: this.nextPid,
      processStartTimeMs: this.clock.now(),
      bootId: this.bootId
    }
    this.nextPid += 1
    this.answers.set(identity.pid, identity)
    const exited = new Promise<ExitOutcome>((resolve) => this.exits.set(identity.pid, resolve))
    const piped = spec.stdio === 'pipe'
    return {
      identity: Promise.resolve({ ...identity }),
      stdin: piped ? new PassThrough() : null,
      stdout: piped ? new PassThrough() : null,
      stderr: piped ? new PassThrough() : null,
      exited
    }
  }
}
