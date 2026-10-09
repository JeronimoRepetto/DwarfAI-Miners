// The asking module (05 §3.7): one ask broker for questions and permission requests (ADR-010).
// ISSUE-126: its pure domain, the `Ask` aggregate and machine 6 (07 §6), and these public types.
// ISSUE-127: the AskRepository port (16 §4.7); its SQLite adapter and the closed-asks sweep are
// composed by the Host (R6).
// ISSUE-128: `createAsking`, the broker's two answer paths (`answerPermission`, `answerQuestion`)
// over the AskRepository, conversation's `AnswerRecords` and the answer channels; the Host composes
// it (later: ISSUE-140).
// ISSUE-139: `createAskingResetStep`, the module's step of the Reset-metrics saga (ADR-023).
// ISSUE-130: the `AskQueries` port and the `AskOpened` / `AskStepChanged` events, for the asks
// frame projections (transport/frames/askFrames.ts).
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { AskingResetStep } from './adapters/sqlite/AskingResetStep'
import { AskAnswerPaths, type AnswerPathsDeps, type AskBroker } from './application/askBroker'

export type { AnswerPathsDeps, AskBroker } from './application/askBroker'
export type { AskQueries, AskView } from './application/askQueries'
export type {
  AskClosed,
  AskingEvent,
  AskOpened,
  AskReopened,
  AskStepChanged
} from './domain/events'
export type { AskAnswerChannel } from './ports/askAnswerChannel'
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
export type {
  AskAnswer,
  AskChannelRef,
  AskRepository,
  AskSettlement,
  SettledAnswer
} from './ports/askRepository'

/** The asking module so far: the broker's two answer paths (16 §4.7). */
export interface Asking {
  answers: Pick<AskBroker, 'answerPermission' | 'answerQuestion'>
}

export function createAsking(deps: AnswerPathsDeps): Asking {
  return { answers: new AskAnswerPaths(deps) }
}

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
