// The scoring walk of a mine (16 §4.1 `MinesCommands.remeasure`; 05 §3.1; 07 §3 S3.04, S3.08–S3.11,
// S3.15, S3.25): a cancellable scan of the mine's folder by the `SourceWeightScanner` (a worker,
// HR O2), whose weight alone decides the tier through the thresholds read once at Host start
// (06 INV-05, BR-15; never ore). The states are machine 3's (`transition`); this use case runs the
// walk around them:
//
// - `mineCreated` (route of `MineCreated`): every new mine is measured by itself, the configured
//   delay after its creation, through the kernel `Scheduler` (INV-04, PO #47). An observed mine
//   waits `unrecorded` with no tier until then (S3.01), and the walk moves it to `measuring`
//   (S3.08); a declared one is already `measuring` (S3.04) and its walk simply starts. Every walk
//   start publishes `MineMeasurementStarted` (S3.04, S3.08, S3.10, S3.14, S3.21), except the
//   restart of one a boot interrupted (S3.25 holds the state).
// - `remeasure`: an `active` mine goes back to `measuring` with its last tier and weight kept
//   until the walk finishes (S3.10); a `measuring` mine without a walk (one a boot, a Reset or a
//   found-again folder left measuring) gets one. A mine already walking is left alone.
// - The walk's answer: a weight sets the tier and makes the mine `active` (S3.09, `MineMeasured`);
//   a folder the walk cannot read makes it `unenterable` with the reason and the result is
//   discarded (S3.11, `MineBecameUnenterable`), as is a walk that fails.
// - `abort` (removal, S3.15) and `abortAll` (Reset) abort a running walk through its `AbortSignal`
//   and drop a pending automatic one; whatever an aborted walk resolves with is discarded.
// - `resumeAtBoot` (S3.25): no partial walk is persisted, so a mine a previous boot left
//   `measuring` is walked again from scratch, and an `unrecorded` one gets its automatic walk.
//
// Every write is one transaction (16 §2.2) and every event is published after it commits (16
// §2.3). The ledger's crediting of a never-measured mine's sealed units is the route of
// `MineMeasured` (INV-94, later: ISSUE-076). No timer and no clock read of its own: time is the
// injected `Clock` and `Scheduler`.
import type { EventId, FolderPath, HostEpoch, MineId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { MeasurementEvent } from '../domain/events'
import { transition, type Mine, type MineInput } from '../domain/mine'
import type { TierThresholds } from '../domain/tier'
import type { MineRepository } from '../ports/mineRepository'
import type { SourceWeightScanner } from '../ports/sourceWeightScanner'

/** The reason a walk that failed outright gives its mine (16 §4.1: scan failure → unenterable). */
const SCAN_FAILED = 'scan-failed'

export interface MineMeasurementDeps {
  readonly repository: MineRepository
  readonly transactions: TransactionRunner
  readonly scanner: SourceWeightScanner
  readonly scheduler: Scheduler
  readonly clock: Clock
  readonly bus: Pick<DomainEventBus<MeasurementEvent>, 'publish'>
  readonly ids: IdGenerator
  readonly hostEpoch: HostEpoch
  /** Read once at Host start (06 §4.1 `TierThresholds`). */
  readonly thresholds: TierThresholds
  /** How long after `MineCreated` the automatic walk starts (`AppConfig.mineMeasureDelayMs`). */
  readonly automaticWalkDelayMs: number
}

export class MineMeasurement {
  /** The running walk of each mine. */
  private readonly walks = new Map<MineId, AbortController>()
  /** The automatic walk waiting for its delay, per mine. */
  private readonly pending = new Map<MineId, { cancel(): void }>()
  /** Every walk whose answer has not been handled yet, aborted ones included. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly deps: MineMeasurementDeps) {}

  /** The route of `MineCreated`: the automatic walk, `automaticWalkDelayMs` later (S3.08). */
  mineCreated(mineId: MineId): void {
    this.pending.get(mineId)?.cancel()
    const task = this.deps.scheduler.after(this.deps.automaticWalkDelayMs, () => {
      this.pending.delete(mineId)
      this.remeasure(mineId)
    })
    this.pending.set(mineId, task)
  }

  /** `MinesCommands.remeasure`: starts a walk of the mine unless one is running. */
  remeasure(mineId: MineId): void {
    this.start(mineId, { announce: true })
  }

  /** Removal (S3.15): the running walk is aborted and a pending one dropped. */
  abort(mineId: MineId): void {
    this.pending.get(mineId)?.cancel()
    this.pending.delete(mineId)
    this.walks.get(mineId)?.abort()
    this.walks.delete(mineId)
  }

  /** Reset metrics: every walk is aborted, every pending one dropped. */
  abortAll(): void {
    for (const mineId of [...this.pending.keys(), ...this.walks.keys()]) this.abort(mineId)
  }

  /** Host boot (S3.25): measuring mines are walked from scratch; unrecorded ones are scheduled. */
  resumeAtBoot(): void {
    for (const mine of this.deps.repository.query({ sortBy: 'name', direction: 'asc' })) {
      if (mine.state === 'unrecorded') this.mineCreated(mine.id)
      // S3.25 holds the state: the walk restarts with no transition and no new event.
      else if (mine.state === 'measuring') this.start(mine.id, { announce: false })
    }
  }

  /** Resolves once every started walk has been answered (tests; the Host's drain). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  /** Starts a walk unless one is running; `announce` publishes `MineMeasurementStarted`. */
  private start(mineId: MineId, opts: { announce: boolean }): void {
    if (this.walks.has(mineId)) return
    const mine = this.deps.repository.byId(mineId)
    if (mine === null) return
    const input = startInput(mine)
    if (input === 'none') return
    const now = this.deps.clock.now()
    let started: Mine = mine
    if (input !== 'walk-only') {
      const step = transition(mine, input, now)
      if (step.mine === null || step.transition === null) return
      started = step.mine
      this.deps.transactions.inTransaction(() => this.deps.repository.save(started))
    }
    if (opts.announce) this.publish('MineMeasurementStarted', { mineId, startedAt: now })
    this.walk(started)
  }

  private walk(mine: Mine): void {
    const controller = new AbortController()
    this.walks.set(mine.id, controller)
    const answered = this.deps.scanner
      .measure(mine.path as string as FolderPath, controller.signal)
      .catch(() => ({ unenterable: SCAN_FAILED }))
      .then((result) => {
        if (controller.signal.aborted || this.walks.get(mine.id) !== controller) return
        this.walks.delete(mine.id)
        this.settle(mine.id, result)
      })
      .finally(() => this.inFlight.delete(answered))
    this.inFlight.add(answered)
  }

  /** The walk's answer, applied to the mine as stored now; nothing if it left `measuring`. */
  private settle(mineId: MineId, result: { bytes: number } | { unenterable: string }): void {
    const now = this.deps.clock.now()
    const input: MineInput =
      'bytes' in result
        ? {
            type: 'measured',
            sourceWeight: { bytes: result.bytes },
            thresholds: this.deps.thresholds
          }
        : { type: 'walk-found-unenterable', reason: result.unenterable }
    const settled = this.deps.transactions.inTransaction(() => {
      const mine = this.deps.repository.byId(mineId)
      if (mine === null) return null
      const step = transition(mine, input, now)
      if (step.mine === null || step.transition === null) return null
      this.deps.repository.save(step.mine)
      return step.mine
    })
    if (settled === null) return
    if (settled.state === 'active' && settled.tier !== null && settled.sourceWeight !== null) {
      this.publish('MineMeasured', {
        mineId,
        tier: settled.tier,
        sourceWeight: settled.sourceWeight,
        measuredAt: now
      })
    } else if (settled.state === 'unenterable' && settled.unenterableReason !== undefined) {
      this.publish('MineBecameUnenterable', { mineId, reason: settled.unenterableReason })
    }
  }

  private publish<K extends MeasurementEvent['type']>(
    type: K,
    payload: Extract<MeasurementEvent, { type: K }>['payload']
  ): void {
    this.deps.bus.publish({
      type,
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch,
      payload
    } as MeasurementEvent)
  }
}

/** What starting a walk does to a mine in its state; `none` = no walk at all. */
function startInput(mine: Mine): MineInput | 'walk-only' | 'none' {
  switch (mine.state) {
    case 'unrecorded':
      return { type: 'measurement-due' }
    case 'active':
      return { type: 'remeasure-requested' }
    case 'measuring':
      return 'walk-only'
    default:
      // A removed mine is not measured; an unenterable one waits for `checkFolder` (S3.13, S3.14).
      return 'none'
  }
}
