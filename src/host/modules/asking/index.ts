// The asking module (05 §3.7): one ask broker for questions and permission requests (ADR-010).
// ISSUE-126: its pure domain, the `Ask` aggregate and machine 6 (07 §6), and these public types.
// ISSUE-127: the AskRepository port (16 §4.7); its SQLite adapter and the closed-asks sweep are
// composed by the Host (R6). The broker factory and its channels follow (later: ISSUE-128).
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
