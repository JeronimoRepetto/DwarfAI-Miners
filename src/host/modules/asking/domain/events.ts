// The asking module's domain events (08 §0, §2.7), over the kernel envelope (08 §1.2). Each is
// published after the transaction that wrote its rows committed (16 §2.3). ISSUE-130 declares
// `AskOpened` and `AskStepChanged` for their frame projections (transport/frames/askFrames.ts);
// the broker publishes them with the issues that build `open` and `setStep` (later: ISSUE-129,
// ISSUE-140). Pure types (05 §2.2, R1).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { AnswerRefusalReason } from '../../../kernel/domain/sharedContracts'
import type { AskId, DwarfId } from '../../../kernel/domain/values'
import type { AskRecord, AskState } from './ask'
import type { LateDenyStatusLine } from './attribution'

/** 08 §0 `AskOpened`: a new ask with a card; an `auto-denied` ask never publishes it (08 §2.7). */
export type AskOpened = DomainEvent<'AskOpened', { ask: AskRecord }>

/** 08 §0 `AskStepChanged`: the front ask's `currentStep` changed (OQ-03; 16 §4.7 `setStep`). */
export type AskStepChanged = DomainEvent<'AskStepChanged', { askId: AskId; currentStep: number }>

/**
 * 08 §0 `AskClosed`: the ask reached a closing state (terminal, once).
 *
 * `statusLine` (ISSUE-134, ADR-012 item 3): present only on a Deny closed in the app through a
 * channel whose capability record says `staleAnswerSafe: false` (`domain/attribution.ts`). Package
 * gap: 14's `ask.closed` frame has no field for it, so the transport projection drops it
 * (transport/frames/askFrames.ts) and the card keys today's line (BR-20) off `AskRecord.channel`
 * until the frame carries it.
 */
export type AskClosed = DomainEvent<
  'AskClosed',
  { askId: AskId; dwarfId: DwarfId; reason: AskState; statusLine?: LateDenyStatusLine }
>

/** 08 §0 `AskReopened`: a refused answer put the ask back to `open`; its card comes back. */
export type AskReopened = DomainEvent<
  'AskReopened',
  { askId: AskId; dwarfId: DwarfId; refusal: AnswerRefusalReason }
>

export type AskingEvent = AskOpened | AskStepChanged | AskClosed | AskReopened
