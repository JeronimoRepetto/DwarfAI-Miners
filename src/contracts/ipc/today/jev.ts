// Today's shapes of the row owned by `jev` (14 §2.1 A-50, CHANGE): the legacy routing payloads.
import { z } from 'zod'
import { legacyProviderSchema, legacyStringSchema } from './common'
import { jevLaunchDefaultSchema } from './preferences'

const jevFallbackReasonSchema = z.enum([
  'no-key',
  'no-launchable-provider',
  'unreachable',
  'timeout',
  'rate-limited',
  'unauthorized',
  'low-confidence',
  'invalid-response',
  'budget-exceeded'
])

const modelTierSchema = z.enum([
  'fast-cheap',
  'balanced',
  'frontier',
  'long-context',
  'special-purpose'
])

const answeredPart = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({ value, confidence: z.number(), applied: z.enum(['answered', 'safe-default']) })
    .strict()

const noulPartSchema = z.object({ value: z.boolean(), probability: z.number() }).strict()

/** A-50 today request (`JevRouteLaunchRequest`). */
export const jevRouteLaunchRequestSchema = z.object({ prompt: legacyStringSchema }).strict()

/** A-50 today response (`JevRouteLaunchResult`). */
export const jevRouteLaunchResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('decision'),
      provider: legacyProviderSchema,
      model: legacyStringSchema.optional(),
      effort: legacyStringSchema.optional(),
      confidence: z.number().optional(),
      truncated: z.boolean(),
      tier: modelTierSchema,
      parts: z
        .object({
          provider: answeredPart(legacyProviderSchema),
          tier: answeredPart(modelTierSchema),
          trivial: noulPartSchema,
          largeContext: noulPartSchema,
          model: z
            .object({
              value: legacyStringSchema.optional(),
              applied: z.enum(['answered', 'safe-default', 'only-candidate']),
              probability: z.number().optional(),
              choiceProbability: z.number().optional(),
              reason: z.union([jevFallbackReasonSchema, z.literal('no-live-model')]).optional()
            })
            .strict()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('fallback'),
      reason: jevFallbackReasonSchema,
      confidence: z.number().optional(),
      fallbackTo: jevLaunchDefaultSchema.optional()
    })
    .strict()
])
