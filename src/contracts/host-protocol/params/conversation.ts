// Seam-B params and results of `conversation.*` that host-placed seam A rows relay unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import {
  dwarfIdSchema,
  feedPageRequestSchema,
  messageIdSchema,
  type DwarfId,
  type FeedPageRequest,
  type MessageId
} from '../../wire'
import { outcomeSchema, type Outcome } from '../errors'
import { requestIdSchema } from '../requestId'
import { messageTextSchema, wirePathSchema } from './bounds'

/** 05 `AttachmentPath` (14 §3 imports it; 05 gives no definition): a picker or drop path, re-validated by the Host. */
export type AttachmentPath = string

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): conversation
export interface SendMessageParams {
  dwarfId: DwarfId
  text: string // ≤ 64 KiB (06 MessageText)
  attachments: AttachmentPath[] // picker or drop paths; re-validated by the Host
  requestId: string
}
export type SendMessageResult = Outcome<
  { messageId: MessageId },
  'cannot-receive' | 'attachment-refused'
>
export interface FeedParams {
  dwarfId: DwarfId
  page?: FeedPageRequest
}

export const attachmentPathSchema = wirePathSchema

/** B-M24 `conversation.send` params; A-23's request is this same object (14 §1.2). */
export const sendMessageParamsSchema = z
  .object({
    dwarfId: dwarfIdSchema,
    text: messageTextSchema,
    attachments: z.array(attachmentPathSchema),
    requestId: requestIdSchema
  })
  .strict()

export const sendMessageResultSchema = outcomeSchema(
  z.object({ messageId: messageIdSchema }).strict(),
  z.enum(['cannot-receive', 'attachment-refused'])
)

/** B-M26 `conversation.feed` params; A-15's request is this same object (14 §1.2). */
export const feedParamsSchema = z
  .object({ dwarfId: dwarfIdSchema, page: feedPageRequestSchema.optional() })
  .strict()
