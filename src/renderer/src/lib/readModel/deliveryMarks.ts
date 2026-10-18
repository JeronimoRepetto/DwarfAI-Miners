import {
  HOST_FRAME_SCHEMAS,
  type Delivery,
  type HostFrame,
  type MessageId,
  type SnapshotChunk
} from '@dwarfai/contracts'
import type { DwarfSendState } from '../../types'

/*
 * The delivery marks as the Host states them (ISSUE-179 read side; ADR-022 item 1; 14 §4.1 `marks`): one `Delivery` per
 * `MessageId`, from the snapshot `marks` section and then the `message.delivery` frames. Pure folds for the
 * `useDwarfMessaging` read model (ADR-033 item 3): nothing here reads a clock or derives a phase.
 */

export type DeliveryMarks = Map<MessageId, Delivery>

/** The marks of one snapshot, every page joined. */
export function deliveryMarksOf(chunks: readonly SnapshotChunk[]): DeliveryMarks {
  const marks: DeliveryMarks = new Map()
  for (const chunk of chunks) {
    if (chunk.section !== 'marks') continue
    for (const delivery of chunk.data) marks.set(delivery.messageId, delivery)
  }
  return marks
}

/** Applies one frame newer than the snapshot: a `message.delivery` replaces its message's mark whole. */
export function applyDeliveryFrame(marks: DeliveryMarks, frame: HostFrame): void {
  if (frame.name !== 'message.delivery') return
  const parsed = HOST_FRAME_SCHEMAS['message.delivery'].safeParse(frame.data)
  if (parsed.success) marks.set(parsed.data.delivery.messageId, parsed.data.delivery)
}

/**
 * The marker a Host mark is drawn as (ISSUE-001; ADR-022 item 1; 14 §3.6 `Delivery`): the bubble's tick and the sprite's
 * marker read the same `DwarfSendState` they always did, now the Host's phase verbatim. A message the Host holds for a
 * turn to end is `held`; a hand-over the Host could not confirm keeps its own honest sentence; a delivered message is
 * still watched by the Host, which alone says it was seen acting. A failure carries no sentence of its own: its reason
 * is a closed kind, never words to show.
 */
export function sendStateOfDelivery(delivery: Delivery): DwarfSendState {
  switch (delivery.phase) {
    case 'sending':
      return delivery.heldUntilTurnEnd === true ? { phase: 'held' } : { phase: 'sending' }
    case 'delivered':
      return {
        phase: 'delivered',
        awaitingReaction: true,
        ...(delivery.confidence === 'unconfirmed' ? { unconfirmed: true } : {})
      }
    case 'reacted':
      return { phase: 'reacted' }
    case 'failed':
      return { phase: 'failed' }
  }
}
