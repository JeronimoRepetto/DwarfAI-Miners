// Machine 7, message delivery (07 §7; ADR-022 items 1–3, 5): the pure rule of a `Delivery`'s phase.
// No I/O, no clock read (05 §2.2, R1): every instant is passed in.
import type { AnswerRefusalReason } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { Delivery } from './messages'

export type DeliveryTransitionId =
  | 'S7.01'
  | 'S7.02'
  | 'S7.03'
  | 'S7.04'
  | 'S7.05'
  | 'S7.06'
  | 'S7.07'
  | 'S7.08'
  | 'S7.09'
  | 'S7.10'
  | 'S7.11'
  | 'S7.12'
  | 'S7.13'
  | 'S7.14'
  | 'S7.15'
  | 'S7.16'
  | 'S7.17'
  | 'S7.18'
  | 'S7.19'

/**
 * ADR-009 D2 `reactionEvidence`, copied as the session capability carries it: the domain imports
 * no other module (05 R1). On any difference ADR-009 wins and this copy is a defect.
 */
export type ReactionEvidence = 'turn-id' | 'transcript-match' | 'none'

/** What can happen to a delivery after it started (07 §7 "Transitions", by trigger). */
export type DeliveryFact =
  | { t: 'held' }
  | { t: 'accepted'; confidence: 'confirmed' | 'unconfirmed' }
  | { t: 'activity-correlated'; reactionEvidence: ReactionEvidence }
  | { t: 'channel-error'; reason: string }
  | { t: 'session-closed' }
  | { t: 'refused'; reason: AnswerRefusalReason }
  | { t: 'retry'; canReceiveMessages: boolean }
  | { t: 're-answer'; askOpen: boolean }
  | { t: 'copied' }
  | { t: 'cannot-receive' }
  | { t: 'closed-later'; what: 'session' | 'window' | 'host' }
  | { t: 'ui-detached' }
  | { t: 'metrics-reset' }

export type DeliveryStep =
  | { ok: true; transition: DeliveryTransitionId; delivery: Delivery }
  | { ok: false; refused: 'not-in-machine-7' }

/** S7.01 / S7.02: the `sending` delivery written with its message, before any hand-over. */
export function startDelivery(input: {
  messageId: MessageId
  dwarfId: DwarfId
  kind: Delivery['kind']
  at: Instant
}): { transition: DeliveryTransitionId; delivery: Delivery } {
  return {
    transition: input.kind === 'message' ? 'S7.01' : 'S7.02',
    delivery: {
      messageId: input.messageId,
      dwarfId: input.dwarfId,
      kind: input.kind,
      phase: 'sending',
      attempts: 1,
      phaseAt: input.at
    }
  }
}

const REFUSED: DeliveryStep = { ok: false, refused: 'not-in-machine-7' }

/** The delivery in `phase`, stamped `at`, with no confidence, hold or failure of its own. */
function moved(delivery: Delivery, phase: Delivery['phase'], at: Instant): Delivery {
  const { confidence, heldUntilTurnEnd, failure, ...rest } = delivery
  void [confidence, heldUntilTurnEnd, failure]
  return { ...rest, phase, phaseAt: at }
}

function to(transition: DeliveryTransitionId, delivery: Delivery): DeliveryStep {
  return { ok: true, transition, delivery }
}

function fromSending(delivery: Delivery, fact: DeliveryFact, at: Instant): DeliveryStep {
  const message = delivery.kind === 'message'
  switch (fact.t) {
    case 'held':
      return to('S7.03', { ...delivery, heldUntilTurnEnd: true })
    case 'accepted':
      return to('S7.04', { ...moved(delivery, 'delivered', at), confidence: fact.confidence })
    case 'channel-error':
      return message
        ? to('S7.06', {
            ...moved(delivery, 'failed', at),
            failure: { kind: 'channel-error', reason: fact.reason }
          })
        : REFUSED
    case 'session-closed':
      // An answers-record in flight gets S7.08 `ask-closed` instead (07 S7.07 guard).
      return message
        ? to('S7.07', { ...moved(delivery, 'failed', at), failure: { kind: 'session-closed' } })
        : REFUSED
    case 'refused':
      return message
        ? REFUSED
        : to('S7.08', {
            ...moved(delivery, 'failed', at),
            failure: { kind: 'refused', reason: fact.reason }
          })
    case 'ui-detached':
      return to('S7.18', delivery)
    case 'metrics-reset':
      return to('S7.19', delivery)
    default:
      return REFUSED
  }
}

function fromDelivered(delivery: Delivery, fact: DeliveryFact, at: Instant): DeliveryStep {
  if (fact.t === 'closed-later') return to('S7.17', delivery)
  // ADR-022 item 3: only correlated activity, and never with `reactionEvidence: 'none'` (PO #57).
  if (
    fact.t === 'activity-correlated' &&
    delivery.phase === 'delivered' &&
    fact.reactionEvidence !== 'none'
  ) {
    return to('S7.05', { ...delivery, phase: 'reacted', phaseAt: at })
  }
  return REFUSED
}

function fromFailed(delivery: Delivery, fact: DeliveryFact, at: Instant): DeliveryStep {
  const failure = delivery.failure
  const retryable = failure?.kind === 'channel-error' || failure?.kind === 'host-interrupted'
  switch (fact.t) {
    case 'copied':
      return to('S7.11', delivery)
    case 'cannot-receive':
      return retryable ? to('S7.12', delivery) : REFUSED
    case 'retry':
      // ADR-022 item 5: Retry only of these two failures, and only while the dwarf can receive.
      return retryable && fact.canReceiveMessages && delivery.kind === 'message'
        ? to('S7.09', { ...moved(delivery, 'sending', at), attempts: delivery.attempts + 1 })
        : REFUSED
    case 're-answer':
      // ADR-010 item 13: an `ask-closed` ask is terminal, so its record never comes back.
      return failure?.kind === 'refused' && failure.reason !== 'ask-closed' && fact.askOpen
        ? to('S7.10', { ...moved(delivery, 'sending', at), attempts: delivery.attempts + 1 })
        : REFUSED
    default:
      return REFUSED
  }
}

/**
 * One transition of machine 7 (07 §7), or a refusal for a pair the machine does not list. Time is
 * no fact here: nothing moves ✓ to ✓✓ but correlated activity (NFR-TIM-05, PO #57).
 */
export function advance(delivery: Delivery, fact: DeliveryFact, at: Instant): DeliveryStep {
  switch (delivery.phase) {
    case 'sending':
      return fromSending(delivery, fact, at)
    case 'delivered':
    case 'reacted':
      return fromDelivered(delivery, fact, at)
    case 'failed':
      return fromFailed(delivery, fact, at)
  }
}

/** What the boot reconcile found for a `sending` row (ADR-022 item 2). */
export type ReconcileEvidence = { found: false } | { found: true; actedAfter: boolean }

/**
 * S7.13–S7.16: the boot reconcile of a row the Host left `sending` (ADR-022 item 2; called at boot
 * by ISSUE-173). Found in the provider's transcript or replay → delivered, or reacted when the
 * dwarf acted after it; no evidence within the window → `failed {host-interrupted}`.
 */
export function reconcileDelivery(
  row: Delivery,
  evidence: ReconcileEvidence,
  at: Instant
): DeliveryStep {
  if (row.phase !== 'sending') return REFUSED
  if (!evidence.found) {
    return to('S7.16', { ...moved(row, 'failed', at), failure: { kind: 'host-interrupted' } })
  }
  const found: Delivery = { ...moved(row, 'delivered', at), confidence: 'confirmed' }
  return evidence.actedAfter ? to('S7.15', { ...found, phase: 'reacted' }) : to('S7.14', found)
}
