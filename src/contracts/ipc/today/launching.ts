// Today's shapes of the rows owned by `launching` (14 §2.1): the CHANGE rows' today payloads (A-35, A-39) and
// the RETIRE held launch and launch-failed push (A-38, A-P3).
import { z } from 'zod'
import { legacyLaunchFailureCauseSchema, legacyProviderSchema, legacyStringSchema } from './common'

/** A-35 today request (`AgentLaunchRequest`). */
export const agentLaunchRequestSchema = z
  .object({
    mineId: legacyStringSchema,
    provider: legacyProviderSchema,
    prompt: legacyStringSchema,
    model: legacyStringSchema.optional(),
    effort: legacyStringSchema.optional(),
    permissionMode: z.enum(['default', 'workspace-write', 'read-only']).optional(),
    routedByJev: z.boolean().optional()
  })
  .strict()

/** A-35 today response (`AgentLaunchResult`). */
export const agentLaunchResultSchema = z
  .object({
    launched: z.boolean(),
    provider: z.union([legacyProviderSchema, z.literal('none')]),
    error: legacyStringSchema.optional(),
    cause: legacyLaunchFailureCauseSchema.optional(),
    launchId: legacyStringSchema.optional()
  })
  .strict()

/** A-38 request (`HeldSessionLaunchRequest`). */
export const heldSessionLaunchRequestSchema = z
  .object({
    mineId: legacyStringSchema,
    provider: legacyProviderSchema,
    prompt: legacyStringSchema,
    model: legacyStringSchema.optional(),
    effort: legacyStringSchema.optional(),
    permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']).optional(),
    routedByJev: z.boolean().optional()
  })
  .strict()

/** A-38 response (`HeldSessionLaunchResult`). */
export const heldSessionLaunchResultSchema = z
  .object({
    launched: z.boolean(),
    error: legacyStringSchema.optional(),
    cause: legacyLaunchFailureCauseSchema.optional(),
    launchId: legacyStringSchema.optional()
  })
  .strict()

/** A-39 today request (`HostedLaunchRequest`). */
export const hostedLaunchRequestSchema = z
  .object({ mineId: legacyStringSchema, command: legacyStringSchema, prompt: legacyStringSchema })
  .strict()

/** A-39 today response (`HostedLaunchResult`). */
export const hostedLaunchResultSchema = z
  .object({
    launched: z.boolean(),
    error: legacyStringSchema.optional(),
    cause: legacyLaunchFailureCauseSchema.optional()
  })
  .strict()

/** A-P3 payload (`LaunchFailedPush`). */
export const launchFailedPushSchema = z
  .object({
    launchId: legacyStringSchema,
    provider: legacyProviderSchema,
    mineId: legacyStringSchema,
    exitCode: z.number().nullable(),
    stderrTail: legacyStringSchema,
    cause: legacyLaunchFailureCauseSchema
  })
  .strict()
