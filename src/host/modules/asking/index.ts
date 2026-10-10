// The asking module (05 §3.7): one ask broker for questions and permission requests (ADR-010).
// ISSUE-126: its pure domain, the `Ask` aggregate and machine 6 (07 §6), and these public types.
// ISSUE-127: the AskRepository port (16 §4.7); its SQLite adapter and the closed-asks sweep are
// composed by the Host (R6).
// ISSUE-128: `createAsking`, the broker's two answer paths (`answerPermission`, `answerQuestion`)
// over the AskRepository, conversation's `AnswerRecords` and the answer channels; the Host composes
// it (later: ISSUE-140).
// ISSUE-132: `createAskOpening`, the broker's `open` with ADR-011's capability-based emission over
// the `SessionCapabilities` port; the Host binds that port to suppliers' capability data and
// composes it (later: ISSUE-140).
// ISSUE-139: `createAskingResetStep`, the module's step of the Reset-metrics saga (ADR-023).
// ISSUE-130: the `AskQueries` port and the `AskOpened` / `AskStepChanged` events, for the asks
// frame projections (transport/frames/askFrames.ts); `createAskQueries`, the read model behind the
// snapshot's `asks` section (transport/snapshot/asksSection.ts) over `AskRepository.live` (owner
// amendment L).
// ISSUE-129: `createAskStep`, the broker's `setStep` (S6.04, INV-75), which B-M32 serves
// (transport/methods/askingSetStep.ts); the Host composes it (later: ISSUE-140).
// ISSUE-134: the broker's external resolutions (`Asking.resolutions`, with ADR-010 item 10's
// keystroke attribution) and the observed-Claude keystroke channel's adapters
// (`adapters/observedClaude/`: the channel, the prompt registry, the key map, the transcript tail),
// which host/wiring imports directly (R6); wiring/routes/observedClaudeAsks.ts feeds them.
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { AskingResetStep } from './adapters/sqlite/AskingResetStep'
import {
  AskReadModel,
  type AskReadModelDeps,
  type AskSnapshotQueries
} from './application/askQueries'
import {
  AskAnswerPaths,
  AskOpenPath,
  AskStepPath,
  type AnswerPathsDeps,
  type AskBroker,
  type OpenPathDeps,
  type StepPathDeps
} from './application/askBroker'

export type { AnswerPathsDeps, AskBroker } from './application/askBroker'
export type {
  AskQueries,
  AskReadModelDeps,
  AsksSnapshot,
  AskSnapshotQueries,
  AskView,
  NeedsYouEntry
} from './application/askQueries'
export type {
  AskClosed,
  AskingEvent,
  AskOpened,
  AskReopened,
  AskStepChanged
} from './domain/events'
export type { AskAnswerChannel } from './ports/askAnswerChannel'
export type { OpenPathDeps, StepPathDeps } from './application/askBroker'
export type { AskCapabilities, AskSession, SessionCapabilities } from './ports/sessionCapabilities'
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

/**
 * The asking module so far: the broker's two answer paths and its external resolutions (16 §4.7),
 * one instance, so a resolution sees the answer in flight (S6.21) and the keystroke injections it
 * attributes (S6.12, ISSUE-134).
 */
export interface Asking {
  answers: Pick<AskBroker, 'answerPermission' | 'answerQuestion'>
  resolutions: Pick<AskBroker, 'resolveExternally'>
}

export function createAsking(deps: AnswerPathsDeps): Asking {
  const paths = new AskAnswerPaths(deps)
  return { answers: paths, resolutions: paths }
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

/** The broker's `open` (16 §4.7 row `open`; ADR-011 item 5), composed by the Host (ISSUE-140). */
export function createAskOpening(deps: OpenPathDeps): Pick<AskBroker, 'open'> {
  return new AskOpenPath(deps)
}

/** The `AskQueries` read model with the `asks` section's snapshot read (ISSUE-130). */
export function createAskQueries(deps: AskReadModelDeps): AskSnapshotQueries {
  return new AskReadModel(deps)
}

/** The broker's `setStep` (16 §4.7 row `setStep`; S6.04), composed by the Host (ISSUE-140). */
export function createAskStep(deps: StepPathDeps): Pick<AskBroker, 'setStep'> {
  return new AskStepPath(deps)
}
