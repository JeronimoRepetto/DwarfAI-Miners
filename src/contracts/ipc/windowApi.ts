// Seam A types of the changed members (14 §3.8 `contracts/ipc/window-api.ts`), with their strict() schemas.
// The NEW members of `DwarfAiMinersApiDelta` and their types land with the issues that build their handlers.
import { z } from 'zod'
import { requestIdSchema } from '../host-protocol/requestId'
import {
  askIdSchema,
  consentOriginSchema,
  dwarfIdSchema,
  integrationStateSchema,
  messageIdSchema,
  mineIdSchema,
  secretBackendSchema,
  type AskId,
  type ConsentOrigin,
  type DwarfId,
  type IntegrationState,
  type MessageId,
  type MineId,
  type SecretBackend
} from '../wire'
import { helloOkSchema, type HelloOk } from '../host-protocol/adr-003'
import { questionAnswersSchema, type QuestionAnswers } from '../host-protocol/params/asking'
import { MESSAGE_TEXT_MAX_BYTES, messageTextSchema } from '../host-protocol/params/bounds'

// Fields and names exactly as 14 §3.8 writes them.
export interface ActivateDwarfRequest {
  dwarfId: DwarfId
  purpose: 'open-console' | 'jump-to-terminal'
}
export type ConsoleOpenResult =
  | { outcome: 'raised'; mode: 'focus-terminal' } // the dwarf's own terminal came to the front
  | { outcome: 'opened'; mode: 'attach' | 'log' } // a terminal was opened (attach, or the read-only live view)
  // the UI could not execute the target; no toast (PO #42). `mode` is `ConsoleTarget['mode']` (ADR-031 item 1),
  // that is `ProviderCapabilities['console']` (ADR-009 D2); ConsoleTarget itself is not a seam A type.
  | { outcome: 'failed'; mode: 'focus-terminal' | 'attach' | 'log' }

export interface OpenCodeSettingsView {
  // successor of OpenCodeSettings (contracts.ts:4916)
  permissions: IntegrationState // 'off' | 'on-unverified' | 'on-verified'
  consentOrigin?: ConsentOrigin
  permissionsError?: 'config-write-failed' | 'config-revert-failed'
  passwordConfigured: boolean
  secretBackend: SecretBackend
}

export const activateDwarfRequestSchema = z
  .object({ dwarfId: dwarfIdSchema, purpose: z.enum(['open-console', 'jump-to-terminal']) })
  .strict()

export const consoleOpenResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('raised'), mode: z.literal('focus-terminal') }).strict(),
  z.object({ outcome: z.literal('opened'), mode: z.enum(['attach', 'log']) }).strict(),
  z
    .object({ outcome: z.literal('failed'), mode: z.enum(['focus-terminal', 'attach', 'log']) })
    .strict()
])

export const openCodeSettingsViewSchema = z
  .object({
    permissions: integrationStateSchema,
    consentOrigin: consentOriginSchema.optional(),
    permissionsError: z.enum(['config-write-failed', 'config-revert-failed']).optional(),
    passwordConfigured: z.boolean(),
    secretBackend: secretBackendSchema
  })
  .strict()

// A-N30 `reportRendererDiagnostic` (14 §3.8; AMENDMENT-2, AR-13-03): allowlisted, no free text (14 §1.10).
export interface RendererDiagnostic {
  event: 'renderer.error' | 'renderer.unhandled-rejection' | 'renderer.store-error' // allowlist; any other value is dropped by main
  errCode?: string // /^[A-Za-z0-9_.-]{1,64}$/: an error class or code name (e.g. 'TypeError'), never a message
  count?: number // integer 1..10 000: repeats the renderer folded since its last report
}

/** 14 §3.8 `RendererDiagnostic.errCode`: an error class or code name, never a message. */
export const RENDERER_ERR_CODE = /^[A-Za-z0-9_.-]{1,64}$/

export const rendererDiagnosticSchema = z
  .object({
    event: z.enum(['renderer.error', 'renderer.unhandled-rejection', 'renderer.store-error']),
    errCode: z.string().regex(RENDERER_ERR_CODE).optional(),
    count: z.number().int().min(1).max(10_000).optional()
  })
  .strict()

// A-N25…A-N27 Stop everything and quit (14 §2.2, §3.8; ADR-002 D7 steps 1–3). The `confirmationId` is issued by UI
// main for each confirmation it asks for (a UUID); A-N26 carries the renderer's `requestId` for `host.shutdown`
// (14 §1.6: a UUIDv7, the seam-B rule of every mutating request).
export const stopEverythingRequestedSchema = z
  .object({ confirmationId: z.string().uuid() })
  .strict()

export const confirmStopEverythingSchema = z
  .object({ confirmationId: z.string().uuid(), requestId: requestIdSchema })
  .strict()

export const cancelStopEverythingSchema = z.object({ confirmationId: z.string().uuid() }).strict()

// A-N03 `getHostConnection`, A-N04 `onHostConnection`, A-N05 `retryHostConnection` and A-N33 `confirmHostRestart`
// (14 §2.2, §3.8; ADR-002 D9; AMENDMENT-2, AMENDMENT-11): ADR-002 D9's `HostConnection` state plus what composables
// gate on. Fields and comments as 14 §3.8 writes them.
export interface HostConnectionView {
  // ADR-002 D9 HostConnection state (HostClient.state()) + what composables gate on
  state: 'connecting' | 'connected' | 'reconnecting' | 'unavailable'
  since?: number // reconnecting
  // unavailable. 'unresponsive' (AMENDMENT-2, AR-13-02): endpoint still bound but no frame for 60 s (ADR-003 item 9);
  // Retry = A-N05, its effect on the hung Host is ADR-002 D9's. 'generation-restart' (AMENDMENT-11, OQ-79): a running
  // Host of a different `endpointGeneration` (ADR-002 D8 item 4, ADR-027 item 4): blocking notice; the Host is
  // restarted only after `confirmHostRestart` (A-N33)
  reason?:
    | 'spawn-failed'
    | 'crash-loop'
    | 'incompatible'
    | 'elevated-refused'
    | 'in-job'
    | 'unresponsive'
    | 'generation-restart'
  // generation-restart: launched sessions that will be resumed, and those the drain waits for; absent when the older
  // Host's hello.ok does not carry them: no count shown (OQ-79)
  restart?: { resumable: number; waiting: number }
  hostVersion?: string
  compat?: boolean // protocolVersion differs (ADR-002 D8 item 2)
  hostState?: HelloOk['state']
  jobStatus?: HelloOk['jobStatus'] // 'in-job' is a degraded state the UI surfaces (ADR-002 D6)
  capabilities?: string[] // HelloOk.capabilities (method, frame:, section: names)
}

export const hostConnectionViewSchema = z
  .object({
    state: z.enum(['connecting', 'connected', 'reconnecting', 'unavailable']),
    since: z.number().optional(),
    reason: z
      .enum([
        'spawn-failed',
        'crash-loop',
        'incompatible',
        'elevated-refused',
        'in-job',
        'unresponsive',
        'generation-restart'
      ])
      .optional(),
    restart: z
      .object({ resumable: z.number().int().min(0), waiting: z.number().int().min(0) })
      .strict()
      .optional(),
    hostVersion: z.string().optional(),
    compat: z.boolean().optional(),
    hostState: helloOkSchema.shape.state.optional(),
    jobStatus: helloOkSchema.shape.jobStatus.optional(),
    capabilities: z.array(z.string()).optional()
  })
  .strict() satisfies z.ZodType<HostConnectionView>

// A-N17 `getUiSession`, A-N18 `patchUiSession`, A-N19 `onUiSessionChanged` (14 §2.2, §3.9; ADR-024 items 1, 3): the
// UI-main session store, shared by every window of the app run, never persisted and never sent to the Host
// (INV-113). Types and comments as 14 §3.9 and ADR-024 item 3 write them; `ChatViewState` is ADR-024's (14 §3.9 names
// it, ADR-024 item 3 defines it).
export type WindowMode = 'panel' | 'veta' | 'valle' | 'hidden' // 06 §15

// A-N13 `moveToMode`, A-N14 `onModeTransition` (14 §2.2, §3.9; ADR-025 item 3): the `ModeCoordinator`'s run, as
// 14 §3.9 writes them (ISSUE-284).
export interface MoveToModeParams {
  mode: WindowMode
  mineId?: MineId
  dwarfId?: DwarfId
  slot?: 'chat' | 'history' // 07 N-23: 'history' opens the Panel on the mine's history for that dwarf (S24.13)
}
export interface ModeTransition {
  // ADR-025 D3 step 2
  transitionId: string
  from: WindowMode
  to: WindowMode
  t0: number // UI-main clock, shared start
  chat?: { dwarfId: DwarfId; mineId: MineId }
  // AMENDMENT-27 (owner, 2026-10-24): what the target opens for the carried chat (07 N-23, S24.13); absent = 'chat'
  slot?: 'chat' | 'history'
  role: 'source' | 'target' // what this renderer plays
}

export interface ChatViewState {
  scrollAnchor: { messageId: MessageId; offsetPx: number } | 'bottom' // anchored to a message, not a pixel offset
  selection?: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } // composer caret/selection
}

export interface UiSessionSnapshot {
  // ADR-024 D1 UI main session store (never persisted)
  drafts: Record<DwarfId, string> // never sent to the Host (INV-113)
  chatViews: Record<DwarfId, ChatViewState> // ADR-024 D3
  askPicks: Record<AskId, QuestionAnswers> // partial picks, not persisted (OQ-03, PO #92)
  openChat: Partial<Record<'panel' | 'veta' | 'valle', DwarfId | null>> // open chat per host
  currentMine: Partial<Record<'panel' | 'valle', MineId | null>> // one per host (BR-13, INV-115)
  valle: {
    mosaicScrollLeft?: number
    diveForDwarfId?: DwarfId | null
    historyOpen?: boolean
    // 07 N-16: last chat focused per mine since Valle opened; seeded at start-up from the Host's most recent
    // person-sent message (snapshot tails) or the Panel's last open chat (07 §24 I-29)
    talkedTo?: Record<MineId, DwarfId>
    focusedPin?: DwarfId | null // 07 N-20
    secondPaneDwarfId?: DwarfId | null // 07 N-20: the split's second pane
    addPins?: Array<{ mineId: MineId; order: number }> // pending Add panels pinned in the deck: session only (PO #67; R5B-27)
  }
  vetaRisenChat?: DwarfId | null
  // AMENDMENT-28 (owner, 2026-10-24): the music the shown mode window plays, written by the window a run leaves and
  // adopted by the window it enters; one music, one playlist across the modes (owner ruling 2026-10-24; #174)
  music?: UiSessionMusic
}
export interface UiSessionMusic {
  on: boolean // the Music slot's state for this run (US-SHELL-005)
  track: string | null // the track sounding; null between two tracks or before the first
  positionMs: number // where in `track` it had got to
  queue: string[] // the tracks still to play in this shuffled round, in order
  lastPlayed: string | null // the round's last track, so the next round does not open on it
}
export type UiSessionPatch =
  | { kind: 'draft'; dwarfId: DwarfId; text: string }
  | { kind: 'chat-view'; dwarfId: DwarfId; view: ChatViewState }
  | { kind: 'ask-picks'; askId: AskId; picks: QuestionAnswers | null }
  | { kind: 'open-chat'; host: 'panel' | 'veta' | 'valle'; dwarfId: DwarfId | null }
  | { kind: 'current-mine'; host: 'panel' | 'valle'; mineId: MineId | null }
  | { kind: 'valle'; patch: UiSessionSnapshot['valle'] }
  | { kind: 'veta-risen-chat'; dwarfId: DwarfId | null }
  | { kind: 'music'; music: UiSessionMusic } // AMENDMENT-28
// Main drops a dwarf's draft, chat view, open-chat, talkedTo, focusedPin and secondPane entries on dwarf.departed
// (INV-34) and emits the patches.

/** A-N19's payload: the patch with the window it came from (14 §3.8 `onUiSessionChanged`). */
export type UiSessionChange = UiSessionPatch & { origin: WindowMode }

export const windowModeSchema = z.enum(['panel', 'veta', 'valle', 'hidden'])

/**
 * A record keyed by a branded id, typed as 14 writes it (`Record<DwarfId, V>`). zod infers a record whose key is not
 * plain `string` as `Partial<Record<K, V>>`; the runtime check is the same `z.record`, every key validated by `key`.
 */
function idRecordSchema<K extends string, V extends z.ZodTypeAny>(
  key: z.ZodType<K>,
  value: V
): z.ZodType<Record<K, z.output<V>>> {
  return z.record(key, value) as z.ZodType<Record<K, z.output<V>>>
}

/** A caret or selection offset in the composer: a UTF-16 index, bounded like a draft (06 `MessageText`). */
const composerOffsetSchema = z.number().int().nonnegative().max(MESSAGE_TEXT_MAX_BYTES)

export const chatViewStateSchema = z
  .object({
    scrollAnchor: z.union([
      z.object({ messageId: messageIdSchema, offsetPx: z.number().finite() }).strict(),
      z.literal('bottom')
    ]),
    selection: z
      .object({
        start: composerOffsetSchema,
        end: composerOffsetSchema,
        direction: z.enum(['forward', 'backward', 'none'])
      })
      .strict()
      .optional()
  })
  .strict() satisfies z.ZodType<ChatViewState>

const valleSessionSchema = z
  .object({
    mosaicScrollLeft: z.number().finite().optional(),
    diveForDwarfId: dwarfIdSchema.nullable().optional(),
    historyOpen: z.boolean().optional(),
    talkedTo: idRecordSchema(mineIdSchema, dwarfIdSchema).optional(),
    focusedPin: dwarfIdSchema.nullable().optional(),
    secondPaneDwarfId: dwarfIdSchema.nullable().optional(),
    addPins: z
      .array(z.object({ mineId: mineIdSchema, order: z.number().int().nonnegative() }).strict())
      .optional()
  })
  .strict()

/** A music track: the asset URL the renderer's playlist names (AMENDMENT-28). */
const musicTrackSchema = z.string().min(1).max(2048)

/** AMENDMENT-28: the music slot of the UI-main session store; an unknown field is refused (14 §1.4). */
export const uiSessionMusicSchema = z
  .object({
    on: z.boolean(),
    track: musicTrackSchema.nullable(),
    positionMs: z.number().finite().nonnegative(),
    queue: z.array(musicTrackSchema).max(64),
    lastPlayed: musicTrackSchema.nullable()
  })
  .strict() satisfies z.ZodType<UiSessionMusic>

export const uiSessionSnapshotSchema = z
  .object({
    drafts: idRecordSchema(dwarfIdSchema, messageTextSchema),
    chatViews: idRecordSchema(dwarfIdSchema, chatViewStateSchema),
    askPicks: idRecordSchema(askIdSchema, questionAnswersSchema),
    openChat: z
      .object({
        panel: dwarfIdSchema.nullable().optional(),
        veta: dwarfIdSchema.nullable().optional(),
        valle: dwarfIdSchema.nullable().optional()
      })
      .strict(),
    currentMine: z
      .object({
        panel: mineIdSchema.nullable().optional(),
        valle: mineIdSchema.nullable().optional()
      })
      .strict(),
    valle: valleSessionSchema,
    vetaRisenChat: dwarfIdSchema.nullable().optional(),
    music: uiSessionMusicSchema.optional()
  })
  .strict() satisfies z.ZodType<UiSessionSnapshot>

const patchVariants = {
  draft: z.object({ kind: z.literal('draft'), dwarfId: dwarfIdSchema, text: messageTextSchema }),
  chatView: z.object({
    kind: z.literal('chat-view'),
    dwarfId: dwarfIdSchema,
    view: chatViewStateSchema
  }),
  askPicks: z.object({
    kind: z.literal('ask-picks'),
    askId: askIdSchema,
    picks: questionAnswersSchema.nullable()
  }),
  openChat: z.object({
    kind: z.literal('open-chat'),
    host: z.enum(['panel', 'veta', 'valle']),
    dwarfId: dwarfIdSchema.nullable()
  }),
  currentMine: z.object({
    kind: z.literal('current-mine'),
    host: z.enum(['panel', 'valle']),
    mineId: mineIdSchema.nullable()
  }),
  valle: z.object({ kind: z.literal('valle'), patch: valleSessionSchema }),
  vetaRisenChat: z.object({
    kind: z.literal('veta-risen-chat'),
    dwarfId: dwarfIdSchema.nullable()
  }),
  music: z.object({ kind: z.literal('music'), music: uiSessionMusicSchema })
} as const

/** A-N18's request: one patch kind; an unknown kind or an extra key is refused (14 §1.4). */
export const uiSessionPatchSchema = z.discriminatedUnion('kind', [
  patchVariants.draft.strict(),
  patchVariants.chatView.strict(),
  patchVariants.askPicks.strict(),
  patchVariants.openChat.strict(),
  patchVariants.currentMine.strict(),
  patchVariants.valle.strict(),
  patchVariants.vetaRisenChat.strict(),
  patchVariants.music.strict()
]) satisfies z.ZodType<UiSessionPatch>

/** A-N19's payload: a patch and the window it came from. */
export const uiSessionChangeSchema = z.discriminatedUnion('kind', [
  patchVariants.draft.extend({ origin: windowModeSchema }).strict(),
  patchVariants.chatView.extend({ origin: windowModeSchema }).strict(),
  patchVariants.askPicks.extend({ origin: windowModeSchema }).strict(),
  patchVariants.openChat.extend({ origin: windowModeSchema }).strict(),
  patchVariants.currentMine.extend({ origin: windowModeSchema }).strict(),
  patchVariants.valle.extend({ origin: windowModeSchema }).strict(),
  patchVariants.vetaRisenChat.extend({ origin: windowModeSchema }).strict(),
  patchVariants.music.extend({ origin: windowModeSchema }).strict()
]) satisfies z.ZodType<UiSessionChange>

// A-N20 `getUiPreferences`, A-N21 `setUiPreference` (14 §2.2, §3.9; ADR-024 items 1, 9): the persisted UI preferences
// UI main owns. Types and comments as 14 §3.9 writes them (`startWithSystem` as AMENDMENT-6 writes it).
export type ZoneContent = 'mine' | 'map' | 'mineslist' | 'history'
export interface VetaDock {
  edge: 'left' | 'right' | 'top' | 'bottom'
  end: 'start' | 'end'
  offset: number
}
export interface ValleLayoutControl {
  // Control room preset
  chatWidth: number
  split: boolean // 07 N-17 / V-05: the wish; 'suspended' is derived (machine 30)
  foldedList: boolean
  zones: Record<MineId, { content: ZoneContent }> // 07 N-21: one zone per mosaic column, keyed by its mine
}
export interface ValleLayoutFront {
  // Work front preset
  chatWidth: number
  split: boolean
  foldedList: boolean
  zone: { content: ZoneContent; mineId?: MineId } // 07 N-21: a single zone
}
export interface UiPreferencesMap {
  // persisted keys NEW on seam A (ADR-024 D1)
  lastMode: Exclude<WindowMode, 'hidden'> // written by the ModeCoordinator only
  modeAtLaunch: 'last-used' | 'panel' | 'veta' | 'valle' // US-SET-002
  lastSettingsSection: string // PO #33
  vetaDock: Record<string /* DisplayKey, ADR-024 D5 */, VetaDock>
  valleLayout: { control: ValleLayoutControl; front: ValleLayoutFront }
  vallePreset: 'control' | 'front' // the preset in use, restored like lastMode (lead decision derived from
  // OQ-18; R5B-01); Reset metrics returns it to 'control' (ADR-024 D8)
  valleLastFrontMineId: MineId | null // 07 N-15: "the last mine worked in", remembered with the layout
  valleMosaicOrder: MineId[] | null // 07 N-22: null = never written (the first mosaic applies); [] = emptied
  pins: Array<{ dwarfId: DwarfId; mineId: MineId; order: number }> | null // PO #85; chat pins only (R5B-27); null = never written (start-up pins apply)
  mutedMineIds: MineId[] // 07 N-18, 06 §16 D-13: ambience muted per mine
  resetEpochApplied: number // written by UI main only, after ui.resetPreferences (§4.3 rule 4)
  startWithSystem: boolean // AMENDMENT-6 (OQ-65): Settings → General "Start with the system"; default true;
  // UI main stores the verified login-entry state (ADR-027 item 7), so the
  // setUiPreference answer is the real state, which may differ from the request
}
export type UiPreferenceKey = keyof UiPreferencesMap
export type UiPreferenceWrite = {
  [K in UiPreferenceKey]: { key: K; value: UiPreferencesMap[K] }
}[UiPreferenceKey]
// lastMode and resetEpochApplied are written by UI main itself, never by a renderer:
// setUiPreference({key:'lastMode' | 'resetEpochApplied'}) → INVALID_PARAMS.

// Valle window placement constants (07 N-19; ADR-024 D7, ADR-025 D1): architect values, config keys
export const VALLE_ON_SCREEN_RATIO = 0.5 // a mine zone counts as on screen for reportVisibleMines when it intersects the Valle viewport by ≥ this share (07 S39.05; pending DG-25)
export const VALLE_BOUNDS = 'work-area' as const // Valle opens on the work area of the display matching the source window (07 S39.01, OQ-20; pending DG)

// The persisted Valle keys of 14 §3.9 (ISSUE-299; ADR-024 items 1, 4, 6): each as 14 §3.9 types it, strict.
const zoneContentSchema = z.enum([
  'mine',
  'map',
  'mineslist',
  'history'
]) satisfies z.ZodType<ZoneContent>
const valleLayoutControlSchema = z
  .object({
    chatWidth: z.number().finite().nonnegative(),
    split: z.boolean(),
    foldedList: z.boolean(),
    zones: idRecordSchema(mineIdSchema, z.object({ content: zoneContentSchema }).strict())
  })
  .strict() satisfies z.ZodType<ValleLayoutControl>
const valleLayoutFrontSchema = z
  .object({
    chatWidth: z.number().finite().nonnegative(),
    split: z.boolean(),
    foldedList: z.boolean(),
    zone: z.object({ content: zoneContentSchema, mineId: mineIdSchema.optional() }).strict()
  })
  .strict() satisfies z.ZodType<ValleLayoutFront>
/** `UiPreferencesMap.valleLayout`: each preset's own layout (07 machines 28, 30–33). */
export const valleLayoutSchema = z
  .object({ control: valleLayoutControlSchema, front: valleLayoutFrontSchema })
  .strict() satisfies z.ZodType<UiPreferencesMap['valleLayout']>
/** `UiPreferencesMap.vallePreset`: the preset in use. */
export const vallePresetSchema = z.enum(['control', 'front']) satisfies z.ZodType<
  UiPreferencesMap['vallePreset']
>
/** `UiPreferencesMap.valleLastFrontMineId` (07 N-15). */
export const valleLastFrontMineIdSchema = mineIdSchema.nullable() satisfies z.ZodType<
  UiPreferencesMap['valleLastFrontMineId']
>
/** `UiPreferencesMap.valleMosaicOrder` (07 N-22): `null` = never written; `[]` = emptied. */
export const valleMosaicOrderSchema = z.array(mineIdSchema).nullable() satisfies z.ZodType<
  UiPreferencesMap['valleMosaicOrder']
>
/** `UiPreferencesMap.pins` (PO #85; R5B-27): chat pins only; `null` = never written. */
const vallePinSchema = z
  .object({ dwarfId: dwarfIdSchema, mineId: mineIdSchema, order: z.number().int().nonnegative() })
  .strict()
export const pinsSchema = z.array(vallePinSchema).nullable() satisfies z.ZodType<
  UiPreferencesMap['pins']
>
/** `UiPreferencesMap.mutedMineIds` (07 N-18; 06 §16 D-13). */
export const mutedMineIdsSchema = z.array(mineIdSchema) satisfies z.ZodType<
  UiPreferencesMap['mutedMineIds']
>

/**
 * 14 §3.9 `modeAtLaunch` (US-SET-002): the whole type, Valle included. Which options Settings draws is the build's
 * (ADR-034 item 2); a stored mode this build does not ship opens the Panel (ISSUE-294).
 */
export const modeAtLaunchSchema = z.enum([
  'last-used',
  'panel',
  'veta',
  'valle'
]) satisfies z.ZodType<UiPreferencesMap['modeAtLaunch']>

/** Every key of 14 §3.9 `UiPreferencesMap`: A-N20 may ask for any of them. */
export const UI_PREFERENCE_KEYS = [
  'lastMode',
  'modeAtLaunch',
  'lastSettingsSection',
  'vetaDock',
  'valleLayout',
  'vallePreset',
  'valleLastFrontMineId',
  'valleMosaicOrder',
  'pins',
  'mutedMineIds',
  'resetEpochApplied',
  'startWithSystem'
] as const satisfies readonly UiPreferenceKey[]

export const uiPreferenceKeySchema = z.enum(UI_PREFERENCE_KEYS) satisfies z.ZodType<UiPreferenceKey>

/** A-N20's request: the keys the window asks for. */
export const getUiPreferencesRequestSchema = z
  .object({ keys: z.array(uiPreferenceKeySchema) })
  .strict() satisfies z.ZodType<{ keys: UiPreferenceKey[] }>

/**
 * A-N20's answer: the stored value of each asked key UI main serves. A key joins this schema, and the renderer's
 * writable keys below, in the issue that builds it (Veta and Valle keys with their epics, ADR-034); until then it is
 * never answered (hidden until built, 21 §1 item 8).
 */
export const uiPreferencesAnswerSchema = z
  .object({
    startWithSystem: z.boolean().optional(),
    // ISSUE-286: Veta's stored places, read by the Veta renderer (14 §3.9 usage rule); written by UI main only.
    vetaDock: z.lazy(() => vetaDocksSchema).optional(),
    // ISSUE-294: Settings › General "Mode at launch" (US-SET-002.AC09), read and written by the Panel renderer.
    modeAtLaunch: modeAtLaunchSchema.optional(),
    // ISSUE-299: the Valle stores, read by the Valle renderer before its first paint (07 S39.03); each becomes
    // renderer-writable in the issue that first writes it (ISSUE-300: the preset and the layouts; ISSUE-301…ISSUE-310
    // the rest). An unwritten layout is not answered.
    valleLayout: valleLayoutSchema.optional(),
    vallePreset: vallePresetSchema.optional(),
    valleLastFrontMineId: valleLastFrontMineIdSchema.optional(),
    valleMosaicOrder: valleMosaicOrderSchema.optional(),
    pins: pinsSchema.optional(),
    mutedMineIds: mutedMineIdsSchema.optional()
  })
  .strict() satisfies z.ZodType<Partial<UiPreferencesMap>>

/**
 * A-N12 `onUiPreferencesReset`'s payload (14 §2.2, §3.8 `{ epoch: number }`; ADR-024 item 8): only the Reset metrics
 * epoch UI main applied, a whole count from 1. Each window then re-reads A-N17 and A-N20 (14 §3.9, AMENDMENT-1).
 */
export const uiPreferencesResetSchema = z
  .object({ epoch: z.number().int().positive() })
  .strict() satisfies z.ZodType<{ epoch: number }>

/**
 * A-N16 `onRevealDwarfChat`'s payload (14 §2.2, §3.8 `{ mineId: MineId; dwarfId: DwarfId | null }`; ADR-018 item 6;
 * ADR-025 item 8): the mine to bring into view and the dwarf whose chat opens there, `null` when the dwarf left (the
 * reveal is then `'mine-only'`). Ids only: nothing a person or a provider said.
 */
export interface RevealDwarfChatPush {
  mineId: MineId
  dwarfId: DwarfId | null
}

export const revealDwarfChatPushSchema = z
  .object({ mineId: mineIdSchema, dwarfId: dwarfIdSchema.nullable() })
  .strict() satisfies z.ZodType<RevealDwarfChatPush>

/**
 * A-N21's request and answer: one key and its value. Only the keys a renderer may write are listed: `lastMode` and
 * `resetEpochApplied` are UI main's own (14 §3.9), so a write of either is refused `INVALID_PARAMS` by the seam A gate.
 */
export const uiPreferenceWriteSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('startWithSystem'), value: z.boolean() }).strict(),
  z.object({ key: z.literal('modeAtLaunch'), value: modeAtLaunchSchema }).strict(),
  // ISSUE-300: the Valle window writes the preset in use and each preset's layout on every change (07 S28.06,
  // S28.11, S28.16, S28.17); the other Valle keys become writable in the issue that first writes them.
  z.object({ key: z.literal('vallePreset'), value: vallePresetSchema }).strict(),
  z.object({ key: z.literal('valleLayout'), value: valleLayoutSchema }).strict(),
  // ISSUE-302: the Valle window writes the chat pins, whole and in order, on every change (07 S29.03…S29.23; TC-302-01).
  // `null` (never written) is UI main's alone to restore, on Reset metrics (S29.20); an Add pin is never here (R5B-27).
  z.object({ key: z.literal('pins'), value: z.array(vallePinSchema) }).strict(),
  // ISSUE-301: the dive and a Work front swap write the last mine worked in (07 S28.03, S28.15; N-15). `null` (never
  // written) is UI main's alone to restore, on Reset metrics (S39.10).
  z.object({ key: z.literal('valleLastFrontMineId'), value: mineIdSchema }).strict(),
  // ISSUE-304: "Close this column" and the add slot write the mosaic order (07 S32.01, S32.03, S32.05, S32.11, S32.13,
  // S32.14), the zone menu the muted mines (S31.08). `[]` is an emptied mosaic; `null` (never written) is UI main's
  // alone to restore, on Reset metrics (S32.16). After it every Valle key of 14 §3.9 is renderer-writable.
  z.object({ key: z.literal('valleMosaicOrder'), value: z.array(mineIdSchema) }).strict(),
  z.object({ key: z.literal('mutedMineIds'), value: mutedMineIdsSchema }).strict()
]) satisfies z.ZodType<UiPreferenceWrite>

// A-N13 `moveToMode`, A-N14 `onModeTransition`, A-N15 `modeTransitionDone` (14 §2.2, §3.9; ADR-025 item 3;
// ISSUE-284): the `ModeCoordinator`'s run. The `transitionId` is issued by UI main (a UUID), as A-N25's
// `confirmationId` is.
export const moveToModeParamsSchema = z
  .object({
    mode: windowModeSchema,
    mineId: mineIdSchema.optional(),
    dwarfId: dwarfIdSchema.optional(),
    slot: z.enum(['chat', 'history']).optional()
  })
  .strict() satisfies z.ZodType<MoveToModeParams>

export const modeTransitionSchema = z
  .object({
    transitionId: z.string().uuid(),
    from: windowModeSchema,
    to: windowModeSchema,
    t0: z.number(),
    chat: z.object({ dwarfId: dwarfIdSchema, mineId: mineIdSchema }).strict().optional(),
    slot: z.enum(['chat', 'history']).optional(),
    role: z.enum(['source', 'target'])
  })
  .strict() satisfies z.ZodType<ModeTransition>

export const modeTransitionDoneSchema = z.object({ transitionId: z.string().uuid() }).strict()

// A-N22 `setVetaClickThrough`, A-N24 `getWindowingLimits` (14 §2.2; ADR-025 items 4, 6; ISSUE-285): the Veta
// renderer's hit-test result, and what the windowing of this session allows (NFR-PLAT-05). Booleans only.
export interface VetaClickThroughParams {
  ignore: boolean
}
export interface WindowingLimitsView {
  dockingAvailable: boolean
  alwaysOnTopAvailable: boolean
}
export const vetaClickThroughParamsSchema = z
  .object({ ignore: z.boolean() })
  .strict() satisfies z.ZodType<VetaClickThroughParams>
export const windowingLimitsSchema = z
  .object({ dockingAvailable: z.boolean(), alwaysOnTopAvailable: z.boolean() })
  .strict() satisfies z.ZodType<WindowingLimitsView>

// A-N23 `layoutVeta`, A-N28 `onVetaDockChanged` (14 §2.2, §3.9; ADR-025 items 2, 5, 8; 07 machine 21, N-14, N-25;
// ISSUE-286): the whole `VetaLayoutRequest` union as 14 §3.9 writes it. ISSUE-286 implements `drag-start`, `drag-end`,
// `dock-key` and `island-resize`, ISSUE-288 `overlay`, ISSUE-290 `rise` and `fold`; the other kinds answer
// `applied: false` until their issue implements them (ISSUE-291, ISSUE-292). Geometry, ids and a display key only: nothing a person or a provider said.
export type VetaLayoutRequest =
  | { kind: 'rise'; dwarfId: DwarfId; chatBounds: { width: number; height: number } } // resize before the rise (ADR-025 D2)
  | { kind: 'fold' } // resize after the fold completes
  | { kind: 'unfold-overflow'; mineId: MineId } // "+N" unfold for a reveal (ADR-025 D8)
  | { kind: 'drag-start'; screenX: number; screenY: number } // 07 N-14: the drag surface of the display under the pointer
  | { kind: 'drag-end'; screenX: number; screenY: number } // may re-dock to another display (D5)
  | { kind: 'dock-key'; edge: VetaDock['edge'] } // 07 N-14: keyboard docking
  | { kind: 'island-resize'; length: number } // 07 N-14, V-10: grow before, shrink after (arrivals, departures, "+N")
  | { kind: 'overlay'; bounds: { width: number; height: number } | null } // 07 N-25: tab band, menus, picker; null = closed
export interface VetaLayoutResult {
  applied: boolean
  displayKey: string
  dock: VetaDock
}
export interface VetaDockChanged {
  // A-N28 push (07 N-14): main re-placed Veta
  displayKey: string
  dock: VetaDock
  reason: 'display-removed' | 'display-changed' | 'work-area-changed'
}

/**
 * The Veta island's size (ISSUE-287; `DS/docs/screens/veta.md` Layout), shared by UI main (the window it places) and
 * the Veta renderer, so the two agree: `thickness` across its edge, 52 px on every edge (2 × 2 px island padding +
 * 2 × 2 px chamber margin + the 44 px chamber); `length` along it before the strip reports its own with
 * `island-resize`, the closed entrance's 80 px (2 × 2 px island padding + 2 × 2 px margin + the 72 px entrance).
 */
export const VETA_ISLAND = { length: 80, thickness: 52 } as const

const vetaEdgeSchema = z.enum(['left', 'right', 'top', 'bottom'])
export const vetaDockSchema = z
  .object({
    edge: vetaEdgeSchema,
    end: z.enum(['start', 'end']),
    offset: z.number().finite().nonnegative()
  })
  .strict() satisfies z.ZodType<VetaDock>
/** `UiPreferencesMap.vetaDock`: one place per `displayKey` (ADR-024 item 5). */
export const vetaDocksSchema = z.record(z.string().min(1), vetaDockSchema) satisfies z.ZodType<
  UiPreferencesMap['vetaDock']
>
const screenPoint = { screenX: z.number().finite(), screenY: z.number().finite() }
const size = z
  .object({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() })
  .strict()
export const vetaLayoutRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rise'), dwarfId: dwarfIdSchema, chatBounds: size }).strict(),
  z.object({ kind: z.literal('fold') }).strict(),
  z.object({ kind: z.literal('unfold-overflow'), mineId: mineIdSchema }).strict(),
  z.object({ kind: z.literal('drag-start'), ...screenPoint }).strict(),
  z.object({ kind: z.literal('drag-end'), ...screenPoint }).strict(),
  z.object({ kind: z.literal('dock-key'), edge: vetaEdgeSchema }).strict(),
  z
    .object({ kind: z.literal('island-resize'), length: z.number().finite().nonnegative() })
    .strict(),
  z.object({ kind: z.literal('overlay'), bounds: size.nullable() }).strict()
]) satisfies z.ZodType<VetaLayoutRequest>
export const vetaLayoutResultSchema = z
  .object({ applied: z.boolean(), displayKey: z.string(), dock: vetaDockSchema })
  .strict() satisfies z.ZodType<VetaLayoutResult>
export const vetaDockChangedSchema = z
  .object({
    displayKey: z.string(),
    dock: vetaDockSchema,
    reason: z.enum(['display-removed', 'display-changed', 'work-area-changed'])
  })
  .strict() satisfies z.ZodType<VetaDockChanged>
