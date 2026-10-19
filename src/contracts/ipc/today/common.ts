// Today's shapes (21 §1 item 2a): the payloads the renderer sends and receives now, re-declared as strict()
// schemas from the found tree's `src/shared/contracts.ts` and `src/preload/index.ts` (read as reference only;
// nothing is imported from the legacy tree, R9/R16). This file holds the values several owners share.
import { z } from 'zod'

/**
 * The legacy's own ceiling for any text it carries (`MAX_DWARF_TEXT_CHARS` in the found tree): a free string of
 * a today shape is refused past it, so no payload the legacy accepts today is refused by length.
 */
export const LEGACY_TEXT_MAX_CHARS = 250_000

/** A free string of a today shape: a legacy id, a path, a prompt, a label. */
export const legacyStringSchema = z.string().max(LEGACY_TEXT_MAX_CHARS)

export const noPayloadSchema = z.undefined()

export const legacyTierSchema = z.enum(['bronze', 'copper', 'silver', 'gold', 'uranium'])

export const legacyProviderSchema = z.enum(['claude', 'codex', 'antigravity', 'opencode'])

export const legacyMaterialTotalsSchema = z
  .object({
    coal: z.number(),
    bronze: z.number(),
    copper: z.number(),
    silver: z.number(),
    gold: z.number(),
    uranium: z.number()
  })
  .strict()

export const legacyDwarfRoleSchema = z.enum(['foreman', 'worker', 'worker2'])

export const legacyTextDeliveryChannelSchema = z.enum([
  'terminal',
  'claude-relay',
  'foreman-relay',
  'codex-queue',
  'held-session',
  'launched-process',
  'hosted-stdin',
  'codex-exec-resume',
  'opencode-run-continue'
])

export const legacyLaunchFailureCauseSchema = z.enum([
  'not-installed',
  'could-not-start',
  'exited-at-once'
])

export const legacyFeedMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: legacyStringSchema,
    timestamp: legacyStringSchema,
    issuer: z
      .object({
        role: legacyDwarfRoleSchema,
        name: legacyStringSchema,
        launcherId: legacyStringSchema.optional()
      })
      .strict()
      .optional(),
    activity: z
      .object({ kind: z.enum(['edit', 'run', 'read', 'search']), target: legacyStringSchema })
      .strict()
      .optional()
  })
  .strict()
