// Today's shapes of the rows owned by `preferences` (14 §2.1): the KEEP Jev settings rows (A-47…A-49, A-51)
// and the CHANGE rows' today payloads (A-33, A-52…A-55).
import { z } from 'zod'
import { legacyProviderSchema, legacyStringSchema } from './common'

/** The found tree's `MAX_JEV_API_KEY_CHARS` (A-48 "over the length cap", 14 §2.1). */
export const LEGACY_JEV_API_KEY_MAX_CHARS = 512

/** The found tree's `MAX_OPENCODE_SERVER_PASSWORD_CHARS` (A-54). */
export const LEGACY_OPENCODE_PASSWORD_MAX_CHARS = 1024

export const jevApiKeySchema = z.string().max(LEGACY_JEV_API_KEY_MAX_CHARS)

export const openCodeServerPasswordSchema = z.string().max(LEGACY_OPENCODE_PASSWORD_MAX_CHARS)

/** `JevLaunchDefault`: the default launch picks. */
export const jevLaunchDefaultSchema = z
  .object({
    provider: legacyProviderSchema.optional(),
    model: legacyStringSchema.optional(),
    effort: legacyStringSchema.optional()
  })
  .strict()

/** A-51 request (`JevPreferences`). */
export const jevPreferencesSchema = z
  .object({
    profile: z.enum(['economy', 'balanced', 'premium']),
    default: jevLaunchDefaultSchema,
    delegation: z.boolean()
  })
  .strict()

/** A-47, A-48, A-49 and A-51 response (`JevSettings`): the key itself never crosses. */
export const jevSettingsSchema = z
  .object({
    configured: z.boolean(),
    unavailableReason: z.literal('encryption-unavailable').optional(),
    preferences: jevPreferencesSchema,
    preferencesError: legacyStringSchema.optional()
  })
  .strict()

/** A-33 today response (today's `MetricsResetResult`, whose shape ADR-023 item 5 extends). */
export const legacyMetricsResetResultSchema = z
  .object({ outcome: z.enum(['reset', 'failed']), reason: legacyStringSchema.optional() })
  .strict()

/** A-52…A-55 today response (`OpenCodeSettings`). */
export const openCodeSettingsSchema = z
  .object({
    pluginEnabled: z.boolean(),
    pluginError: legacyStringSchema.optional(),
    passwordConfigured: z.boolean(),
    passwordUnavailableReason: z.literal('encryption-unavailable').optional()
  })
  .strict()
