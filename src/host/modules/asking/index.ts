// The asking module (05 §3.7): one ask broker for questions and permission requests (ADR-010).
// ISSUE-126: its pure domain, the `Ask` aggregate and machine 6 (07 §6), and these public types.
// The broker factory, its persistence and its channels follow (later: ISSUE-127, ISSUE-128).
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
