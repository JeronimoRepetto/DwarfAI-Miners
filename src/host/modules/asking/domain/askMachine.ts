// Machine 6, the ask (07 §6; ADR-010 items 3–8, 10–11): pure transitions over the `Ask` aggregate.
// Time is passed in and only stamps `closedAt`: no transition depends on elapsed time (INV-74).
//
// - `submit` is the critical section's decision (ADR-010 item 4, INV-72): it wins only on the
//   dwarf's front ask while that ask is `open` and has an answer channel; everything else is
//   `not-open` and changes nothing (S6.07, PO #28).
// - `setStep` keeps the step the person is on (S6.04, INV-75): only the dwarf's front ask while it
//   is `open` moves, and only to another whole step; everything else changes nothing (16 §4.7).
// - `channelResult` settles the hand-over: `accepted` closes the ask (S6.08); a refusal other than
//   `ask-closed` reopens it (S6.09); the provider no longer holding the request closes it
//   answered-elsewhere (S6.10); an ask already closed meanwhile stays in its closing state and the
//   outcome is `refused: 'ask-closed'` (S6.15, S6.22).
// - An external resolution that lands while the hand-over is in flight is held by the caller until
//   the result (S6.21) and handed back to `channelResult`; the ask record has no field for it.
// - One card per dwarf (INV-70): the front is the dwarf's oldest ask that is `open` or `answering`,
//   in arrival order; the next one opens when it closes (S6.16).
// Every state change goes through `applyTransition`, which refuses a pair 07 §6 does not list.
import { HostInvariantError } from '../../../kernel/domain/errors'
import {
  isTerminal,
  type AnswerOutcome,
  type Ask,
  type AskChannel,
  type AskKind,
  type AskState
} from './ask'
import { hasAllowOnce, type PermissionOptionFlags } from './permissionOptions'

/** The stable transition ids of machine 6 (07 §6). */
export type AskTransitionId =
  | 'S6.01'
  | 'S6.02'
  | 'S6.03'
  | 'S6.04'
  | 'S6.05'
  | 'S6.06'
  | 'S6.07'
  | 'S6.08'
  | 'S6.09'
  | 'S6.10'
  | 'S6.11'
  | 'S6.12'
  | 'S6.13'
  | 'S6.14'
  | 'S6.15'
  | 'S6.16'
  | 'S6.17'
  | 'S6.18'
  | 'S6.19'
  | 'S6.20'
  | 'S6.21'
  | 'S6.22'

/** One row of 07 §6's transition table: the states it leaves and the states it reaches. */
export interface AskTransitionRow {
  /** `'birth'`: the row creates the ask (`[*]` in 07). */
  readonly from: 'birth' | readonly AskState[]
  /** `'same'`: a self-loop that keeps the ask's state. */
  readonly to: 'same' | readonly AskState[]
}

const CLOSED: readonly AskState[] = [
  'answered-in-app',
  'answered-elsewhere',
  'cancelled',
  'closed-by-death',
  'auto-denied'
]

/** 07 §6, transcribed: the only (from → to) pairs machine 6 has. */
export const MACHINE_6: Readonly<Record<AskTransitionId, AskTransitionRow>> = {
  'S6.01': { from: 'birth', to: ['open'] },
  'S6.02': { from: 'birth', to: ['open'] },
  'S6.03': { from: 'birth', to: ['auto-denied'] },
  'S6.04': { from: ['open'], to: 'same' },
  'S6.05': { from: ['open'], to: 'same' },
  'S6.06': { from: ['open'], to: ['answering'] },
  'S6.07': { from: ['answering', ...CLOSED, 'open'], to: 'same' },
  'S6.08': { from: ['answering'], to: ['answered-in-app'] },
  'S6.09': { from: ['answering'], to: ['open'] },
  'S6.10': { from: ['answering'], to: ['answered-elsewhere'] },
  'S6.11': { from: ['open'], to: ['answered-elsewhere'] },
  'S6.12': { from: ['open'], to: ['answered-in-app'] },
  'S6.13': { from: ['open'], to: ['cancelled'] },
  'S6.14': { from: ['open'], to: ['closed-by-death'] },
  'S6.15': { from: ['answering'], to: ['closed-by-death'] },
  'S6.16': { from: ['open'], to: 'same' },
  'S6.17': { from: ['open'], to: 'same' },
  'S6.18': { from: ['open', 'answering'], to: ['closed-by-death'] },
  'S6.19': { from: 'birth', to: ['open'] },
  'S6.20': { from: ['answering'], to: ['open', 'answered-in-app', 'answered-elsewhere'] },
  'S6.21': { from: ['answering'], to: 'same' },
  'S6.22': { from: ['answering'], to: ['cancelled'] }
}

/** One step of machine 6: the ask afterwards and the transition that applied (null = none). */
export interface AskStep {
  readonly ask: Ask
  readonly transition: AskTransitionId | null
}

/**
 * What `asking.open` turns into an ask: the reported request (suppliers' `AskInput`, 15 §1.2) with
 * the dwarf the caller resolved and the id the broker generated (ADR-010 item 5).
 */
export interface AskOpening {
  readonly id: string
  readonly dwarfId: string
  readonly kind: AskKind
  readonly channel: AskChannel
  readonly providerRequestId: string
  readonly payload: Ask['payload']
  /** The permission's option flags; null for a question. */
  readonly options: PermissionOptionFlags | null
  /** False only from the Host recovery pass, for a need a resumed session re-raised (S6.19). */
  readonly reannounce: boolean
}

/**
 * An opening: an open ask, or a permission without `allow_once` on an answer channel, which is
 * never a card ask (INV-73, OQ-42 B) and takes the no-channel handling (later: ISSUE-132).
 */
export type AskOpened =
  | { readonly kind: 'opened'; readonly ask: Ask; readonly transition: 'S6.01' | 'S6.02' | 'S6.19' }
  | { readonly kind: 'not-a-card-ask' }

/** The critical section's decision (ADR-010 item 4). `not-open` writes nothing and shows nothing. */
export type SubmitResult =
  | { readonly kind: 'won'; readonly ask: Ask; readonly transition: 'S6.06' }
  | { readonly kind: 'not-open'; readonly transition: 'S6.07' | null }

/** A settled hand-over: the ask afterwards and the `AnswerOutcome` the submit returns. */
export interface ChannelSettlement extends AskStep {
  readonly outcome: AnswerOutcome
}

/** An external resolution; `held` is set while the hand-over is in flight (S6.21). */
export interface ExternalResolution extends AskStep {
  readonly held: 'elsewhere' | null
}

/** What the Host boot reconcile knows of an ask's session and request (07 S6.17, S6.18, S6.20). */
export interface RestartFacts {
  /** The session outlived the Host (a re-adopted server-kind session). */
  readonly sessionSurvived: boolean
  /** The server still lists the ask's `providerRequestId` as pending. */
  readonly stillPending: boolean
  /** The ask's answers-record shows delivery evidence. */
  readonly deliveryEvidence: boolean
}

/**
 * Moves an ask along one listed transition. A pair 07 §6 does not list (a closed ask reopening, a
 * result for an ask with no answer in flight, a birth row on an existing ask) is a programming
 * error. `closedAt` is required when the transition closes the ask.
 */
export function applyTransition(
  ask: Ask,
  id: AskTransitionId,
  to: AskState,
  closedAt?: number
): Ask {
  const row = MACHINE_6[id]
  if (row.from === 'birth') throw new HostInvariantError(`${id} creates an ask; it never moves one`)
  if (!row.from.includes(ask.state))
    throw new HostInvariantError(`${id} does not leave ${ask.state}`)
  if (row.to === 'same') {
    if (to !== ask.state) throw new HostInvariantError(`${id} keeps the state ${ask.state}`)
    return ask
  }
  if (!row.to.includes(to)) throw new HostInvariantError(`${id} does not reach ${to}`)
  if (!isTerminal(to)) return { ...ask, state: to }
  if (closedAt === undefined)
    throw new HostInvariantError(`${id} closes the ask and needs closedAt`)
  return { ...ask, state: to, closedAt }
}

/** S6.01, S6.02, S6.19: a reported request becomes an open ask (or is not a card ask, INV-73). */
export function openAsk(opening: AskOpening, openedAt: number): AskOpened {
  if (opening.channel !== 'none' && opening.options !== null && !hasAllowOnce(opening.options)) {
    return { kind: 'not-a-card-ask' }
  }
  const ask: Ask = {
    id: opening.id,
    dwarfId: opening.dwarfId,
    kind: opening.kind,
    channel: opening.channel,
    providerRequestId: opening.providerRequestId,
    payload: opening.payload,
    currentStep: 0,
    state: 'open',
    reannounce: opening.reannounce,
    openedAt
  }
  const transition = opening.channel === 'none' ? 'S6.02' : opening.reannounce ? 'S6.01' : 'S6.19'
  return { kind: 'opened', ask, transition }
}

/**
 * S6.03: a request a launched session cannot have answered in the app (no answer channel, or a
 * permission without `allow_once`) is born `auto-denied` and closed at once; it never opens.
 */
export function autoDenyAsk(opening: AskOpening, at: number): AskStep {
  const ask: Ask = {
    id: opening.id,
    dwarfId: opening.dwarfId,
    kind: opening.kind,
    channel: opening.channel,
    providerRequestId: opening.providerRequestId,
    payload: opening.payload,
    currentStep: 0,
    state: 'auto-denied',
    reannounce: opening.reannounce,
    openedAt: at,
    closedAt: at
  }
  return { ask, transition: 'S6.03' }
}

/**
 * The front ask of each dwarf (INV-70, ADR-010 item 7): its oldest ask that is `open` or
 * `answering`, in arrival order (the order of `asks`, never re-sorted by clock). Only the front
 * shows a card; while it is answering, no other ask of the dwarf does.
 */
export function frontAsk(asks: readonly Ask[]): ReadonlyMap<string, Ask> {
  const front = new Map<string, Ask>()
  for (const ask of asks) {
    if (isTerminal(ask.state) || front.has(ask.dwarfId)) continue
    front.set(ask.dwarfId, ask)
  }
  return front
}

/**
 * S6.06 / S6.07: a submit on the ask `askId` among the broker's asks. It wins only when the ask is
 * `open`, has an answer channel and is its dwarf's front ask; the winner is `answering` and every
 * later submit finds it not open. A queued ask or an unknown id shows no card: `not-open` too.
 */
export function submit(asks: readonly Ask[], askId: string): SubmitResult {
  const ask = asks.find((candidate) => candidate.id === askId)
  if (ask === undefined) return { kind: 'not-open', transition: null }
  if (ask.state !== 'open' || ask.channel === 'none')
    return { kind: 'not-open', transition: 'S6.07' }
  if (frontAsk(asks).get(ask.dwarfId) !== ask) return { kind: 'not-open', transition: null }
  return { kind: 'won', ask: applyTransition(ask, 'S6.06', 'answering'), transition: 'S6.06' }
}

/**
 * S6.04: the step the person is on, reported by the UI for the ask `askId` among the broker's asks.
 * It moves only the dwarf's front ask while that ask is `open`, to a whole step other than the one
 * it is on; the picks are never part of it (OQ-03). An unknown, closed, `answering` or queued ask,
 * the same step or a step that is not a whole non-negative number is null: nothing changes.
 */
export function setStep(asks: readonly Ask[], askId: string, step: number): AskStep | null {
  const ask = asks.find((candidate) => candidate.id === askId)
  if (ask === undefined || ask.state !== 'open') return null
  if (!Number.isInteger(step) || step < 0 || step === ask.currentStep) return null
  if (frontAsk(asks).get(ask.dwarfId) !== ask) return null
  return {
    ask: { ...applyTransition(ask, 'S6.04', 'open'), currentStep: step },
    transition: 'S6.04'
  }
}

const ASK_CLOSED: AnswerOutcome = { kind: 'refused', reason: 'ask-closed' }

/**
 * S6.08 / S6.09 / S6.10: the channel's result for the answer in flight. `held` is an external
 * resolution that arrived meanwhile (S6.21). An ask that closed while answering (S6.15, S6.22)
 * stays in its closing state and the submit's outcome is `refused: 'ask-closed'`: no card returns.
 */
export function channelResult(
  ask: Ask,
  result: AnswerOutcome,
  now: number,
  held: 'elsewhere' | null = null
): ChannelSettlement {
  if (isTerminal(ask.state)) return { ask, outcome: ASK_CLOSED, transition: null }
  if (ask.state !== 'answering') {
    throw new HostInvariantError('a channel result needs an answer in flight')
  }
  if (result.kind === 'accepted') {
    return {
      ask: applyTransition(ask, 'S6.08', 'answered-in-app', now),
      outcome: result,
      transition: 'S6.08'
    }
  }
  if (result.kind === 'refused' && result.reason !== 'ask-closed' && held === null) {
    return { ask: applyTransition(ask, 'S6.09', 'open'), outcome: result, transition: 'S6.09' }
  }
  // The provider no longer holds the request (ask-closed, or a channel that answers not-open), or
  // it was resolved elsewhere while the answer was in flight.
  return {
    ask: applyTransition(ask, 'S6.10', 'answered-elsewhere', now),
    outcome: ASK_CLOSED,
    transition: 'S6.10'
  }
}

/**
 * S6.11 / S6.13 / S6.21 / S6.22: the provider resolved the request outside DwarfAI (no notice,
 * PO #22) or withdrew it. A closed ask stays closed (terminal once).
 */
export function resolveExternally(
  ask: Ask,
  by: 'elsewhere' | 'cancelled',
  now: number
): ExternalResolution {
  if (ask.state === 'open') {
    return by === 'elsewhere'
      ? {
          ask: applyTransition(ask, 'S6.11', 'answered-elsewhere', now),
          transition: 'S6.11',
          held: null
        }
      : { ask: applyTransition(ask, 'S6.13', 'cancelled', now), transition: 'S6.13', held: null }
  }
  if (ask.state === 'answering') {
    return by === 'elsewhere'
      ? { ask: applyTransition(ask, 'S6.21', 'answering'), transition: 'S6.21', held: 'elsewhere' }
      : { ask: applyTransition(ask, 'S6.22', 'cancelled', now), transition: 'S6.22', held: null }
  }
  return { ask, transition: null, held: null }
}

/** S6.14 / S6.15: the dwarf's session ended; each of its open or answering asks closes by death. */
export function closeForDwarf(asks: readonly Ask[], dwarfId: string, now: number): AskStep[] {
  return asks.map((ask): AskStep => {
    if (ask.dwarfId !== dwarfId) return { ask, transition: null }
    if (ask.state === 'open') {
      return { ask: applyTransition(ask, 'S6.14', 'closed-by-death', now), transition: 'S6.14' }
    }
    if (ask.state === 'answering') {
      return { ask: applyTransition(ask, 'S6.15', 'closed-by-death', now), transition: 'S6.15' }
    }
    return { ask, transition: null }
  })
}

/**
 * The Host boot reconcile of one ask (07 S6.17, S6.18, S6.20; ADR-010 item 11, ADR-015 item 4). A
 * re-adopted open ask whose request is gone was resolved outside DwarfAI while the Host was down
 * (S6.11).
 */
export function reconcileAfterRestart(ask: Ask, facts: RestartFacts, now: number): AskStep {
  if (isTerminal(ask.state)) return { ask, transition: null }
  if (!facts.sessionSurvived) {
    return { ask: applyTransition(ask, 'S6.18', 'closed-by-death', now), transition: 'S6.18' }
  }
  if (ask.state === 'open') {
    return facts.stillPending
      ? { ask: applyTransition(ask, 'S6.17', 'open'), transition: 'S6.17' }
      : { ask: applyTransition(ask, 'S6.11', 'answered-elsewhere', now), transition: 'S6.11' }
  }
  if (facts.stillPending) return { ask: applyTransition(ask, 'S6.20', 'open'), transition: 'S6.20' }
  const settled = facts.deliveryEvidence ? 'answered-in-app' : 'answered-elsewhere'
  return { ask: applyTransition(ask, 'S6.20', settled, now), transition: 'S6.20' }
}
