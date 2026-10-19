// The `Ask` aggregate (06 §10.1) = ADR-010 item 5's `AskRecord`. Pure types: no I/O, no clock read
// (05 §2.2, R1).
//
// The ADR-010 item 5 block is split by the layer rules, never restated: `AskKind`, `AskState` and
// `AskRecord` are copied below; `AnswerRefusalReason` and `AnswerOutcome` are the kernel's single
// definition (05 §2.2: an owner type that a module importing suppliers owns is defined once in
// `host/kernel/domain/`), re-exported here; `AskBroker` names suppliers' `AskInput`, which a domain
// file cannot import (R1), so its copy is `application/askBroker.ts`.
import type {
  AnswerOutcome,
  AnswerRefusalReason,
  PermissionPayload,
  QuestionPayload
} from '../../../kernel/domain/sharedContracts'

export type { AnswerOutcome, AnswerRefusalReason }

// verbatim: ADR-010 item 5 (`AskKind`, `AskState`, `AskRecord`, byte-for-byte with the list indentation removed; `prettier-ignore` keeps its alignment)
// prettier-ignore
export type AskKind = 'question' | 'permission'
// prettier-ignore
export type AskState =
  | 'open' | 'answering'
  | 'answered-in-app' | 'answered-elsewhere' | 'cancelled' | 'closed-by-death' | 'auto-denied'
// prettier-ignore
export interface AskRecord {
  id: string; dwarfId: string; kind: AskKind
  channel: 'driver' | 'hook-keystroke' | 'hook-decision' | 'http' | 'none'
                                                 // how an answer is delivered; 'none' = observed ask of a provider with
                                                 // no answer channel: no card, only "Jump to terminal" (ADR-011 item 4,
                                                 // ADR-031 D5, ADR-032 D4); every submit returns not-open
  providerRequestId: string
  payload: QuestionPayload | PermissionPayload   // text needed to redraw the card (question steps/options; tool summary)
  currentStep: number                            // reported by the UI; partial picks are NOT stored (OQ-03)
  state: AskState
  reannounce: boolean                            // false only when set by the Host recovery pass (ADR-015 item 5)
  openedAt: number; closedAt?: number
}
// end verbatim: ADR-010 item 5

/** The `Ask` aggregate root (06 §10.1): exactly ADR-010's `AskRecord`. */
export type Ask = AskRecord

/** How an answer reaches the provider (ADR-010 item 5 `AskRecord.channel`). */
export type AskChannel = AskRecord['channel']

/** The states an ask never leaves (07 §6: `answered-in-app` … `auto-denied`). */
export type AskTerminalState = Exclude<AskState, 'open' | 'answering'>

const TERMINAL_STATES: ReadonlySet<AskState> = new Set<AskState>([
  'answered-in-app',
  'answered-elsewhere',
  'cancelled',
  'closed-by-death',
  'auto-denied'
])

/** True for a state machine 6 never leaves. */
export function isTerminal(state: AskState): state is AskTerminalState {
  return TERMINAL_STATES.has(state)
}

/**
 * The only time bound of the ask domain (ADR-010 item 8, INV-74): handing an answer to a channel
 * gives up after 30 s with `refused: 'channel-unavailable'`. An ask itself never times out.
 */
export const ANSWER_HANDOVER_TIMEOUT_MS = 30_000
