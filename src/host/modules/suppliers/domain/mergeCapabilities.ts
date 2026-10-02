// ADR-009 D2's merge table (ceiling × negotiated → effective) and 15 §2.1's multi-source rule,
// field by field and never with an object spread: a spread would let a source raise a value.
//
// - boolean: ceiling AND negotiated;
// - ordered enum (lowest first): the lower of the two;
// - unordered enum: the ceiling lists the allowed values (the type holds one, so the allowed value
//   is the ceiling's own); the negotiated value when allowed, else the field's fail-closed value;
// - an omitted negotiated field yields the lowest or fail-closed value (ADR-009 D2).
//
// `combineLowest` combines several negotiation sources (protocol handshake, runtime probe, the
// answer-channel gate) with the same rule before the merge, so a probe or a gate only lowers a
// value (15 §2.1, review R5B-08). Pure: no I/O, no clock read (05 §2.2, R1).
import type { IntegrationState } from '../../../kernel/domain/values'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from './capabilities'

/** What one negotiation source reports; an omitted field is not reported. */
export type NegotiatedCapabilities = Partial<ProviderCapabilities>

type Caps = ProviderCapabilities
type Usage = Caps['usage']

const PERMISSION = ['none', 'policy-only', 'interactive'] as const
const QUESTION = ['none', 'options', 'form'] as const
const TURN_END = ['none', 'reliable'] as const
const REACTION_EVIDENCE = ['none', 'transcript-match', 'turn-id'] as const
const SUBAGENTS = ['none', 'transcript', 'events'] as const
const DETECTED = ['none', 'detected'] as const
const FIDELITY = [0, 1, 2] as const

/** The lower of two values of an ordered enum; a value outside the order counts as the lowest. */
function lower<T>(order: readonly T[], a: T, b: T): T {
  const rank = (value: T): number => Math.max(order.indexOf(value), 0)
  return order[Math.min(rank(a), rank(b))] as T
}

function both(a: boolean | undefined, b: boolean | undefined): boolean {
  return a === true && b === true
}

function orderedOf<T>(order: readonly T[], ceiling: T, negotiated: T | undefined): T {
  return negotiated === undefined ? (order[0] as T) : lower(order, ceiling, negotiated)
}

function allowedOr<T>(ceiling: T, negotiated: T | undefined, failClosed: T): T {
  return negotiated !== undefined && negotiated === ceiling ? negotiated : failClosed
}

/** The effective capabilities: ADR-009 D2's table applied to every field. */
export function merge(ceiling: Caps, negotiated: NegotiatedCapabilities): Caps {
  const n = negotiated
  const closed = FAIL_CLOSED_CAPABILITIES
  return {
    launch: both(ceiling.launch, n.launch),
    observe: both(ceiling.observe, n.observe),
    sendTurn: both(ceiling.sendTurn, n.sendTurn),
    interrupt: both(ceiling.interrupt, n.interrupt),
    permission: orderedOf(PERMISSION, ceiling.permission, n.permission),
    question: orderedOf(QUESTION, ceiling.question, n.question),
    answeredElsewhere: both(ceiling.answeredElsewhere, n.answeredElsewhere),
    staleAnswerSafe: both(ceiling.staleAnswerSafe, n.staleAnswerSafe),
    resume: allowedOr(ceiling.resume, n.resume, closed.resume),
    adopt: both(ceiling.adopt, n.adopt),
    turnEnd: orderedOf(TURN_END, ceiling.turnEnd, n.turnEnd),
    reactionEvidence: orderedOf(REACTION_EVIDENCE, ceiling.reactionEvidence, n.reactionEvidence),
    subagents: orderedOf(SUBAGENTS, ceiling.subagents, n.subagents),
    usage: {
      fidelity: orderedOf(FIDELITY, ceiling.usage.fidelity, n.usage?.fidelity),
      rateLimits: both(ceiling.usage.rateLimits, n.usage?.rateLimits)
    },
    mcpInjection: allowedOr(ceiling.mcpInjection, n.mcpInjection, closed.mcpInjection),
    console: allowedOr(ceiling.console, n.console, closed.console),
    earlyFailure: allowedOr(ceiling.earlyFailure, n.earlyFailure, closed.earlyFailure),
    installDetection: allowedOr(
      ceiling.installDetection,
      n.installDetection,
      closed.installDetection
    ),
    observedPermission: orderedOf(DETECTED, ceiling.observedPermission, n.observedPermission),
    observedQuestion: orderedOf(DETECTED, ceiling.observedQuestion, n.observedQuestion)
  }
}

/** One field combined over the sources that report it; `undefined` when none does. */
function across<T>(
  sources: readonly NegotiatedCapabilities[],
  read: (source: NegotiatedCapabilities) => T | undefined,
  pair: (a: T, b: T) => T
): T | undefined {
  let combined: T | undefined
  for (const source of sources) {
    const value = read(source)
    if (value === undefined) continue
    combined = combined === undefined ? value : pair(combined, value)
  }
  return combined
}

const and = (a: boolean, b: boolean): boolean => a && b
const lowerOf =
  <T>(order: readonly T[]) =>
  (a: T, b: T): T =>
    lower(order, a, b)
/** Unordered: the common value when every reporting source agrees, else the fail-closed value. */
const agreeOr =
  <T>(failClosed: T) =>
  (a: T, b: T): T =>
    a === b ? a : failClosed

/**
 * 15 §2.1 `combineLowest`: per field, over the sources that report it, booleans AND, ordered
 * enums the lower value, unordered enums the common value if every reporting source agrees, else
 * the fail-closed value. A field no source reports stays omitted (the merge then fails it closed).
 */
export function combineLowest(
  ...sources: readonly NegotiatedCapabilities[]
): NegotiatedCapabilities {
  const closed = FAIL_CLOSED_CAPABILITIES
  const usage = across<Usage>(
    sources,
    (s) => s.usage,
    (a, b) => ({
      fidelity: lower(FIDELITY, a.fidelity, b.fidelity),
      rateLimits: a.rateLimits && b.rateLimits
    })
  )
  const combined: NegotiatedCapabilities = {
    launch: across(sources, (s) => s.launch, and),
    observe: across(sources, (s) => s.observe, and),
    sendTurn: across(sources, (s) => s.sendTurn, and),
    interrupt: across(sources, (s) => s.interrupt, and),
    permission: across(sources, (s) => s.permission, lowerOf(PERMISSION)),
    question: across(sources, (s) => s.question, lowerOf(QUESTION)),
    answeredElsewhere: across(sources, (s) => s.answeredElsewhere, and),
    staleAnswerSafe: across(sources, (s) => s.staleAnswerSafe, and),
    resume: across(sources, (s) => s.resume, agreeOr(closed.resume)),
    adopt: across(sources, (s) => s.adopt, and),
    turnEnd: across(sources, (s) => s.turnEnd, lowerOf(TURN_END)),
    reactionEvidence: across(sources, (s) => s.reactionEvidence, lowerOf(REACTION_EVIDENCE)),
    subagents: across(sources, (s) => s.subagents, lowerOf(SUBAGENTS)),
    usage: usage === undefined ? undefined : { ...usage },
    mcpInjection: across(sources, (s) => s.mcpInjection, agreeOr(closed.mcpInjection)),
    console: across(sources, (s) => s.console, agreeOr(closed.console)),
    earlyFailure: across(sources, (s) => s.earlyFailure, agreeOr(closed.earlyFailure)),
    installDetection: across(sources, (s) => s.installDetection, agreeOr(closed.installDetection)),
    observedPermission: across(sources, (s) => s.observedPermission, lowerOf(DETECTED)),
    observedQuestion: across(sources, (s) => s.observedQuestion, lowerOf(DETECTED))
  }
  for (const key of Object.keys(combined) as (keyof Caps)[]) {
    if (combined[key] === undefined) delete combined[key]
  }
  return combined
}

/**
 * 15 §2.1 `negotiatedFor`: the negotiation sources of one provider combined, then lowered by the
 * answer-channel gate when the profile names one (`gate` is its integration's state; `null` = not
 * gated). Anything but `on-verified` closes both permission and question (ADR-011 item 7,
 * O-15-12). The gate state is data handed in: no provider id is read here (R12).
 */
export function negotiatedFor(
  sources: readonly NegotiatedCapabilities[],
  gate: IntegrationState | null
): NegotiatedCapabilities {
  const negotiated = combineLowest(...sources)
  return gate !== null && gate !== 'on-verified'
    ? combineLowest(negotiated, { permission: 'none', question: 'none' })
    : negotiated
}
