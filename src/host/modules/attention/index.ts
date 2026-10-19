// The attention module (05 §3.11): ADR-018's level-3 policy. Cut 1 serves `onFact`,
// `presenceChanged` and `preferencesChanged` (ISSUE-109), the withdrawal `onFactEnded`, the
// carry-over and the 24-hour sweep (ISSUE-110), the Reset-metrics step (ISSUE-118), the
// `Level3Sink`, the standing notifications sent again to an attaching notifier and the click
// counter (ISSUE-112), and the tray notifier supervisor, machine 12C (ISSUE-115). It imports no other module: its one edge, to preferences,
// is the `AttentionSettings` bridge composed by `host/wiring`, and its Reset step reaches the saga
// structurally (05 §1.3, R4).
import type { DwarfId, HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { AttentionResetStep } from './adapters/sqlite/AttentionResetStep'
import { AttentionPolicy, type AttentionInputs } from './application/attentionPolicy'
import {
  NotifierSupervisor,
  type NotifierSupervisorDeps,
  type UiClientConnection
} from './application/notifierSupervisor'
import { sweepWithdrawnKeys } from './application/sweep'
import type { NotifierLauncherState } from './domain/notifierPresence'
import type { Level3TitleFormatter } from './domain/decideLevel3'
import type { AttentionEvent } from './domain/events'
import type { AttentionLedger } from './ports/attentionLedger'
import type { AttentionSettings } from './ports/attentionSettings'
import type { Level3Sink } from './ports/level3Sink'

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
export type { Level3Sink } from './ports/level3Sink'
export type { NotifierLauncher } from './ports/notifierLauncher'
export { TRAY_RESPAWN_DELAY_MS, type NotifierLauncherState } from './domain/notifierPresence'
export type { NotifierSupervisorDeps, UiClientConnection } from './application/notifierSupervisor'

export interface AttentionDeps {
  /** The bridge to the Host preference `systemNotificationsOn` (05 §3.11). */
  settings: AttentionSettings
  /** The emitted and suppressed keys (16 §4.11). */
  ledger: AttentionLedger
  /** The Host's transaction runner (16 §2.2). */
  transactions: TransactionRunner
  /** Where the module publishes its events after commit (16 §2.3). */
  bus: DomainEventBus<AttentionEvent>
  /** Frames to the `notifier` connection only (16 §4.11; adapter `TransportLevel3Sink`). */
  sink: Level3Sink
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
  /** A `notifier` connection attached: every standing notification is sent again (14 §2.3). */
  notifierAttached(): void
  /** The `attention.clicked` diagnostics counter (ADR-018 item 6; 19 §10, in memory only). */
  clicks(): number
}

/**
 * The attention step of the Reset-metrics saga (ADR-023; 09 §7.2): the shape of the preferences
 * module's `ResetDbStep` (16 §4.12), stated here so attention imports nothing from preferences
 * (05 §1.3, R4). It joins the saga's one `db` transaction.
 */
export interface AttentionResetDbStep {
  readonly name: string
  reset(tx: TransactionRunner): void
}

/** `name: 'attention'`; registered with the saga by host/wiring/resetParticipants.ts. */
export function createAttentionResetStep(deps: {
  db: SqliteDatabase
  scope: TransactionScope
}): AttentionResetDbStep {
  return new AttentionResetStep(deps)
}

/**
 * Machine 12C (07 §12C; ADR-018 item 5): fed with every client that attaches or detaches (the
 * connection registry, wired by ISSUE-119), it starts the app `--background` through
 * `NotifierLauncher` when no `ui` or `notifier` client is left. Its `drawPending` is the module's
 * `notifierAttached` (S12.C03).
 */
export interface NotifierPresenceInputs {
  clientAttached(client: UiClientConnection): void
  clientDetached(client: UiClientConnection): void
  state(): NotifierLauncherState
}

export function createNotifierSupervisor(deps: NotifierSupervisorDeps): NotifierPresenceInputs {
  return new NotifierSupervisor(deps)
}

/** The module over its driven ports; the adapters are composed by `host/main.ts` (ISSUE-119). */
export function createAttention(deps: AttentionDeps): Attention {
  const policy = new AttentionPolicy(deps)
  return {
    inputs: policy,
    sweep: () => sweepWithdrawnKeys(deps),
    dropCarryOver: (dwarfId) => policy.dropCarryOver(dwarfId),
    notifierAttached: () => policy.notifierAttached(),
    clicks: () => policy.clicks()
  }
}
