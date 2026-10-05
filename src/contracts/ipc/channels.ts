// The one channel registry of seam A (ADR-019 item 6; 14 §1.4): every today row of 14 §2.1 (A-01…A-57,
// A-P1…A-P6, A-X1) and the two legacy rows of 14 §8 I-21, declared once, keyed by wire name, with the target
// shape. A CHANGE or RETIRE row's today shape is in TODAY_SHAPES (21 §1 item 2a). NEW rows (A-N…) and seam-B
// members are declared by the issues that build their handlers (22 §5).
//
// Kinds follow 14 §1.1: `invoke` answers, `send` is one-way, `push` is main → renderer; a push's payload is its
// `response` (14 §2.1 "Response / payload"), its `request` is empty. `status` maps 14's KEEP / CHANGE / RETIRE;
// a RETIRE row has no target, so its schemas are its today schemas.
import { z } from 'zod'
import {
  feedPageSchema,
  mineHistoryViewSchema,
  mineIdSchema,
  stopAllOutcomeSchema,
  supplierEntryViewSchema
} from '../wire'
import { hostFrameSchema } from '../host-protocol/envelope'
import { ipcResultSchema } from '../host-protocol/errors'
import { snapshotPageSchema, snapshotParamsSchema } from '../host-protocol/snapshot'
import {
  answerOutcomeSchema,
  answerPermissionParamsSchema,
  answerQuestionParamsSchema,
  feedParamsSchema,
  jevSuggestParamsSchema,
  jevSuggestResultSchema,
  launchAcceptedSchema,
  launchCustomParamsSchema,
  launchParamsSchema,
  metricsResetResultSchema,
  resetMetricsParamsSchema,
  sendMessageParamsSchema,
  sendMessageResultSchema,
  setOpenCodePermissionsParamsSchema,
  setOpenCodePermissionsResultSchema,
  suppliersLaunchableParamsSchema
} from '../host-protocol/params'
import type { ChannelSpec } from './channelSpec'
import { TODAY, type TodayShape } from './todayShapes'
import { legacyStringSchema, noPayloadSchema } from './today/common'
import {
  appBuildSchema,
  attachmentPathsSchema,
  audioPreferencesSchema,
  copyTextResultSchema,
  droppedFileSchema,
  externalLinkResultSchema,
  externalLinkSchema,
  featureFlagsSchema,
  launchViewSchema,
  panelLayoutRequestSchema,
  panelLayoutSchema,
  shortcutStateSchema,
  typographyPreferencesSchema
} from './today/window'
import {
  mineDeclareResultSchema,
  mineOpenPathRequestSchema,
  mineOpenPathResultSchema,
  mineUndeclareResultSchema,
  projectQueryResultSchema,
  projectQuerySchema
} from './today/mines'
import { dwarfAttachmentPickSchema } from './today/conversation'
import {
  jevApiKeySchema,
  jevPreferencesSchema,
  jevSettingsSchema,
  openCodeServerPasswordSchema
} from './today/preferences'
import {
  activateDwarfRequestSchema,
  cancelStopEverythingSchema,
  confirmStopEverythingSchema,
  consoleOpenResultSchema,
  hostConnectionViewSchema,
  openCodeSettingsViewSchema,
  rendererDiagnosticSchema,
  revealDwarfChatPushSchema,
  stopEverythingRequestedSchema,
  getUiPreferencesRequestSchema,
  uiPreferencesAnswerSchema,
  uiPreferencesResetSchema,
  uiPreferenceWriteSchema,
  uiSessionChangeSchema,
  uiSessionPatchSchema,
  uiSessionSnapshotSchema
} from './windowApi'

const none = noPayloadSchema

export const CHANNELS = {
  // ---- window (ui-local), KEEP
  'panel:hide': {
    name: 'panel:hide',
    kind: 'send',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: none
  },
  'panel:raise': {
    name: 'panel:raise',
    kind: 'send',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: none
  },
  'panel:getAlwaysOnTop': {
    name: 'panel:getAlwaysOnTop',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: z.boolean()
  },
  'panel:setAlwaysOnTop': {
    name: 'panel:setAlwaysOnTop',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: z.boolean(),
    response: z.boolean()
  },
  'panel:visible:get': {
    name: 'panel:visible:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: z.boolean()
  },
  'audio:preferences:get': {
    name: 'audio:preferences:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: audioPreferencesSchema
  },
  'audio:preferences:set': {
    name: 'audio:preferences:set',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: audioPreferencesSchema,
    response: audioPreferencesSchema
  },
  'panel:layout:get': {
    name: 'panel:layout:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: panelLayoutSchema
  },
  'panel:layout:set': {
    name: 'panel:layout:set',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: panelLayoutRequestSchema,
    response: panelLayoutSchema
  },
  'shortcut:get': {
    name: 'shortcut:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: shortcutStateSchema
  },
  'shortcut:set': {
    name: 'shortcut:set',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: legacyStringSchema,
    response: shortcutStateSchema
  },
  // ---- the board, feeds and legacy crew controls, RETIRE (target = today)
  'mines:get': {
    name: 'mines:get',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['mines:get']
  },
  'dwarf:activate': {
    name: 'dwarf:activate',
    kind: 'invoke',
    placement: 'split',
    status: 'changed',
    request: activateDwarfRequestSchema,
    response: ipcResultSchema(consoleOpenResultSchema)
  },
  'dwarf:feed': {
    name: 'dwarf:feed',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:feed']
  },
  'dwarf:feed:page': {
    name: 'dwarf:feed:page',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: feedParamsSchema,
    response: ipcResultSchema(feedPageSchema)
  },
  'panel:watchDwarfFeed': {
    name: 'panel:watchDwarfFeed',
    kind: 'send',
    placement: 'host',
    status: 'retired',
    ...TODAY['panel:watchDwarfFeed']
  },
  'dwarf:refreshTelemetry': {
    name: 'dwarf:refreshTelemetry',
    kind: 'send',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:refreshTelemetry']
  },
  'dwarf:setTuning': {
    name: 'dwarf:setTuning',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:setTuning']
  },
  'mine:history': {
    name: 'mine:history',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: mineIdSchema,
    response: ipcResultSchema(mineHistoryViewSchema)
  },
  'mine:openPath': {
    name: 'mine:openPath',
    kind: 'invoke',
    placement: 'split',
    status: 'kept',
    request: mineOpenPathRequestSchema,
    response: mineOpenPathResultSchema
  },
  'shell:openExternalLink': {
    name: 'shell:openExternalLink',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: externalLinkSchema,
    response: externalLinkResultSchema
  },
  'shell:copyText': {
    name: 'shell:copyText',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: legacyStringSchema,
    response: copyTextResultSchema
  },
  'dwarf:sendText': {
    name: 'dwarf:sendText',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: sendMessageParamsSchema,
    response: ipcResultSchema(sendMessageResultSchema)
  },
  'dwarf:attachments:choose': {
    name: 'dwarf:attachments:choose',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: attachmentPathsSchema
  },
  'dwarf:attachments:describe': {
    name: 'dwarf:attachments:describe',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: attachmentPathsSchema,
    response: z.array(dwarfAttachmentPickSchema)
  },
  'dwarf:kick': {
    name: 'dwarf:kick',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:kick']
  },
  'dwarf:retire': {
    name: 'dwarf:retire',
    kind: 'send',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:retire']
  },
  'app:build': {
    name: 'app:build',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: appBuildSchema
  },
  'app:features': {
    name: 'app:features',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: featureFlagsSchema
  },
  // ---- mines
  'mine:declare': {
    name: 'mine:declare',
    kind: 'invoke',
    placement: 'split',
    status: 'kept',
    request: none,
    response: mineDeclareResultSchema
  },
  'mine:declare-main': {
    name: 'mine:declare-main',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: none,
    response: mineDeclareResultSchema
  },
  'mine:undeclare': {
    name: 'mine:undeclare',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: legacyStringSchema,
    response: mineUndeclareResultSchema
  },
  'metrics:reset': {
    name: 'metrics:reset',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: resetMetricsParamsSchema,
    response: ipcResultSchema(metricsResetResultSchema)
  },
  'projects:query': {
    name: 'projects:query',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: projectQuerySchema,
    response: projectQueryResultSchema
  },
  // ---- launching, suppliers, asking
  'agent:launch': {
    name: 'agent:launch',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: launchParamsSchema,
    response: ipcResultSchema(launchAcceptedSchema)
  },
  'agent:providers': {
    name: 'agent:providers',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: suppliersLaunchableParamsSchema,
    response: ipcResultSchema(z.array(supplierEntryViewSchema))
  },
  'agent:models': {
    name: 'agent:models',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['agent:models']
  },
  'agent:launchHeld': {
    name: 'agent:launchHeld',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['agent:launchHeld']
  },
  'agent:launchHosted': {
    name: 'agent:launchHosted',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: launchCustomParamsSchema,
    response: ipcResultSchema(launchAcceptedSchema)
  },
  'agent:answerQuestion': {
    name: 'agent:answerQuestion',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: answerQuestionParamsSchema,
    response: ipcResultSchema(answerOutcomeSchema)
  },
  'agent:answerPermission': {
    name: 'agent:answerPermission',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: answerPermissionParamsSchema,
    response: ipcResultSchema(answerOutcomeSchema)
  },
  // ---- preferences, presence, typography, Jev, OpenCode, launch view
  'notifications:enabled:get': {
    name: 'notifications:enabled:get',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: none,
    response: z.boolean()
  },
  'notifications:enabled:set': {
    name: 'notifications:enabled:set',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: z.boolean(),
    response: z.boolean()
  },
  'presence:visibleMines': {
    name: 'presence:visibleMines',
    kind: 'send',
    placement: 'ui-local',
    status: 'changed',
    request: z.object({ mineIds: z.array(mineIdSchema) }).strict(),
    response: none
  },
  'typography:preferences:get': {
    name: 'typography:preferences:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: typographyPreferencesSchema
  },
  'typography:preferences:set': {
    name: 'typography:preferences:set',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: typographyPreferencesSchema,
    response: typographyPreferencesSchema
  },
  'jev:settings:get': {
    name: 'jev:settings:get',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: none,
    response: jevSettingsSchema
  },
  'jev:apiKey:set': {
    name: 'jev:apiKey:set',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: jevApiKeySchema,
    response: jevSettingsSchema,
    sensitive: true
  },
  'jev:apiKey:clear': {
    name: 'jev:apiKey:clear',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: none,
    response: jevSettingsSchema
  },
  'jev:route': {
    name: 'jev:route',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: jevSuggestParamsSchema,
    response: ipcResultSchema(jevSuggestResultSchema)
  },
  'jev:preferences:set': {
    name: 'jev:preferences:set',
    kind: 'invoke',
    placement: 'host',
    status: 'kept',
    request: jevPreferencesSchema,
    response: jevSettingsSchema
  },
  'opencode:settings:get': {
    name: 'opencode:settings:get',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: none,
    response: ipcResultSchema(openCodeSettingsViewSchema)
  },
  'opencode:plugin:set': {
    name: 'opencode:plugin:set',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: setOpenCodePermissionsParamsSchema,
    response: ipcResultSchema(setOpenCodePermissionsResultSchema)
  },
  'opencode:password:set': {
    name: 'opencode:password:set',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: openCodeServerPasswordSchema,
    response: ipcResultSchema(openCodeSettingsViewSchema),
    sensitive: true
  },
  'opencode:password:clear': {
    name: 'opencode:password:clear',
    kind: 'invoke',
    placement: 'host',
    status: 'changed',
    request: none,
    response: ipcResultSchema(openCodeSettingsViewSchema)
  },
  'launch-view:get': {
    name: 'launch-view:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: launchViewSchema
  },
  'launch-view:set': {
    name: 'launch-view:set',
    kind: 'send',
    placement: 'ui-local',
    status: 'kept',
    request: launchViewSchema,
    response: none
  },
  // ---- pushes (main → renderer): the payload is the response
  'panel:visible:changed': {
    name: 'panel:visible:changed',
    kind: 'push',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: z.boolean()
  },
  'mines:update': {
    name: 'mines:update',
    kind: 'push',
    placement: 'host',
    status: 'retired',
    ...TODAY['mines:update']
  },
  'agent:launchFailed': {
    name: 'agent:launchFailed',
    kind: 'push',
    placement: 'host',
    status: 'retired',
    ...TODAY['agent:launchFailed']
  },
  'dwarf:sendText:settled': {
    name: 'dwarf:sendText:settled',
    kind: 'push',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:sendText:settled']
  },
  'panel:mine:show': {
    name: 'panel:mine:show',
    kind: 'push',
    placement: 'ui-local',
    status: 'retired',
    ...TODAY['panel:mine:show']
  },
  'typography:preferences:changed': {
    name: 'typography:preferences:changed',
    kind: 'push',
    placement: 'ui-local',
    status: 'kept',
    request: none,
    response: typographyPreferencesSchema
  },
  // ---- A-X1: the preload-only helper (no IPC, no handler); see PRELOAD_HELPERS
  pathForDroppedFile: {
    name: 'pathForDroppedFile',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'kept',
    request: droppedFileSchema,
    response: z.string()
  },
  // ---- 14 §8 I-21 (AMENDMENT-12, OQ-82): legacy rows with no §2 id, RETIRE at cut 5
  'dwarf:setName': {
    name: 'dwarf:setName',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:setName']
  },
  'dwarf:resetName': {
    name: 'dwarf:resetName',
    kind: 'invoke',
    placement: 'host',
    status: 'retired',
    ...TODAY['dwarf:resetName']
  },
  // ---- NEW rows of 14 §2.2, each declared by the issue that builds its handler (22 §5) and listed in
  // `unrouted.ts` until the step that routes it
  // A-N30 `reportRendererDiagnostic` (AMENDMENT-2, AR-13-03): allowlisted, no free text, so not `sensitive`
  // (14 §1.10); never forwarded to the Host
  'diag:renderer:report': {
    name: 'diag:renderer:report',
    kind: 'send',
    placement: 'ui-local',
    status: 'new',
    request: rendererDiagnosticSchema,
    response: none
  },
  // A-N25…A-N27 Stop everything and quit (PO #105; OQ-47; ADR-002 D7): the confirmation UI main asks for (push), its
  // Confirm, relayed to the Host as `host.shutdown {mode:'stop-all'}` (14 §6.3), and its Cancel
  'tray:stopEverything:requested': {
    name: 'tray:stopEverything:requested',
    kind: 'push',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: stopEverythingRequestedSchema
  },
  'tray:stopEverything:confirm': {
    name: 'tray:stopEverything:confirm',
    kind: 'invoke',
    placement: 'host',
    status: 'new',
    request: confirmStopEverythingSchema,
    response: ipcResultSchema(stopAllOutcomeSchema)
  },
  'tray:stopEverything:cancel': {
    name: 'tray:stopEverything:cancel',
    kind: 'send',
    placement: 'ui-local',
    status: 'new',
    request: cancelStopEverythingSchema,
    response: none
  },
  // A-N34 `requestStopEverything` (amendment owner-approved 2026-10-01, ISSUE-316): the renderer's entry to the
  // tray item's Stop everything and quit (ADR-002 D8 item 5: the incompatible message's one action). UI main runs
  // the tray's flow (mints the confirmation id, pushes A-N25) and opens no second confirmation while one is open
  'tray:stopEverything:request': {
    name: 'tray:stopEverything:request',
    kind: 'send',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: none
  },
  // A-N03 `getHostConnection`, A-N04 `onHostConnection`, A-N05 `retryHostConnection` (ADR-002 D9): the Host
  // connection state of HostClient, served by UI main; never forwarded to the Host
  'host:connection:get': {
    name: 'host:connection:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: hostConnectionViewSchema
  },
  'host:connection:changed': {
    name: 'host:connection:changed',
    kind: 'push',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: hostConnectionViewSchema
  },
  'host:connection:retry': {
    name: 'host:connection:retry',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: hostConnectionViewSchema
  },
  // A-N33 `confirmHostRestart` (AMENDMENT-11, OQ-79): dormant in v1, born with the first release that bumps
  // `endpointGeneration`; no handler until then (review R8B-06)
  'host:connection:confirm-restart': {
    name: 'host:connection:confirm-restart',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: hostConnectionViewSchema
  },
  // A-N17 `getUiSession`, A-N18 `patchUiSession`, A-N19 `onUiSessionChanged` (ADR-024 items 1, 3; ADR-033 item 4): the
  // UI-main session store, shared by every window; never persisted, never forwarded to the Host (INV-113)
  'ui:session:get': {
    name: 'ui:session:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: uiSessionSnapshotSchema
  },
  'ui:session:patch': {
    name: 'ui:session:patch',
    kind: 'send',
    placement: 'ui-local',
    status: 'new',
    request: uiSessionPatchSchema,
    response: none
  },
  'ui:session:changed': {
    name: 'ui:session:changed',
    kind: 'push',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: uiSessionChangeSchema
  },
  // A-N20 `getUiPreferences`, A-N21 `setUiPreference` (ADR-024 items 1, 9; AMENDMENT-6): the persisted UI preferences
  // UI main owns; the setter answers what was stored, for `startWithSystem` the verified login-entry state (ADR-027
  // item 7)
  'ui:preferences:get': {
    name: 'ui:preferences:get',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'new',
    request: getUiPreferencesRequestSchema,
    response: uiPreferencesAnswerSchema
  },
  'ui:preferences:set': {
    name: 'ui:preferences:set',
    kind: 'invoke',
    placement: 'ui-local',
    status: 'new',
    request: uiPreferenceWriteSchema,
    response: uiPreferenceWriteSchema
  },
  // A-N12 `onUiPreferencesReset` (ADR-024 item 8; ADR-023 item 4 step 5): UI main reset its stores for a Reset metrics
  // epoch; every window re-reads its session and preferences (14 §3.9, AMENDMENT-1)
  'ui:preferences:reset': {
    name: 'ui:preferences:reset',
    kind: 'push',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: uiPreferencesResetSchema
  },
  // A-N01 `getHostSnapshot`, A-N02 `onHostEvent` (ADR-003 item 7; ADR-033 item 3; 14 §1.2): the Host read path of every
  // Host-fed read model, born `host` in cut 1. A-N01 relays B-M04 `session.snapshot` page by page, its params and page
  // unchanged; A-N02 is the one push every Host frame reaches renderers through, as ordered `HostFrame[]` batches.
  // Both carry sensitive Host data (14 §3.5 `session.snapshot` result, SENSITIVE_FRAMES): never logged
  'host:snapshot': {
    name: 'host:snapshot',
    kind: 'invoke',
    placement: 'host',
    status: 'new',
    request: snapshotParamsSchema,
    response: ipcResultSchema(snapshotPageSchema),
    sensitive: true
  },
  'host:event': {
    name: 'host:event',
    kind: 'push',
    placement: 'host',
    status: 'new',
    request: none,
    response: z.array(hostFrameSchema),
    sensitive: true
  },
  // A-N16 `onRevealDwarfChat` (ADR-018 item 6; ADR-025 item 8; PO #96): UI main's reveal of a dwarf's chat after a
  // notification click, pushed to the mode window it reveals in; the successor of A-P5 `onShowMine` (the Host never
  // pushes a "show"). Ids only, so not `sensitive`
  'mode:revealDwarfChat': {
    name: 'mode:revealDwarfChat',
    kind: 'push',
    placement: 'ui-local',
    status: 'new',
    request: none,
    response: revealDwarfChatPushSchema
  }
  // ADR-019 item 6 writes the constraint with `any`, verbatim:
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as const satisfies Record<string, ChannelSpec<any, any>>

/**
 * The entries that are preload helpers, not IPC channels: 14 §2.1 kind "sync helper" (A-X1). `ChannelSpec.kind`
 * has no such value, so they carry `invoke` (a request with a result) and are listed here: the preload
 * implements them itself and main registers no handler for them.
 */
export const PRELOAD_HELPERS: readonly (keyof typeof CHANNELS)[] = ['pathForDroppedFile']

/** A row's today shape: its TODAY_SHAPES entry, or for a KEEP row its CHANNELS entry itself (the same objects). */
export function todayShapeOf(key: string): TodayShape | undefined {
  const today = (TODAY as Readonly<Record<string, TodayShape>>)[key]
  if (today) return today
  const entry = (CHANNELS as Readonly<Record<string, TodayShape & { status: string }>>)[key]
  return entry && entry.status === 'kept'
    ? { request: entry.request, response: entry.response }
    : undefined
}
