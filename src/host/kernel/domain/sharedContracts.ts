// Owner types that the ADR-009 D3 driver contract names, defined once in the kernel so that every
// module may import them (05 §2.2, revised 2026-09-30): suppliers re-exports them, and asking,
// conversation, launching and ledger import the same type, because they all import suppliers and
// suppliers cannot import them back (R4, R5). Each type is copied field for field from its owner,
// named in its comment; on any difference the owner wins and this copy is a defect.
// Pure types: no I/O, no clock read (05 §2.2, R1).
import type { DwarfId } from './values'

/** `<adapterId>:<streamId>:<eventId>` (06 §0.1; ADR-006 item 2, INV-90). */
export type SourceKey = string

// ---------- ADR-010 item 5 ----------

/**
 * Owner: ADR-010 item 5. `'ask-closed'`: the ask closed (answered elsewhere, cancelled, session
 * ended) while this answer was being handed over: the record shows ✕ with this reason and NO card
 * comes back (PO #91).
 */
export type AnswerRefusalReason =
  'channel-rejected' | 'invalid-answer' | 'channel-unavailable' | 'ask-closed'

/** Owner: ADR-010 item 5 (AQ-09): the one answer-outcome type; drivers return it unchanged. */
export type AnswerOutcome =
  | { kind: 'accepted' } // handed over; ask closes answered-in-app; its "Answers:" record shows ✓
  | { kind: 'not-open' } // stale (ask already closed): no row, nothing rendered (PO #28)
  | { kind: 'refused'; reason: AnswerRefusalReason }

// ---------- ADR-021 item 1 ----------

/** Owner: ADR-021 item 1. */
export type TurnEndKind = 'concluded' | 'capped' | 'errored' | 'interrupted'

/** Owner: ADR-021 item 1: the payload of ADR-009's `DriverEvent` `turn.ended`. */
export interface TurnEnded {
  dwarfId: DwarfId
  turnKey: string // provider turn id, or sourceKey of the ending record
  kind: TurnEndKind
  at: number // provider's own timestamp when present
  reliability: 'reliable' | 'inferred'
  cancelledFromApp: boolean // true when DwarfAI sent the interrupt (Stop/cancel)
  detail?: string // provider's own word, for the outcome tooltip (US-MSG-012)
}

// ---------- ADR-020 item 1 ----------

/** Owner: ADR-020 item 1 (D1): the five launch failure causes, exactly. */
export type LaunchFailureCause =
  | 'not-installed' // 1: binary/adapter not found before spawn
  | 'exited-at-once' // 2: ended or errored within EARLY_FAILURE_WINDOW_MS of spawn
  | 'could-not-start' // 3: found, but spawn/handshake refused (shim, EACCES/EPERM/EINVAL, parser refusal, handshake timeout)
  | 'jev-unreachable' // 4: Jev fell back, retry can change it, nothing went out
  | 'jev-could-not-choose' // 5: Jev fell back, retry cannot change it, nothing went out

// ---------- ADR-006 item 4 ----------

/** Owner: ADR-006 item 4. */
export type Fidelity = 0 /* unknown */ | 1 /* transcript-approx */ | 2 /* driver-native */

/** Owner: ADR-006 item 4. */
export interface UsageObservation {
  sourceKey: string // ADR-006 item 2
  unitKey: string // the provider's smallest accounted unit, identical across paths
  dwarfId: string
  fidelity: Fidelity
  tokens: {
    inputNet: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
  }
  sealed: boolean // the unit's final record (item 6)
  providerTime: number | null // when the provider produced it
  observedAt: number
}

// ---------- 06 §0.2 (asking) ----------

/** Owner: 06 §0.2. */
export interface QuestionStep {
  text: string
  options: string[]
  allowsFreeText: true
}

/** Owner: 06 §0.2. */
export interface QuestionPayload {
  steps: QuestionStep[]
}

/** Owner: 06 §0.2. */
export interface PermissionPayload {
  toolName: string
  requestText: string
}

/** Owner: 06 §0.2. */
export type QuestionAnswers = { step: number; option?: string; freeText?: string }[]
