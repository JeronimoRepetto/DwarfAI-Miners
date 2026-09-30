// Today's shapes of the rows owned by `mines` (and the board they share with `crew` and `ledger`, 14 §2.1):
// the RETIRE board read and push (A-12, A-P2) and the KEEP mine rows (A-20, A-30…A-32, A-34).
import { z } from 'zod'
import {
  legacyDwarfRoleSchema,
  legacyFeedMessageSchema,
  legacyMaterialTotalsSchema,
  legacyProviderSchema,
  legacyStringSchema,
  legacyTextDeliveryChannelSchema,
  legacyTierSchema
} from './common'
import { dwarfFeedResultSchema } from './conversation'

const promptChannelSchema = z.enum(['held', 'terminal', 'opencode-permission'])

const dwarfQuestionSchema = z
  .object({
    toolUseId: legacyStringSchema,
    channel: promptChannelSchema,
    questions: z.array(
      z
        .object({
          question: legacyStringSchema,
          header: legacyStringSchema.optional(),
          multiSelect: z.boolean(),
          options: z.array(
            z
              .object({ label: legacyStringSchema, description: legacyStringSchema.optional() })
              .strict()
          )
        })
        .strict()
    ),
    askedAt: legacyStringSchema.optional()
  })
  .strict()

const dwarfPermissionRequestSchema = z
  .object({
    toolUseId: legacyStringSchema,
    toolName: legacyStringSchema,
    title: legacyStringSchema.optional(),
    description: legacyStringSchema.optional(),
    input: legacyStringSchema,
    channel: promptChannelSchema,
    askedAt: legacyStringSchema
  })
  .strict()

const dwarfCapabilitiesSchema = z
  .object({
    sendText: legacyTextDeliveryChannelSchema.nullable(),
    cancel: legacyTextDeliveryChannelSchema.nullable(),
    adjustEffort: z.null(),
    attach: legacyTextDeliveryChannelSchema.nullable(),
    maxTextChars: z.number().optional()
  })
  .strict()

const turnOutcomeSchema = z
  .object({
    kind: z.enum(['concluded', 'capped', 'errored', 'interrupted']),
    text: legacyStringSchema.optional(),
    truncated: z.boolean().optional(),
    detail: legacyStringSchema.optional(),
    endedAt: z.number(),
    cancelledFromApp: z.literal(true).optional()
  })
  .strict()

const legacyDwarfSchema = z
  .object({
    id: legacyStringSchema,
    provider: z.union([legacyProviderSchema, z.literal('panel')]),
    role: legacyDwarfRoleSchema,
    name: legacyStringSchema,
    customName: legacyStringSchema.optional(),
    model: legacyStringSchema.optional(),
    effort: legacyStringSchema.optional(),
    status: z.enum(['working', 'waiting', 'leaving']),
    description: legacyStringSchema.optional(),
    parentId: legacyStringSchema.optional(),
    lastMessage: legacyStringSchema.optional(),
    sessionId: legacyStringSchema,
    workplace: z
      .object({ path: legacyStringSchema, branch: legacyStringSchema.optional() })
      .strict()
      .optional(),
    pid: z.number().optional(),
    startedAt: z.number().optional(),
    pidStartedAt: z.number().optional(),
    tokensUsed: z.number().optional(),
    tokensObserved: z.number().optional(),
    silentForMs: z.number().optional(),
    transcriptUpdatedAt: z.number().optional(),
    attendance: z.enum(['attended', 'unattended', 'unknown']).optional(),
    waitingReason: z.enum(['user-input', 'approval', 'unknown']).optional(),
    pendingQuestion: dwarfQuestionSchema.optional(),
    pendingPermission: dwarfPermissionRequestSchema.optional(),
    textDelivery: legacyTextDeliveryChannelSchema.optional(),
    capabilities: dwarfCapabilitiesSchema.optional(),
    mcpServers: z
      .array(
        z
          .object({
            name: legacyStringSchema,
            status: z.enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
          })
          .strict()
      )
      .optional(),
    totalCostUsd: z.number().optional(),
    contextUsage: z.object({ usedTokens: z.number(), maxTokens: z.number() }).strict().optional(),
    sessionTuning: z
      .object({
        canSetModel: z.boolean(),
        canSetEffort: z.boolean(),
        pendingModel: legacyStringSchema.optional(),
        pendingEffort: legacyStringSchema.optional()
      })
      .strict()
      .optional(),
    openingPrompt: legacyFeedMessageSchema.optional(),
    launchId: legacyStringSchema.optional(),
    routedByJev: z.boolean().optional(),
    oneShot: z.boolean().optional(),
    lastTurn: turnOutcomeSchema.optional()
  })
  .strict()

const legacyMineSchema = z
  .object({
    id: legacyStringSchema,
    path: legacyStringSchema,
    name: legacyStringSchema,
    tier: legacyTierSchema,
    dwarfs: z.array(legacyDwarfSchema),
    tokensObserved: z.number(),
    materials: legacyMaterialTotalsSchema.optional(),
    updatedAt: z.number(),
    declared: z.boolean().optional(),
    weightBytes: z.number().optional(),
    mapSite: z.number().optional(),
    unrecorded: z.boolean().optional()
  })
  .strict()

/** A-12 response and A-P2 payload: the whole board. */
export const minesSnapshotSchema = z
  .object({
    mines: z.array(legacyMineSchema),
    tokensObserved: z.number(),
    materials: legacyMaterialTotalsSchema.optional(),
    watchedFeed: z
      .object({ dwarfId: legacyStringSchema, feed: dwarfFeedResultSchema })
      .strict()
      .optional()
  })
  .strict()

export const mineOpenPathRequestSchema = z
  .object({
    mineId: legacyStringSchema,
    target: legacyStringSchema,
    dwarfId: legacyStringSchema.optional()
  })
  .strict()

export const mineOpenPathResultSchema = z.discriminatedUnion('opened', [
  z.object({ opened: z.literal(true) }).strict(),
  z.object({ opened: z.literal(false), reason: legacyStringSchema }).strict()
])

const projectSummarySchema = z
  .object({
    id: legacyStringSchema,
    path: legacyStringSchema,
    name: legacyStringSchema,
    declared: z.boolean(),
    knownTier: legacyTierSchema.optional(),
    weightBytes: z.number().optional(),
    addedAt: z.number(),
    lastOpenedAt: z.number().optional(),
    lastProvider: legacyProviderSchema.optional(),
    materials: legacyMaterialTotalsSchema.optional(),
    mapSite: z.number().optional(),
    live: z.boolean(),
    folderMissing: z.literal(true).optional()
  })
  .strict()

export const mineDeclareResultSchema = z
  .object({
    outcome: z.enum(['added', 'cancelled', 'failed', 'worktree-of']),
    worktreeOf: z
      .object({
        worktree: legacyStringSchema,
        root: legacyStringSchema,
        branch: legacyStringSchema.optional(),
        commit: legacyStringSchema.optional()
      })
      .strict()
      .optional(),
    mineId: legacyStringSchema.optional(),
    project: projectSummarySchema.optional(),
    reason: legacyStringSchema.optional()
  })
  .strict()

export const mineUndeclareResultSchema = z
  .object({
    outcome: z.enum(['removed', 'unchanged', 'failed']),
    reason: legacyStringSchema.optional()
  })
  .strict()

export const projectQuerySchema = z
  .object({
    tier: legacyTierSchema.optional(),
    sortBy: z.enum(['addedAt', 'lastOpenedAt']),
    direction: z.enum(['asc', 'desc']),
    nameContains: legacyStringSchema.optional(),
    limit: z.number().optional(),
    offset: z.number().optional()
  })
  .strict()

export const projectQueryResultSchema = z
  .object({
    answered: z.boolean(),
    projects: z.array(projectSummarySchema),
    reason: legacyStringSchema.optional()
  })
  .strict()
