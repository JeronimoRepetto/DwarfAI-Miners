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
}
export type UiSessionPatch =
  | { kind: 'draft'; dwarfId: DwarfId; text: string }
  | { kind: 'chat-view'; dwarfId: DwarfId; view: ChatViewState }
  | { kind: 'ask-picks'; askId: AskId; picks: QuestionAnswers | null }
  | { kind: 'open-chat'; host: 'panel' | 'veta' | 'valle'; dwarfId: DwarfId | null }
  | { kind: 'current-mine'; host: 'panel' | 'valle'; mineId: MineId | null }
  | { kind: 'valle'; patch: UiSessionSnapshot['valle'] }
  | { kind: 'veta-risen-chat'; dwarfId: DwarfId | null }
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
    vetaRisenChat: dwarfIdSchema.nullable().optional()
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
  })
} as const

/** A-N18's request: one patch kind; an unknown kind or an extra key is refused (14 §1.4). */
export const uiSessionPatchSchema = z.discriminatedUnion('kind', [
  patchVariants.draft.strict(),
  patchVariants.chatView.strict(),
  patchVariants.askPicks.strict(),
  patchVariants.openChat.strict(),
  patchVariants.currentMine.strict(),
  patchVariants.valle.strict(),
  patchVariants.vetaRisenChat.strict()
]) satisfies z.ZodType<UiSessionPatch>

/** A-N19's payload: a patch and the window it came from. */
export const uiSessionChangeSchema = z.discriminatedUnion('kind', [
  patchVariants.draft.extend({ origin: windowModeSchema }).strict(),
  patchVariants.chatView.extend({ origin: windowModeSchema }).strict(),
  patchVariants.askPicks.extend({ origin: windowModeSchema }).strict(),
  patchVariants.openChat.extend({ origin: windowModeSchema }).strict(),
  patchVariants.currentMine.extend({ origin: windowModeSchema }).strict(),
  patchVariants.valle.extend({ origin: windowModeSchema }).strict(),
  patchVariants.vetaRisenChat.extend({ origin: windowModeSchema }).strict()
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
  .object({ startWithSystem: z.boolean().optional() })
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
  z.object({ key: z.literal('startWithSystem'), value: z.boolean() }).strict()
]) satisfies z.ZodType<UiPreferenceWrite>
