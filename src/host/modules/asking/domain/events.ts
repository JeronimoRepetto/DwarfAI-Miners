// The asking module's domain events of the answer paths (08 §0, §2.7), over the kernel envelope
// (08 §1.2). Each is published after the transaction that wrote its rows committed (16 §2.3).
// `AskOpened` and `AskStepChanged` join with the issues that publish them (later: ISSUE-129,
// ISSUE-130, ISSUE-140). Pure types (05 §2.2, R1).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { AnswerRefusalReason } from '../../../kernel/domain/sharedContracts'
import type { AskId, DwarfId } from '../../../kernel/domain/values'
import type { AskState } from './ask'

/** 08 §0 `AskClosed`: the ask reached a closing state (terminal, once). */
export type AskClosed = DomainEvent<
  'AskClosed',
  { askId: AskId; dwarfId: DwarfId; reason: AskState }
>

/** 08 §0 `AskReopened`: a refused answer put the ask back to `open`; its card comes back. */
export type AskReopened = DomainEvent<
  'AskReopened',
  { askId: AskId; dwarfId: DwarfId; refusal: AnswerRefusalReason }
>

export type AskingEvent = AskClosed | AskReopened
