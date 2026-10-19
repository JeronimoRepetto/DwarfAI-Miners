// ADR-018's `AttentionPolicy` (05 §3.11; 16 §4.11 row `onFact`): applies the level-3 rule
// (`decideLevel3`, machine 17) to each fact, by state and never by timer (BR-02).
//
// `onFact` decides a new fact inside one transaction: it reads the claimed keys, then claims the key
// as emitted (`markEmitted`) or suppressed (`markSuppressed`, S17.02, S17.08); a gated fact claims
// nothing and waits. After the commit it publishes `AttentionNotified` (16 §2.3) and hands the
// notification to the `Level3Sink` (frames to the `notifier` connection only). `presenceChanged` keeps each UI client's last
// report, ordered by its `seq`; it and `preferencesChanged` re-evaluate the gated facts that are
// still open (S17.03). A new ask that finds a carry-over row of its dwarf and kind is the need
// re-raised after a silent resume: it consumes the row in the same transaction, is suppressed and
// is linked to the pre-crash key (07 S6.19, ADR-018 item 3).
//
// `onFactEnded` (16 §4.11 row `onFactEnded`; ADR-018 item 4) withdraws the fact's key and the key
// it replaces in one transaction (`AttentionLedger.withdraw`, which withdraws a key once), drops a
// gated fact, and after the commit publishes one `AttentionWithdrawn` with the keys that left
// (S17.04, S17.05, S17.09), and hands the same keys to the sink. A fact that already ended
// publishes nothing.
//
// The tray notifier connection (ISSUE-112; 14 §2.3 "Notifier scope"; ADR-018 item 5): every emitted
// notification stays standing until its fact ends, delivered or not (`'no-ui'`), and
// `notifierAttached` sends every standing one again, since the notifier has no replay. Whether a
// windowless tray process can draw it on an OS (spike S-018-1) is the drawing side's concern
// (ISSUE-113): the Host sends to the `notifier` connection either way (21 §9). `clicked` is a
// counter only (S17.06): the Host never raises a window (ADR-018 item 6).
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { reRaisedFact } from '../domain/carryOver'
import {
  nextAttentionKey,
  osNotification,
  unionPresence,
  type AttentionFact,
  type AttentionKeyEvent,
  type AttentionKeyState,
  type Level3Gate,
  type Level3Names,
  type Level3TitleFormatter,
  type OsNotification,
  type Presence
} from '../domain/decideLevel3'
import type { AttentionEvent } from '../domain/events'
import type { AttentionLedger } from '../ports/attentionLedger'
import type { AttentionSettings } from '../ports/attentionSettings'
import type { Level3Sink } from '../ports/level3Sink'

/**
 * Driving port (05 §3.11, 16 §4.11 as amended: "Amendment for frozen 16 §4.11 AttentionInputs",
 * owner-approved 2026-10-02, ISSUE-109): cut 1's members.
 * - `onFact` takes the names beside the fact: the wiring route resolves the dwarf's display name
 *   (`customName ?? baseName`, ADR-018 item 9) and the mine's name at emit time (lead decision
 *   2026-09-30), since `attention` has no edge to `crew` or `mines` (05 §1.3).
 * - `preferencesChanged` re-checks the gated facts against the current `AttentionSettings`: the
 *   "preference change opens the gate" of 07 S17.03.
 */
export interface AttentionInputs {
  onFact(fact: AttentionFact, names: Level3Names): void
  onFactEnded(key: string): void
  presenceChanged(uiClient: string, presence: Presence | 'detached'): void
  clicked(key: string): void // attention.clicked, diagnostics counter only
  preferencesChanged(): void
}

export interface AttentionPolicyDeps {
  settings: AttentionSettings
  ledger: AttentionLedger
  transactions: TransactionRunner
  bus: DomainEventBus<AttentionEvent>
  sink: Level3Sink
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
  /** The PO #44 titles from the copy dictionary, injected by the composition side. */
  titles: Level3TitleFormatter
}

interface OpenFact {
  fact: AttentionFact
  names: Level3Names
}

export class AttentionPolicy implements AttentionInputs {
  /** The last report of each attached UI client (ADR-024 D7); its keys are the attached clients. */
  private readonly reports = new Map<string, Presence>()
  /** The open facts machine 17 holds in `gated`, by key. */
  private readonly gated = new Map<string, OpenFact>()
  /** The pre-crash key each decided fact of this Host life replaces (ADR-018 item 3), by key. */
  private readonly replacing = new Map<string, string>()
  /** The emitted notifications whose fact still stands, by key, in emit order (14 §2.3). */
  private readonly standing = new Map<string, OsNotification>()
  private clickCount = 0

  constructor(private readonly deps: AttentionPolicyDeps) {}

  onFact(fact: AttentionFact, names: Level3Names): void {
    this.decide({ fact, names }, undefined)
  }

  onFactEnded(key: string): void {
    const replaced = this.replacing.get(key)
    const withdrawn = this.deps.transactions.inTransaction(() =>
      this.deps.ledger.withdraw(replaced === undefined ? [key] : [key, replaced])
    )
    // A gated fact claimed no key, so the ledger has nothing to withdraw for it (S17.04).
    const keys = this.gated.delete(key) ? [key, ...withdrawn] : [...withdrawn]
    this.replacing.delete(key)
    for (const withdrawnKey of keys) this.standing.delete(withdrawnKey)
    if (keys.length > 0) {
      this.publishWithdrawn(keys)
      this.deps.sink.withdraw(keys)
    }
  }

  /**
   * The dwarf's carry-over rows end: the route of a person-initiated turn or of its departure
   * (09 §7.1; later: ISSUE-120). Not an `AttentionInputs` member.
   */
  dropCarryOver(dwarfId: DwarfId): void {
    this.deps.transactions.inTransaction(() => this.deps.ledger.dropCarryOver(dwarfId))
  }

  presenceChanged(uiClient: string, presence: Presence | 'detached'): void {
    if (presence === 'detached') {
      this.reports.delete(uiClient)
    } else {
      const last = this.reports.get(uiClient)
      if (last !== undefined && presence.seq <= last.seq) return // an older report (16 §4.11)
      this.reports.set(uiClient, presence)
    }
    this.recheckGated()
  }

  preferencesChanged(): void {
    this.recheckGated()
  }

  /** S17.06: a counter only; the UI process reveals the chat, the Host raises nothing (ADR-018 item 6). */
  clicked(_key: string): void {
    this.clickCount += 1
  }

  /** The `attention.clicked` diagnostics counter of this Host life (19 §10: in memory only). */
  clicks(): number {
    return this.clickCount
  }

  /**
   * A `notifier` connection attached (S12.C03; later: ISSUE-119 routes the transport's attach to
   * it). Not an `AttentionInputs` member: every notification whose fact still stands is sent again,
   * because a notification is state and the notifier has no replay (14 §2.3 "Notifier scope").
   */
  notifierAttached(): void {
    for (const notification of [...this.standing.values()]) this.deps.sink.notify(notification)
  }

  /** S17.03, S17.08: re-evaluate every gated fact that is still open against the current gate. */
  private recheckGated(): void {
    for (const open of [...this.gated.values()]) this.decide(open, 'gated')
  }

  /** One machine-17 step for an open fact: claim the key, then publish after the commit. */
  private decide(given: OpenFact, from: 'gated' | undefined): void {
    const gate: Level3Gate = {
      prefs: { systemNotificationsOn: this.deps.settings.systemNotificationsOn() },
      presence: unionPresence([...this.reports.values()])
    }
    const { next, open } = this.deps.transactions.inTransaction(() => {
      if (from === 'gated') {
        return {
          next: this.step(given, from, { type: 'gate-changed', fact: given.fact, gate }),
          open: given
        }
      }
      const emitted = this.deps.ledger.emitted()
      const carried = reRaisedFact(given.fact, this.deps.ledger.carryOver(), emitted)
      if (carried.consumed !== undefined) this.deps.ledger.consumeCarryOver(carried.consumed)
      const decided = { ...given, fact: carried.fact }
      return {
        next: this.step(decided, from, { type: 'fact', fact: decided.fact, gate, emitted }),
        open: decided
      }
    })
    const { fact } = open
    if (next === 'gated') this.gated.set(fact.key, open)
    else this.gated.delete(fact.key)
    if (next !== undefined && fact.replacesKey !== undefined) {
      this.replacing.set(fact.key, fact.replacesKey)
    }
    if (next === 'emitted') this.publishNotified(open)
  }

  /** Inside the decision's transaction: take the transition and claim the key it decides. */
  private step(
    { fact }: OpenFact,
    from: 'gated' | undefined,
    event: AttentionKeyEvent
  ): AttentionKeyState | undefined {
    const step = nextAttentionKey(from, event)
    if (!step.ok) return undefined
    if (step.value === 'emitted') this.deps.ledger.markEmitted(fact.key, fact.dwarfId, fact.kind)
    if (step.value === 'suppressed') {
      this.deps.ledger.markSuppressed(fact.key, fact.dwarfId, fact.kind)
    }
    return step.value
  }

  private publishWithdrawn(keys: string[]): void {
    this.deps.bus.publish({
      type: 'AttentionWithdrawn',
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch,
      payload: { keys }
    })
  }

  /**
   * After the commit: the event (16 §2.3), then the sink. A notification the sink could not deliver
   * (`'no-ui'`) stays standing like a delivered one and is sent when a notifier attaches.
   */
  private publishNotified({ fact, names }: OpenFact): void {
    const notification = osNotification(fact, names, this.deps.titles)
    this.standing.set(fact.key, notification)
    this.deps.bus.publish({
      type: 'AttentionNotified',
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch,
      payload: {
        key: fact.key,
        dwarfId: fact.dwarfId,
        mineId: fact.mineId,
        kind: fact.kind,
        notification
      }
    })
    this.deps.sink.notify(notification)
  }
}
