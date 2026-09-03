import {
  accrue,
  creditMaterial,
  emptyLedger,
  knownMineTotals,
  ledgerTotals,
  mineTotals,
  observationsFrom,
  pruneSessions,
  type ConfirmedTierLookup,
  type LedgerState
} from '../domain/ledger'
import type { MaterialTotals, Mine } from '../domain/types'
import type { LedgerStore } from './ledgerStore'

/**
 * The live vault: the pure ledger state machine plus the small amount of
 * bookkeeping a running app needs around it (see #22).
 *
 * Everything that decides WHAT is credited lives in domain/ledger.ts and is
 * pure. This class only holds the current state, stamps it onto outgoing
 * mines, and decides WHEN to write it down — so the interesting rules stay
 * testable without a clock or a disk, and this stays a thin runner.
 */

/**
 * Minimum gap between writes.
 *
 * The poller ticks every two seconds and can be nudged more often than that.
 * Rewriting the vault on every tick would mean thousands of writes an hour for
 * numbers that change by a few tokens, so writes are throttled and the
 * in-memory state is the source of truth between them. The exposure is bounded
 * by this window and closed on shutdown, which forces a final write.
 */
export const SAVE_INTERVAL_MS = 30_000

export interface MaterialLedgerOptions {
  store: LedgerStore
  /** Where a persistence failure is reported; defaults to swallowing it. */
  onError?: (message: string, error: unknown) => void
}

export class MaterialLedger {
  private readonly store: LedgerStore
  private readonly onError: (message: string, error: unknown) => void
  private ledger: LedgerState = emptyLedger()
  /** True when the in-memory vault holds something not yet on disk. */
  private dirty = false
  private lastSavedAt = Number.NEGATIVE_INFINITY
  /**
   * Serializes writes. The poll loop does not await save(), so a forced write
   * (shutdown) can otherwise start while a throttled one is still in flight —
   * two writers racing on the same sibling temp path, which is precisely what
   * the atomic write exists to prevent.
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: MaterialLedgerOptions) {
    this.store = options.store
    this.onError = options.onError ?? (() => undefined)
  }

  /**
   * Read the persisted vault. A failure leaves the empty starting state rather
   * than propagating: the app must open even when its vault file will not.
   */
  async load(): Promise<void> {
    try {
      this.ledger = await this.store.load()
    } catch (error) {
      this.onError('[ledger] Failed to read the material ledger; starting empty:', error)
      this.ledger = emptyLedger()
    }
  }

  /**
   * Fold one poll into the vault and return the same mines stamped with their
   * persisted breakdown.
   *
   * `confirmedTierOf` says which tier a walk has actually measured for each
   * mine; a mine it has no answer for yet accrues nothing this poll (#41).
   * It has no default on purpose — the caller must say where its tiers come
   * from, because the one thing that looks like a tier and is not one is the
   * placeholder the tier service serves until its first walk finishes.
   *
   * The input mines are never mutated: they belong to the caller's pipeline,
   * and a stamped copy is what goes on the wire.
   */
  observe(mines: readonly Mine[], now: number, confirmedTierOf: ConfirmedTierLookup): Mine[] {
    const before = this.ledger
    this.ledger = accrue(this.ledger, observationsFrom(mines, confirmedTierOf), now)
    // Session marks move on every poll, but a write is only earned by a real
    // change to the totals — otherwise an idle machine would rewrite the file
    // forever for nothing.
    if (this.ledger.mines !== before.mines) this.dirty = true
    return mines.map((mine) => ({ ...mine, materials: mineTotals(this.ledger, mine.id) }))
  }

  /**
   * Credit historical coal for one project. Only the backfill calls this: coal
   * has no mine tier and can never be produced by observe().
   */
  creditCoal(mineId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.ledger = creditMaterial(this.ledger, mineId, 'coal', tokens)
    this.dirty = true
  }

  /** The whole vault, every mine the ledger knows — including crewless ones. */
  totals(): MaterialTotals {
    return ledgerTotals(this.ledger)
  }

  /**
   * This mine's breakdown exactly as persisted, or undefined when the ledger
   * has no row for it — a project browse spans mines with no crew and no
   * history at all (#90), and those must read as absent rather than as a
   * zeroed breakdown invented for a project nobody has ever mined. Unlike
   * observe(), which zero-fills every mine on THIS poll's board by design.
   */
  knownMineTotals(mineId: string): MaterialTotals | undefined {
    return knownMineTotals(this.ledger, mineId)
  }

  /** The exact state a save would write; for the backfill marker and tests. */
  state(): LedgerState {
    return this.ledger
  }

  /**
   * Persist if there is anything to persist and the throttle window has
   * elapsed. `force` skips the window — shutdown uses it so the last poll's
   * material is never lost.
   *
   * A failed write is reported and the state stays dirty, so the next save
   * retries it. Nothing is thrown: this runs inside the poll loop that feeds
   * the panel, and a full disk must not stop the dwarfs from moving.
   */
  async save(now: number, force = false): Promise<void> {
    if (!this.dirty) return
    if (!force && now - this.lastSavedAt < SAVE_INTERVAL_MS) return
    this.queue = this.queue.then(() => this.write(now))
    return this.queue
  }

  private async write(now: number): Promise<void> {
    // Re-checked inside the queue: a write that was already queued may have
    // persisted this exact state while this one waited its turn, and rewriting
    // identical bytes helps nobody.
    if (!this.dirty) return

    // Pruned on the way out rather than on every poll: it is bookkeeping the
    // file cares about, and doing it here keeps the hot path allocation-free.
    const pruned = pruneSessions(this.ledger, now)
    this.ledger = pruned
    try {
      await this.store.save(pruned)
      this.dirty = false
      this.lastSavedAt = now
    } catch (error) {
      this.onError('[ledger] Failed to persist the material ledger; will retry:', error)
    }
  }
}
