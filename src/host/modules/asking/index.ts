// The asking module (05 §3.7): one ask broker for questions and permission requests (ADR-010).
// ISSUE-126: its pure domain, the `Ask` aggregate and machine 6 (07 §6), and these public types.
// ISSUE-127: the AskRepository port (16 §4.7); its SQLite adapter and the closed-asks sweep are
// composed by the Host (R6). The broker factory and its channels follow (later: ISSUE-128).
// ISSUE-139: `createAskingResetStep`, the module's step of the Reset-metrics saga (ADR-023).
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { AskingResetStep } from './adapters/sqlite/AskingResetStep'

export type { AskBroker } from './application/askBroker'
export type {
  AnswerOutcome,
  AnswerRefusalReason,
  Ask,
  AskChannel,
  AskKind,
  AskRecord,
  AskState
} from './domain/ask'
export type { PermissionDecision } from './domain/permissionOptions'
export type { AskChannelRef, AskRepository, AskSettlement } from './ports/askRepository'

/** Structurally the preferences module's `ResetDbStep` (16 §4.12); asking never imports it. */
export interface AskingResetDbStep {
  readonly name: string
  reset(tx: TransactionRunner): void
}

/** `name: 'asking'`; registered with the saga by host/wiring/resetParticipants.ts (ISSUE-139). */
export function createAskingResetStep(deps: {
  db: SqliteDatabase
  scope: TransactionScope
}): AskingResetDbStep {
  return new AskingResetStep(deps)
}
