// The emission table of ADR-011 item 5 (HO-17 `ResolveEmission`): what a reported question or
// permission becomes, from the session's capabilities as data, never from a provider name (R12).
// Pure: no I/O, no clock read (05 §2.2, R1).
//
// - A launched session answers in the app only when its effective `permission` is `interactive`,
//   its effective `question` is not `none` for a question, the request came on an answer channel
//   and a permission offers `allow_once` (OQ-42 B). Anything else is `auto-denied` at once: Deny for
//   a permission, the explicit decline for a question (ADR-011 item 3, ADR-010 item 12; 07 S6.03).
// - An observed session first needs a trusted signal for the ask's kind (`observedPermission` /
//   `observedQuestion`, 15 §2.5): without one the request is not an ask at all, and the dwarf keeps
//   `working` (07 S1.17, OQ-35 A). A detected ask the app cannot answer is `channel-none`: the dwarf
//   is `asking` with only "Jump to terminal" (07 S6.02, INV-76).
// - A degradation only ever narrows: an interactive decision the session cannot honour becomes
//   Deny (`degradedFrom: 'ask'`); nothing is ever weakened to Allow.
//
// The session's fields are ADR-009 D2's `permission`, `question`, `observedPermission` and
// `observedQuestion`, read here structurally because a domain file cannot import suppliers (R1);
// `ports/sessionCapabilities.ts` checks at compile time that the owner's types still fit them.
import type { AskChannel, AskKind } from './ask'
import { hasAllowOnce, type PermissionOptionFlags } from './permissionOptions'

/** The reported request, as suppliers' `AskInput` (15 §1.2) carries it. */
export type EmissionInput =
  | {
      readonly kind: 'permission'
      readonly channel: AskChannel
      readonly options: PermissionOptionFlags
    }
  | { readonly kind: 'question'; readonly channel: AskChannel }

/** The session the request came from: who started it and its effective capabilities. */
export interface EmissionSession {
  /** `launched`: the app started the session; `observed`: it only reads it. */
  readonly origin: 'launched' | 'observed'
  readonly permission: 'interactive' | 'policy-only' | 'none'
  readonly question: 'form' | 'options' | 'none'
  readonly observedPermission: 'detected' | 'none'
  readonly observedQuestion: 'detected' | 'none'
}

/** What the broker does with the request (ADR-011 item 5). */
export type Emission =
  | { readonly kind: 'card' }
  | {
      readonly kind: 'auto-denied'
      /** Deny for a permission, the explicit decline for a question (ADR-009 D3). */
      readonly answer: 'deny' | 'decline'
      readonly degradedFrom: 'ask'
    }
  | { readonly kind: 'channel-none' }
  | { readonly kind: 'not-an-ask' }

/**
 * The text of the one ordinary chat line an auto-denied request leaves (ADR-011 item 3). Its copy
 * is design's (open item O-12, `13` FM-071/FM-072 K1) and not written yet: until it is, the line
 * carries the marker, never invented text (25-AGENTS §8.1).
 */
export const AUTO_DENIED_LINE_TEXT = '⟦COPY NEEDED: K1 auto-denied request chat line⟧'

/** ADR-011 item 5: the emission of `input` in `session`. */
export function resolveEmission(input: EmissionInput, session: EmissionSession): Emission {
  if (session.origin === 'observed') {
    if (!detects(session, input.kind)) return { kind: 'not-an-ask' }
    return answerable(input, session) ? { kind: 'card' } : { kind: 'channel-none' }
  }
  if (answerable(input, session)) return { kind: 'card' }
  return {
    kind: 'auto-denied',
    answer: input.kind === 'permission' ? 'deny' : 'decline',
    degradedFrom: 'ask'
  }
}

/** A trusted signal reveals that an observed session waits on the person for this kind (15 §2.5). */
function detects(session: EmissionSession, kind: AskKind): boolean {
  const detection = kind === 'permission' ? session.observedPermission : session.observedQuestion
  return detection === 'detected'
}

/** The app can answer this request from a card, with Allow meaning only this once (INV-73). */
function answerable(input: EmissionInput, session: EmissionSession): boolean {
  if (input.channel === 'none' || session.permission !== 'interactive') return false
  return input.kind === 'permission' ? hasAllowOnce(input.options) : session.question !== 'none'
}
