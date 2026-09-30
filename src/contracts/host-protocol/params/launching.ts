// Seam-B params and results of `launching.*` that host-placed seam A rows relay unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import {
  launchIdSchema,
  mineIdSchema,
  type LaunchId,
  type MineId,
  type ProviderId
} from '../../wire'
import { requestIdSchema } from '../requestId'
import { messageTextSchema, wirePathSchema, wireTokenSchema } from './bounds'

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): launching
export interface LaunchParams {
  // 05 LaunchRequestInput on the wire
  mineId: MineId
  way: { kind: 'supplier'; providerId: ProviderId } | { kind: 'jev' }
  model?: string
  effort?: string
  permissionMode?: string // must be one of the entry's offeredModes at send time (ADR-011 item 1)
  prompt: string
  jevOn: boolean
  jevAutoAccept: boolean
  retryOf?: LaunchId // Retry of a failed launch (INV-54)
  requestId: string
}
export interface LaunchCustomParams {
  mineId: MineId
  command: string
  prompt: string
  retryOf?: LaunchId
  requestId: string
}
export interface LaunchAccepted {
  launchId: LaunchId
} // answered at acceptance (§1.7): launches row committed; settlement by frames only

/** B-M33 `launching.launch` params; A-35's request is this same object (14 §1.2). The prompt is the first message. */
export const launchParamsSchema = z
  .object({
    mineId: mineIdSchema,
    way: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('supplier'), providerId: wireTokenSchema }).strict(),
      z.object({ kind: z.literal('jev') }).strict()
    ]),
    model: wireTokenSchema.optional(),
    effort: wireTokenSchema.optional(),
    permissionMode: wireTokenSchema.optional(),
    prompt: messageTextSchema,
    jevOn: z.boolean(),
    jevAutoAccept: z.boolean(),
    retryOf: launchIdSchema.optional(),
    requestId: requestIdSchema
  })
  .strict()

/** B-M34 `launching.launchCustom` params; A-39's request is this same object (14 §1.2). */
export const launchCustomParamsSchema = z
  .object({
    mineId: mineIdSchema,
    command: wirePathSchema,
    prompt: messageTextSchema,
    retryOf: launchIdSchema.optional(),
    requestId: requestIdSchema
  })
  .strict()

export const launchAcceptedSchema = z.object({ launchId: launchIdSchema }).strict()
