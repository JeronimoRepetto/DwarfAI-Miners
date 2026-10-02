// ADR-018's `AttentionPolicy` (05 §3.11; 16 §4.11 row `onFact`): applies the level-3 rule
// (`decideLevel3`, machine 17) to each fact, by state and never by timer (BR-02).
//
// `onFact` decides a new fact inside one transaction: it reads the claimed keys, then claims the key
// as emitted (`markEmitted`) or suppressed (`markSuppressed`, S17.02, S17.08); a gated fact claims
// nothing and waits. After the commit it publishes `AttentionNotified` (16 §2.3), which the sink
// turns into `attention.notify` (later: ISSUE-112). `presenceChanged` keeps each UI client's last
// report, ordered by its `seq`, and re-evaluates the gated facts that are still open (S17.03).
// The withdrawal (`onFactEnded`) and the click counter (`clicked`) join with their issues
// (later: ISSUE-110, ISSUE-112).
import type { EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import {
  nextAttentionKey,
  osNotification,
  unionPresence,
  type AttentionFact,
  type AttentionKeyEvent,
  type AttentionKeyState,
  type Level3Gate,
  type Level3Names,
  type Presence
} from '../domain/decideLevel3'
import type { AttentionEvent } from '../domain/events'
import type { AttentionLedger } from '../ports/attentionLedger'
import type { AttentionSettings } from '../ports/attentionSettings'

/**
 * Driving port (05 §3.11, 16 §4.11): cut 1's members. `onFact` takes the names beside the fact: the
 * wiring route resolves crew's display name and the mine's name at emit time (lead decision
 * 2026-09-30, ISSUE-109), since `attention` has no edge to `crew` or `mines` (05 §1.3).
 */
export interface AttentionInputs {
  onFact(fact: AttentionFact, names: Level3Names): void
  presenceChanged(uiClient: string, presence: Presence | 'detached'): void
}

export interface AttentionPolicyDeps {
  settings: AttentionSettings
  ledger: AttentionLedger
  transactions: TransactionRunner
  bus: DomainEventBus<AttentionEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
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

  constructor(private readonly deps: AttentionPolicyDeps) {}

  onFact(fact: AttentionFact, names: Level3Names): void {
    this.decide({ fact, names }, undefined)
  }

  presenceChanged(uiClient: string, presence: Presence | 'detached'): void {
    if (presence === 'detached') {
      this.reports.delete(uiClient)
    } else {
      const last = this.reports.get(uiClient)
      if (last !== undefined && presence.seq <= last.seq) return // an older report (16 §4.11)
      this.reports.set(uiClient, presence)
    }
    for (const open of [...this.gated.values()]) this.decide(open, 'gated')
  }

  /** One machine-17 step for an open fact: claim the key, then publish after the commit. */
  private decide(open: OpenFact, from: 'gated' | undefined): void {
    const { fact } = open
    const gate: Level3Gate = {
      prefs: { systemNotificationsOn: this.deps.settings.systemNotificationsOn() },
      presence: unionPresence([...this.reports.values()])
    }
    const next = this.deps.transactions.inTransaction((): AttentionKeyState | undefined => {
      const event: AttentionKeyEvent =
        from === undefined
          ? { type: 'fact', fact, gate, emitted: this.deps.ledger.emitted() }
          : { type: 'gate-changed', fact, gate }
      const step = nextAttentionKey(from, event)
      if (!step.ok) return undefined
      if (step.value === 'emitted') this.deps.ledger.markEmitted(fact.key, fact.dwarfId, fact.kind)
      if (step.value === 'suppressed') {
        this.deps.ledger.markSuppressed(fact.key, fact.dwarfId, fact.kind)
      }
      return step.value
    })
    if (next === 'gated') this.gated.set(fact.key, open)
    else this.gated.delete(fact.key)
    if (next === 'emitted') this.publishNotified(open)
  }

  private publishNotified({ fact, names }: OpenFact): void {
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
        notification: osNotification(fact, names)
      }
    })
  }
}
