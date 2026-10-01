// The in-memory requestId table of the transport (ADR-003 item 6, frozen; 14 §1.6; 16 §2.4): at
// most one effect per `requestId`.
//
// - in flight: a repeat joins the first call and shares its one promise (FM-034, T-17);
// - settled: for 10 min after settlement a repeat gets the first outcome verbatim, with no second
//   effect; the window starts at settlement, on the injected Clock;
// - forgotten: a Scheduler task sweeps the entry at 10 min, and a lookup on the clock never answers
//   from an entry 10 min old or more, so the expiry holds even when a sweep runs late.
//
// The table lives only in this object: it ends with the Host process and is never persisted. The
// commands whose repeat must stay single-effect across a Host restart (`conversation.send`,
// `asking.answer*`) key the `requestId` durably in their own tables (later: ISSUE-166 owns
// `messages.request_id`, ISSUE-128 owns the `ask_answers` PK).
import type { Clock } from '../../kernel/ports/clock'
import type { Scheduler } from '../../kernel/ports/scheduler'

/** 14 §1.6 / ADR-003 item 6: a settled outcome is replayed for 10 min. */
export const DEDUPE_TTL_MS = 600_000

export interface RequestTableDeps {
  clock: Clock
  /** Sweeps settled entries at the end of their window (memory); the clock check stays authoritative. */
  scheduler?: Scheduler
}

export interface Admission<T> {
  /** True when the outcome comes from an earlier call with the same requestId (no effect ran). */
  repeat: boolean
  outcome: Promise<T>
}

type Entry<T> =
  | { state: 'in-flight'; promise: Promise<T> }
  | { state: 'settled'; promise: Promise<T>; at: number; sweep?: { cancel(): void } }

export class RequestTable<T> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(private readonly deps: RequestTableDeps) {}

  /**
   * Runs `effect` once for `requestId`, or answers a repeat from the table. An effect that rejects
   * is not remembered: callers fold their failures into the outcome they want replayed.
   */
  run(requestId: string, effect: () => Promise<T>): Admission<T> {
    const known = this.lookup(requestId)
    if (known !== undefined) return { repeat: true, outcome: known.promise }

    const promise = effect()
    const entry: Entry<T> = { state: 'in-flight', promise }
    this.entries.set(requestId, entry)
    promise.then(
      () => this.settle(requestId, entry),
      () => this.forget(requestId, entry)
    )
    return { repeat: false, outcome: promise }
  }

  /** How many requestIds the table holds right now (in flight or settled). */
  size(): number {
    return this.entries.size
  }

  private lookup(requestId: string): Entry<T> | undefined {
    const entry = this.entries.get(requestId)
    if (entry?.state === 'settled' && this.deps.clock.now() - entry.at >= DEDUPE_TTL_MS) {
      this.forget(requestId, entry)
      return undefined
    }
    return entry
  }

  private settle(requestId: string, inFlight: Entry<T>): void {
    if (this.entries.get(requestId) !== inFlight) return
    const settled: Entry<T> = {
      state: 'settled',
      promise: inFlight.promise,
      at: this.deps.clock.now()
    }
    settled.sweep = this.deps.scheduler?.after(DEDUPE_TTL_MS, () => this.forget(requestId, settled))
    this.entries.set(requestId, settled)
  }

  private forget(requestId: string, entry: Entry<T>): void {
    if (this.entries.get(requestId) !== entry) return
    this.entries.delete(requestId)
    if (entry.state === 'settled') entry.sweep?.cancel()
  }
}
