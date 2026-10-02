// The attention module (05 §3.11): ADR-018's level-3 policy. Cut 1 serves `onFact`,
// `presenceChanged` and `preferencesChanged` (ISSUE-109), the withdrawal `onFactEnded`, the
// carry-over and the 24-hour sweep (ISSUE-110); the sink and the click counter join with
// ISSUE-112. It imports no other module: its one edge, to preferences, is the `AttentionSettings` bridge composed by `host/wiring` (05 §1.3, R4).
import type { DwarfId, HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { AttentionPolicy, type AttentionInputs } from './application/attentionPolicy'
import { sweepWithdrawnKeys } from './application/sweep'
import type { Level3TitleFormatter } from './domain/decideLevel3'
import type { AttentionEvent } from './domain/events'
import type { AttentionLedger } from './ports/attentionLedger'
import type { AttentionSettings } from './ports/attentionSettings'

export type { AttentionInputs }
export type { AttentionEvent, AttentionNotified, AttentionWithdrawn } from './domain/events'
export { carryOverKey, type CarriedKind } from './domain/carryOver'
export {
  decideLevel3,
  turnFinishedFact,
  type AttentionFact,
  type AttentionKind,
  type Level3Decision,
  type Level3Names,
  type Level3TitleFormatter,
  type OsNotification,
  type Presence
} from './domain/decideLevel3'
export type { AttentionLedger } from './ports/attentionLedger'
export type { AttentionSettings } from './ports/attentionSettings'

export interface AttentionDeps {
  /** The bridge to the Host preference `systemNotificationsOn` (05 §3.11). */
  settings: AttentionSettings
  /** The emitted and suppressed keys (16 §4.11). */
  ledger: AttentionLedger
  /** The Host's transaction runner (16 §2.2). */
  transactions: TransactionRunner
  /** Where the module publishes its events after commit (16 §2.3). */
  bus: DomainEventBus<AttentionEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  /**
   * The PO #44 titles, looked up in the copy dictionary by the composition side (owner rule
   * 2026-10-02; module code never imports contracts, R9). Wired by ISSUE-120.
   */
  titles: Level3TitleFormatter
}

export interface Attention {
  inputs: AttentionInputs
  /** 09 §7.1: deletes the keys withdrawn more than 24 h ago; returns how many. */
  sweep(): number
  /** 09 §7.1: a person-initiated turn or the departure ends the dwarf's carry-over (ISSUE-120). */
  dropCarryOver(dwarfId: DwarfId): void
}

/** The module over its driven ports; the adapters are composed by `host/main.ts` (ISSUE-119). */
export function createAttention(deps: AttentionDeps): Attention {
  const policy = new AttentionPolicy(deps)
  return {
    inputs: policy,
    sweep: () => sweepWithdrawnKeys(deps),
    dropCarryOver: (dwarfId) => policy.dropCarryOver(dwarfId)
  }
}
