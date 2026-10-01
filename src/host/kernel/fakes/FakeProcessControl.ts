// The ProcessControl double (16 §3, 17 §1.4): scripted probe answers ('absent' / 'unknown' /
// an identity per pid), a recording spawner that keeps executable, argv and env of every spawn
// (the driver conformance harness reads them), scripted process trees for killTree (exits,
// `access-denied`, survivors) and a scripted boot identity (AMENDMENT-3). It never starts or
// signals a real process. Grows from the legacy `worktreePlatformAdapters()` seed, without its
// `vi.fn` mocks (17 §2.2).
import { PassThrough } from 'node:stream'
import {
  matchesRecorded,
  sameProcess,
  type EndOutcome,
  type ProbeResult,
  type ProcessIdentity
} from '../domain/processIdentity'
import type { Clock } from '../ports/clock'
import type { ProcessControl, SpawnSpec, SpawnedProcess } from '../ports/processControl'

/** One spawn as the fake received it, copied so later caller mutation cannot rewrite history. */
export interface RecordedSpawn {
  executable: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: string
  processGroup: 'own' | 'inherit'
  stdio: 'pipe' | 'ignore'
}

/** One signal the fake was asked to send (every attempt, allowed or not). */
export interface FakeSignal {
  pid: number
  signal: 'term' | 'kill'
  scope: 'process' | 'group'
}

/** How a scripted tree reacts to killTree. */
export interface ScriptedTree {
  /** The first signal that ends the root and its descendants; default `'term'`. */
  endsOn?: 'term' | 'kill' | 'never'
  /** `denied`: every signal to the root is refused (ADR-014 item 8). */
  access?: 'denied'
  /** Descendants of the root, leaves last; each probes as its identity until it is ended. */
  descendants?: readonly ProcessIdentity[]
}

export type FakeBootIdentity = {
  bootId: string | 'unknown'
  bootTimeMs: number | 'unknown'
  logonSessionId: string | 'unknown'
}

export interface FakeProcessControlOptions {
  /** The bootId of every identity the fake mints; default `'fake-boot'`. */
  bootId?: string
  /** The start time of a spawned process is `clock.now()`; default a clock stuck at 0. */
  clock?: Clock
  /** The pid of the first spawned process; later spawns count up from it. Default 10 000. */
  firstPid?: number
  /**
   * `failing`: every boot-identity read fails, so `currentBootIdentity()` yields `'unknown'` for
   * each field (AMENDMENT-3 extension of the double). Default `working`.
   */
  bootReads?: 'working' | 'failing'
}

type ExitOutcome = { code: number | null; signal: string | null }

export class FakeProcessControl implements ProcessControl {
  private readonly answers = new Map<number, ProbeResult>()
  private readonly exits = new Map<number, (outcome: ExitOutcome) => void>()
  private readonly trees = new Map<number, ScriptedTree>()
  private readonly recorded: RecordedSpawn[] = []
  private readonly sent: FakeSignal[] = []
  private readonly bootId: string
  private readonly clock: Clock
  private bootIdentity: FakeBootIdentity
  private nextPid: number

  constructor(options: FakeProcessControlOptions = {}) {
    this.bootId = options.bootId ?? 'fake-boot'
    this.clock = options.clock ?? { now: () => 0 }
    this.nextPid = options.firstPid ?? 10_000
    this.bootIdentity =
      options.bootReads === 'failing'
        ? { bootId: 'unknown', bootTimeMs: 'unknown', logonSessionId: 'unknown' }
        : { bootId: this.bootId, bootTimeMs: 0, logonSessionId: 'fake-logon' }
  }

  /** Every spawn so far, in order. */
  get spawns(): readonly RecordedSpawn[] {
    return this.recorded
  }

  /** Every signal killTree tried to send so far, in order. */
  get signals(): readonly FakeSignal[] {
    return this.sent
  }

  /** What `probe(pid)` answers from now on. An unscripted pid probes as `'absent'`. */
  script(pid: number, answer: ProbeResult): void {
    this.answers.set(pid, answer)
  }

  /**
   * Scripts a live tree for killTree: the root and its descendants probe as their identities, and
   * they end on the signal `tree.endsOn` names (default `'term'`).
   */
  scriptTree(root: ProcessIdentity, tree: ScriptedTree = {}): void {
    this.answers.set(root.pid, { ...root })
    for (const descendant of tree.descendants ?? []) {
      this.answers.set(descendant.pid, { ...descendant })
    }
    this.trees.set(root.pid, tree)
  }

  /** What `currentBootIdentity()` answers from now on; each field may be `'unknown'`. */
  scriptBootIdentity(identity: Partial<FakeBootIdentity>): void {
    this.bootIdentity = { ...this.bootIdentity, ...identity }
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

  /**
   * ADR-014 items 2–4 on the scripted tree: a root whose identity no longer matches is ended with
   * nothing signalled, an unreadable one is `no-identity`; `owned` sends one group TERM, `foreign`
   * TERMs the descendants and then the root; the root and every survivor are re-checked before the
   * KILL; `ended` only once the root is gone.
   */
  killTree(
    target: ProcessIdentity,
    opts: { graceMs: number; group: 'owned' | 'foreign' }
  ): Promise<EndOutcome> {
    return Promise.resolve(this.endTree(target, opts.group))
  }

  currentBootIdentity(): Promise<FakeBootIdentity> {
    return Promise.resolve({ ...this.bootIdentity })
  }

  private endTree(target: ProcessIdentity, group: 'owned' | 'foreign'): EndOutcome {
    const probed = this.answers.get(target.pid) ?? 'absent'
    if (probed === 'unknown') return { kind: 'failed', reason: 'no-identity' }
    if (!matchesRecorded(probed, target)) return { kind: 'ended' }
    const tree = this.trees.get(target.pid) ?? {}
    const endsOn = tree.endsOn ?? 'term'
    const descendants = [...(tree.descendants ?? [])].reverse()
    const alive = (identity: ProcessIdentity): boolean =>
      matchesRecorded(this.answers.get(identity.pid) ?? 'absent', identity)
    const send = (pid: number, signal: 'term' | 'kill', scope: 'process' | 'group'): void => {
      this.sent.push({ pid, signal, scope })
    }
    if (group === 'owned') send(target.pid, 'term', 'group')
    else {
      for (const descendant of descendants) send(descendant.pid, 'term', 'process')
      send(target.pid, 'term', 'process')
    }
    if (tree.access === 'denied') return { kind: 'failed', reason: 'access-denied' }
    if (endsOn === 'term') {
      this.endAll(target, descendants, 'SIGTERM')
      return { kind: 'ended' }
    }
    for (const descendant of descendants) {
      if (alive(descendant)) send(descendant.pid, 'kill', 'process')
    }
    if (alive(target)) send(target.pid, 'kill', 'process')
    if (endsOn === 'kill') {
      this.endAll(target, descendants, 'SIGKILL')
      return { kind: 'ended' }
    }
    return { kind: 'failed', reason: 'still-alive' }
  }

  private endAll(
    root: ProcessIdentity,
    descendants: readonly ProcessIdentity[],
    signal: 'SIGTERM' | 'SIGKILL'
  ): void {
    for (const descendant of descendants) this.exit(descendant.pid, { code: null, signal })
    this.exit(root.pid, { code: null, signal })
  }
}
