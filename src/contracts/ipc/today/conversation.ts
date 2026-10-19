// Today's shapes of the rows owned by `conversation` (14 §2.1): the CHANGE rows' today payloads (A-13, A-15,
// A-19, A-23), the RETIRE feed, kick and settled-send rows (A-14, A-26, A-P4) and the KEEP attachment rows.
import { z } from 'zod'
import {
  legacyDwarfRoleSchema,
  legacyFeedMessageSchema,
  legacyProviderSchema,
  legacyStringSchema,
  legacyTextDeliveryChannelSchema
} from './common'

/** A-13 today response (`DwarfActivation`). */
export const dwarfActivationSchema = z
  .object({
    focused: z.boolean(),
    openedTerminal: z.boolean(),
    feed: z.array(legacyFeedMessageSchema)
  })
  .strict()

/** A-14 response (`DwarfFeedResult`), also the watched feed of the A-12 board. */
export const dwarfFeedResultSchema = z
  .object({
    readable: z.boolean(),
    messages: z.array(legacyFeedMessageSchema),
    source: z.literal('held').optional()
  })
  .strict()

/** A-15 today request (`DwarfFeedPageRequest`). */
export const dwarfFeedPageRequestSchema = z
  .object({
    dwarfId: legacyStringSchema,
    before: z.object({ timestamp: legacyStringSchema, text: legacyStringSchema }).strict()
  })
  .strict()

/** A-15 today response (`DwarfFeedPage`). */
export const dwarfFeedPageSchema = z
  .object({
    readable: z.boolean(),
    messages: z.array(legacyFeedMessageSchema),
    reachedStart: z.boolean()
  })
  .strict()

/** A-19 today response (`MineHistoryResult`). */
export const mineHistoryResultSchema = z
  .object({
    readable: z.boolean(),
    speakers: z.array(
      z
        .object({
          id: legacyStringSchema,
          provider: legacyProviderSchema,
          role: legacyDwarfRoleSchema,
          name: legacyStringSchema,
          customName: legacyStringSchema.optional(),
          lastMessageAt: z.number(),
          messages: z.array(legacyFeedMessageSchema),
          reachedStart: z.boolean().optional()
        })
        .strict()
    )
  })
  .strict()

const dwarfAttachmentSchema = z
  .object({
    path: legacyStringSchema,
    name: legacyStringSchema,
    kind: z.enum(['image', 'file']),
    bytes: z.number()
  })
  .strict()

/** A-23 today request (`DwarfTextRequest`). */
export const dwarfTextRequestSchema = z
  .object({
    dwarfId: legacyStringSchema,
    text: legacyStringSchema,
    pressEnter: z.boolean(),
    attachments: z.array(dwarfAttachmentSchema).optional()
  })
  .strict()

/** A-23 today response (`DwarfTextResult`), also the result carried by A-P4. */
export const dwarfTextResultSchema = z
  .object({
    delivered: z.boolean(),
    via: z.union([legacyTextDeliveryChannelSchema, z.literal('none')]),
    error: legacyStringSchema.optional(),
    unconfirmed: z.boolean().optional(),
    holdId: legacyStringSchema.optional()
  })
  .strict()

/** A-P4 payload (`DwarfSendSettledPush`). */
export const dwarfSendSettledPushSchema = z
  .object({
    holdId: legacyStringSchema,
    dwarfId: legacyStringSchema,
    result: dwarfTextResultSchema
  })
  .strict()

/** A-25 response item (`DwarfAttachmentPick`). */
export const dwarfAttachmentPickSchema = z
  .object({
    path: legacyStringSchema,
    attachment: dwarfAttachmentSchema.optional(),
    refusal: z
      .enum([
        'directory',
        'unreadable',
        'already-attached',
        'too-many',
        'file-too-large',
        'total-too-large'
      ])
      .optional(),
    thumbnail: legacyStringSchema.optional()
  })
  .strict()

/** A-26 request (`DwarfKickRequest`). */
export const dwarfKickRequestSchema = z.object({ dwarfId: legacyStringSchema }).strict()

/** A-26 response (`DwarfKickResult`). */
export const dwarfKickResultSchema = z
  .object({
    delivered: z.boolean(),
    via: z.union([legacyTextDeliveryChannelSchema, z.literal('none'), z.literal('dismiss')]),
    error: legacyStringSchema.optional()
  })
  .strict()
