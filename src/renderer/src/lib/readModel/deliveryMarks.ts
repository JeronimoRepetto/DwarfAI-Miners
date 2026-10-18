import {
  HOST_FRAME_SCHEMAS,
  type Delivery,
  type HostFrame,
  type MessageId,
  type SnapshotChunk
} from '@dwarfai/contracts'

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
