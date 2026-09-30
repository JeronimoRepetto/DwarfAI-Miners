// Today's shapes (21 §1 item 2a; ADR-019 item 6): `{ request, response }` of every row whose today shape differs
// from its target shape in CHANNELS, that is every CHANGE row, and every RETIRE row (whose target schemas are these
// same objects: a RETIRE row has no target). A KEEP row has no entry: its today shape is its CHANNELS entry.
import { z } from 'zod'
import { noPayloadSchema, legacyStringSchema } from './today/common'
import {
  dwarfPermissionAnswerRequestSchema,
  dwarfQuestionAnswerRequestSchema,
  dwarfQuestionAnswerResultSchema
} from './today/asking'
import {
  dwarfActivationSchema,
  dwarfFeedPageRequestSchema,
  dwarfFeedPageSchema,
  dwarfFeedResultSchema,
  dwarfKickRequestSchema,
  dwarfKickResultSchema,
  dwarfSendSettledPushSchema,
  dwarfTextRequestSchema,
  dwarfTextResultSchema,
  mineHistoryResultSchema
} from './today/conversation'
import {
  dwarfNameRequestSchema,
  dwarfNameResultSchema,
  dwarfTuningRequestSchema,
  dwarfTuningResultSchema
} from './today/crew'
import { jevRouteLaunchRequestSchema, jevRouteLaunchResultSchema } from './today/jev'
import {
  agentLaunchRequestSchema,
  agentLaunchResultSchema,
  heldSessionLaunchRequestSchema,
  heldSessionLaunchResultSchema,
  hostedLaunchRequestSchema,
  hostedLaunchResultSchema,
  launchFailedPushSchema
} from './today/launching'
import { minesSnapshotSchema } from './today/mines'
import {
  legacyMetricsResetResultSchema,
  openCodeServerPasswordSchema,
  openCodeSettingsSchema
} from './today/preferences'
import { agentModelCatalogListSchema, agentProviderListSchema } from './today/suppliers'
import { openMineIdSchema } from './today/window'

export interface TodayShape {
  request: z.ZodTypeAny
  response: z.ZodTypeAny
}

const none = noPayloadSchema

/** Keyed by the CHANNELS key (the target wire name); A-44's today wire `panel:openMine` is in ROW_IDS. */
export const TODAY = {
  // CHANGE rows: the payloads the renderer sends and receives now
  'dwarf:activate': { request: legacyStringSchema, response: dwarfActivationSchema },
  'dwarf:feed:page': { request: dwarfFeedPageRequestSchema, response: dwarfFeedPageSchema },
  'mine:history': { request: legacyStringSchema, response: mineHistoryResultSchema },
  'dwarf:sendText': { request: dwarfTextRequestSchema, response: dwarfTextResultSchema },
  'metrics:reset': { request: none, response: legacyMetricsResetResultSchema },
  'agent:launch': { request: agentLaunchRequestSchema, response: agentLaunchResultSchema },
  'agent:providers': { request: none, response: agentProviderListSchema },
  'agent:launchHosted': { request: hostedLaunchRequestSchema, response: hostedLaunchResultSchema },
  'agent:answerQuestion': {
    request: dwarfQuestionAnswerRequestSchema,
    response: dwarfQuestionAnswerResultSchema
  },
  'agent:answerPermission': {
    request: dwarfPermissionAnswerRequestSchema,
    response: dwarfQuestionAnswerResultSchema
  },
  'presence:visibleMines': { request: openMineIdSchema, response: none },
  'jev:route': { request: jevRouteLaunchRequestSchema, response: jevRouteLaunchResultSchema },
  'opencode:settings:get': { request: none, response: openCodeSettingsSchema },
  'opencode:plugin:set': { request: z.boolean(), response: openCodeSettingsSchema },
  'opencode:password:set': {
    request: openCodeServerPasswordSchema,
    response: openCodeSettingsSchema
  },
  'opencode:password:clear': { request: none, response: openCodeSettingsSchema },
  // RETIRE rows: today's shape is also the target (they lose their handler at their cut)
  'mines:get': { request: none, response: minesSnapshotSchema },
  'dwarf:feed': { request: legacyStringSchema, response: dwarfFeedResultSchema },
  'panel:watchDwarfFeed': { request: legacyStringSchema.nullable(), response: none },
  'dwarf:refreshTelemetry': { request: legacyStringSchema, response: none },
  'dwarf:setTuning': { request: dwarfTuningRequestSchema, response: dwarfTuningResultSchema },
  'dwarf:kick': { request: dwarfKickRequestSchema, response: dwarfKickResultSchema },
  'dwarf:retire': { request: legacyStringSchema, response: none },
  'agent:models': { request: none, response: agentModelCatalogListSchema },
  'agent:launchHeld': {
    request: heldSessionLaunchRequestSchema,
    response: heldSessionLaunchResultSchema
  },
  'mines:update': { request: none, response: minesSnapshotSchema },
  'agent:launchFailed': { request: none, response: launchFailedPushSchema },
  'dwarf:sendText:settled': { request: none, response: dwarfSendSettledPushSchema },
  'panel:mine:show': { request: none, response: legacyStringSchema },
  'dwarf:setName': { request: dwarfNameRequestSchema, response: dwarfNameResultSchema },
  'dwarf:resetName': { request: legacyStringSchema, response: dwarfNameResultSchema }
} as const satisfies Record<string, TodayShape>

export const TODAY_SHAPES: Readonly<Record<string, TodayShape>> = TODAY
