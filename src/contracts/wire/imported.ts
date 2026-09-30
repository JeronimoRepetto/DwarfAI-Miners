// Types the wire views reference, imported from their owners, never restated with other fields (14 §3 intro;
// AGENTS.md §2.2). Each one is field for field from the owner section named in its comment.
import { z } from 'zod'
import {
  dwarfIdSchema,
  folderPathSchema,
  instantSchema,
  messageIdSchema,
  providerIdSchema,
  uuidV7Schema,
  type DwarfId,
  type FolderPath,
  type Instant,
  type MessageId,
  type ProviderId
} from './ids'

// ---- mines (06 §0.2)

/** 06 §0.2 mines `Tier`. */
export type Tier = 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

/** 06 §0.2 mines `DwarfWorkplace` (ADR-030). */
export interface DwarfWorkplace {
  path: FolderPath
  branch?: string
}

// ---- crew (06 §0.2, ADR-032 D2, ADR-015 item 7)

/** 06 §0.1 `ProviderIdentity`, ADR-015 item 7: the provider's own ids, a separate UNIQUE key (INV-21). */
export interface ProviderIdentity {
  providerId: ProviderId
  providerSessionId: string
  providerAgentId?: string
}

/** 06 §0.2 crew `DwarfRank`. */
export type DwarfRank = 'foreman' | 'worker' | 'worker2'

/** 06 §0.2 crew `DwarfProcessState` (INV-26, INV-34). */
export type DwarfProcessState = 'running' | 'unrecovered' | 'closed'

/** 06 §0.2 crew `SessionProfile`. */
export interface SessionProfile {
  providerId: ProviderId
  model?: string
  effort?: string
  permissionMode?: string
}

/** ADR-032 D2 `DwarfStatus`: computed by the Host, never derived in the UI. */
export type DwarfStatus = 'working' | 'asking' | 'idle' | 'asleep'

/** ADR-032 D2 `DwarfPresence`: 'resuming' = Host recovery pending (ADR-015 item 5), rendered like 'present'. */
export type DwarfPresence = 'present' | 'resuming' | 'walking-out'

// ---- ledger (06 §0.2)

/** 06 §0.2 ledger `Material`. */
export type Material = 'coal' | 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

/** 06 §0.2 ledger `MaterialAmount`: `tokens` is a non-negative integer; units are derived, never carried. */
export interface MaterialAmount {
  tokens: number
}

// ---- launching (ADR-020 D1, D2; ADR-028; ADR-015 item 5)

/** ADR-020 D1 `LaunchFailureCause`: the five launch failure causes, and no others. */
export type LaunchFailureCause =
  | 'not-installed'
  | 'exited-at-once'
  | 'could-not-start'
  | 'jev-unreachable'
  | 'jev-could-not-choose'

/** 06 §12 `JevFallbackReason`: the ADR-020 D2 list plus 'effort-ceiling' (ADR-028 D2). */
export type JevFallbackReason =
  | 'unreachable'
  | 'timeout'
  | 'rate-limited'
  | 'invalid-response'
  | 'no-key'
  | 'unauthorized'
  | 'low-confidence'
  | 'budget-exceeded'
  | 'no-launchable-provider'
  | 'effort-ceiling'

/** ADR-020 D1 `LaunchFailure`. */
export interface LaunchFailure {
  cause: LaunchFailureCause
  supplierLabel: string
  jevReason?: JevFallbackReason
  reasonSentence?: string
  actions: ReadonlyArray<'retry' | 'pick-manually'>
  toolOutputTail?: string
}

/** ADR-020 D1 `LaunchState` (transitions: 07 5B). */
export type LaunchState =
  'routing' | 'resolving' | 'spawned' | 'succeeded' | 'failed' | 'handed-back' | 'lost'

/** ADR-015 item 5 `UnrecoveredReason`. */
export type UnrecoveredReason =
  'turn-lost' | 'no-resume' | 'stale-ref' | 'resume-error' | 'end-failed'

/** ADR-015 item 5 `HostRecoveryReport` (ids are spelled `string` by the owner). */
export interface HostRecoveryReport {
  hostEpoch: string
  at: number
  resumed: string[]
  unrecovered: Array<{
    dwarfId: string
    reason: UnrecoveredReason
    messageIds?: string[]
  }>
}

// ---- asking (ADR-010 item 5; 06 §0.2 asking)

/** ADR-010 item 5 `AskKind`. */
export type AskKind = 'question' | 'permission'

/** ADR-010 item 5 `AskState`. */
export type AskState =
  | 'open'
  | 'answering'
  | 'answered-in-app'
  | 'answered-elsewhere'
  | 'cancelled'
  | 'closed-by-death'
  | 'auto-denied'

/** 06 §0.2 asking `QuestionStep`. */
export interface QuestionStep {
  text: string
  options: string[]
  allowsFreeText: true
}

/** 06 §0.2 asking `QuestionPayload`. */
export interface QuestionPayload {
  steps: QuestionStep[]
}

/** 06 §0.2 asking `PermissionPayload`. */
export interface PermissionPayload {
  toolName: string
  requestText: string
}

/** ADR-010 item 5 `AskRecord` (ids are spelled `string` by the owner). */
export interface AskRecord {
  id: string
  dwarfId: string
  kind: AskKind
  channel: 'driver' | 'hook-keystroke' | 'hook-decision' | 'http' | 'none'
  providerRequestId: string
  payload: QuestionPayload | PermissionPayload
  currentStep: number
  state: AskState
  reannounce: boolean
  openedAt: number
  closedAt?: number
}

/** ADR-010 item 5 `AnswerRefusalReason`. */
export type AnswerRefusalReason =
  'channel-rejected' | 'invalid-answer' | 'channel-unavailable' | 'ask-closed'

// ---- conversation (ADR-022 item 1; 06 §0.2, §9.1)

/** ADR-022 item 1 `DeliveryPhase`. */
export type DeliveryPhase = 'sending' | 'delivered' | 'reacted' | 'failed'

/** ADR-022 item 1 `DeliveryFailure`. */
export type DeliveryFailure =
  | { kind: 'channel-error'; reason: string }
  | { kind: 'session-closed' }
  | { kind: 'refused'; reason: AnswerRefusalReason }
  | { kind: 'host-interrupted' }

/** ADR-022 item 1 `Delivery`. */
export interface Delivery {
  messageId: MessageId
  dwarfId: DwarfId
  kind: 'message' | 'answers-record'
  phase: DeliveryPhase
  confidence?: 'confirmed' | 'unconfirmed'
  heldUntilTurnEnd?: boolean
  failure?: DeliveryFailure
  attempts: number
  phaseAt: number
}

/** 06 §0.2 conversation `MessageRole` (ADR-007). */
export type MessageRole = 'person' | 'dwarf' | 'answers-record' | 'system-line'

/** 06 §0.2, §9.1 `AttachmentMeta`: name and size only. */
export interface AttachmentMeta {
  name: string
  bytes: number
}

/** 06 §0.2 conversation `ActivitySummary`: step count and one-line summaries, never tool output. */
export interface ActivitySummary {
  steps: number
  summaries: string[]
}

/**
 * 06 §0.2 conversation `MessageView` = `Message` without `sourceKey`, `origin`, `askId`; field types from 06 §9.1
 * (`text` is `MessageText`: UTF-8, ≤ 64 KiB, truncated with a marker by the Host).
 */
export interface MessageView {
  id: MessageId
  dwarfId: DwarfId
  role: MessageRole
  text: string
  issuer?: { dwarfId: DwarfId }
  activity?: ActivitySummary
  attachments: AttachmentMeta[]
  delivery?: Delivery
  providerTime: Instant | null
  createdAt: Instant
}

// ---- suppliers (06 §0.2, §7.1)

/** 06 §0.1 `IntegrationId` (ADR-011 item 7; 'claude-hooks' = ADR-016's Claude hook entries). */
export type IntegrationId = 'opencode-permissions' | 'claude-hooks'

/** 06 §0.1 `IntegrationState` (ADR-011 item 7). */
export type IntegrationState = 'off' | 'on-unverified' | 'on-verified'

/** 06 §0.2, §7.1 `SupplierEntry`; `label` is ADR-009 D2 `ProviderProfile.label: string`, the entry's source. */
export interface SupplierEntry {
  providerId: ProviderId
  label: string
  models: string[]
  efforts: string[]
  permissionModes: string[]
  installed: boolean
  publicLaunch: 'enabled' | 'gated'
  answerChannel: 'available' | 'gated-off' | 'none'
  gatingIntegration?: IntegrationId
}

// ---- preferences (06 §0.2, §12; 05 §3.12; ADR-017 item 1; column types: 10 `host_preferences`)

/** 06 §12 `JevRoutingProfile`. */
export type JevRoutingProfile = 'economy' | 'balanced' | 'premium'

/**
 * 06 §0.2 preferences `HostPreferences`; value types per 10 `host_preferences`. `openCodePermissionsOn` is derived
 * from `IntegrationSetting('opencode-permissions').state ≠ 'off'`, never stored.
 */
export interface HostPreferences {
  subagentDelegationOn: boolean
  routingProfile: JevRoutingProfile
  defaultProvider?: ProviderId
  defaultModel?: string
  defaultEffort?: string
  systemNotificationsOn: boolean
  openCodePermissionsOn: boolean
}

/** 05 §3.12 `ConsentOrigin` (ADR-016 item 5). */
export type ConsentOrigin = 'settings' | 'add-panel' | 'first-run'

/** 06 §0.2 preferences `IntegrationSetting`; `changedAt` per 10 `integration_settings.changed_at`. */
export interface IntegrationSetting {
  id: IntegrationId
  state: IntegrationState
  consentOrigin?: ConsentOrigin
  changedAt: Instant
}

/** 05 §3.12 `WelcomeStepState` (AMENDMENT-7, OQ-68; `offered` = installed tools only, AMENDMENT-9, OQ-70). */
export interface WelcomeStepState {
  due: boolean
  reason?: 'first-run' | 'legacy-entries'
  legacyFound: IntegrationId[]
  offered: IntegrationId[]
}

/** ADR-017 item 1 `SecretName`. */
export type SecretName = 'jev-key' | 'opencode-password'

/** ADR-017 item 1 `SecretBackend`. */
export type SecretBackend = 'os-secret-store' | 'unavailable'

/** 06 §0.2 preferences `SecretStatus` (ADR-017): a configured flag, never a value. */
export interface SecretStatus {
  name: SecretName
  configured: boolean
}

// ---- schemas: strict (ADR-019, 14 §1.4); each infers exactly its type above (type tests in views.contract.test.ts)

const countSchema = z.number().int().nonnegative()

export const tierSchema = z.enum(['bronze', 'copper', 'silver', 'gold', 'uranium'])

export const dwarfWorkplaceSchema = z
  .object({ path: folderPathSchema, branch: z.string().optional() })
  .strict()

export const providerIdentitySchema = z
  .object({
    providerId: providerIdSchema,
    providerSessionId: z.string(),
    providerAgentId: z.string().optional()
  })
  .strict()

export const dwarfRankSchema = z.enum(['foreman', 'worker', 'worker2'])

export const dwarfProcessStateSchema = z.enum(['running', 'unrecovered', 'closed'])

export const sessionProfileSchema = z
  .object({
    providerId: providerIdSchema,
    model: z.string().optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional()
  })
  .strict()

export const dwarfStatusSchema = z.enum(['working', 'asking', 'idle', 'asleep'])

export const dwarfPresenceSchema = z.enum(['present', 'resuming', 'walking-out'])

export const materialSchema = z.enum(['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium'])

export const materialAmountSchema = z.object({ tokens: countSchema }).strict()

/** `Record<Material, MaterialAmount>`: every material carried separately, never a summed total (INV-93). */
export const materialTotalsSchema = z
  .object({
    coal: materialAmountSchema,
    bronze: materialAmountSchema,
    copper: materialAmountSchema,
    silver: materialAmountSchema,
    gold: materialAmountSchema,
    uranium: materialAmountSchema
  })
  .strict()

export const launchFailureCauseSchema = z.enum([
  'not-installed',
  'exited-at-once',
  'could-not-start',
  'jev-unreachable',
  'jev-could-not-choose'
])

export const jevFallbackReasonSchema = z.enum([
  'unreachable',
  'timeout',
  'rate-limited',
  'invalid-response',
  'no-key',
  'unauthorized',
  'low-confidence',
  'budget-exceeded',
  'no-launchable-provider',
  'effort-ceiling'
])

export const launchFailureSchema = z
  .object({
    cause: launchFailureCauseSchema,
    supplierLabel: z.string(),
    jevReason: jevFallbackReasonSchema.optional(),
    reasonSentence: z.string().optional(),
    actions: z.array(z.enum(['retry', 'pick-manually'])).readonly(),
    toolOutputTail: z.string().max(400).optional() // ≤ 400 chars (ADR-020 D1)
  })
  .strict()

export const launchStateSchema = z.enum([
  'routing',
  'resolving',
  'spawned',
  'succeeded',
  'failed',
  'handed-back',
  'lost'
])

export const unrecoveredReasonSchema = z.enum([
  'turn-lost',
  'no-resume',
  'stale-ref',
  'resume-error',
  'end-failed'
])

export const hostRecoveryReportSchema = z
  .object({
    hostEpoch: z.string(),
    at: instantSchema,
    resumed: z.array(uuidV7Schema),
    unrecovered: z.array(
      z
        .object({
          dwarfId: uuidV7Schema,
          reason: unrecoveredReasonSchema,
          messageIds: z.array(uuidV7Schema).optional()
        })
        .strict()
    )
  })
  .strict()

export const askKindSchema = z.enum(['question', 'permission'])

export const askStateSchema = z.enum([
  'open',
  'answering',
  'answered-in-app',
  'answered-elsewhere',
  'cancelled',
  'closed-by-death',
  'auto-denied'
])

export const questionStepSchema = z
  .object({ text: z.string(), options: z.array(z.string()), allowsFreeText: z.literal(true) })
  .strict()

export const questionPayloadSchema = z.object({ steps: z.array(questionStepSchema) }).strict()

export const permissionPayloadSchema = z
  .object({ toolName: z.string(), requestText: z.string() })
  .strict()

export const askRecordSchema = z
  .object({
    id: uuidV7Schema,
    dwarfId: uuidV7Schema,
    kind: askKindSchema,
    channel: z.enum(['driver', 'hook-keystroke', 'hook-decision', 'http', 'none']),
    providerRequestId: z.string(),
    payload: z.union([questionPayloadSchema, permissionPayloadSchema]),
    currentStep: countSchema,
    state: askStateSchema,
    reannounce: z.boolean(),
    openedAt: instantSchema,
    closedAt: instantSchema.optional()
  })
  .strict()

export const answerRefusalReasonSchema = z.enum([
  'channel-rejected',
  'invalid-answer',
  'channel-unavailable',
  'ask-closed'
])

export const deliveryPhaseSchema = z.enum(['sending', 'delivered', 'reacted', 'failed'])

export const deliveryFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel-error'), reason: z.string() }).strict(),
  z.object({ kind: z.literal('session-closed') }).strict(),
  z.object({ kind: z.literal('refused'), reason: answerRefusalReasonSchema }).strict(),
  z.object({ kind: z.literal('host-interrupted') }).strict()
])

export const deliverySchema = z
  .object({
    messageId: messageIdSchema,
    dwarfId: dwarfIdSchema,
    kind: z.enum(['message', 'answers-record']),
    phase: deliveryPhaseSchema,
    confidence: z.enum(['confirmed', 'unconfirmed']).optional(),
    heldUntilTurnEnd: z.boolean().optional(),
    failure: deliveryFailureSchema.optional(),
    attempts: countSchema,
    phaseAt: instantSchema
  })
  .strict()

export const messageRoleSchema = z.enum(['person', 'dwarf', 'answers-record', 'system-line'])

export const attachmentMetaSchema = z.object({ name: z.string(), bytes: countSchema }).strict()

export const activitySummarySchema = z
  .object({ steps: countSchema, summaries: z.array(z.string()) })
  .strict()

export const messageViewSchema = z
  .object({
    id: messageIdSchema,
    dwarfId: dwarfIdSchema,
    role: messageRoleSchema,
    text: z.string(),
    issuer: z.object({ dwarfId: dwarfIdSchema }).strict().optional(),
    activity: activitySummarySchema.optional(),
    attachments: z.array(attachmentMetaSchema),
    delivery: deliverySchema.optional(),
    providerTime: instantSchema.nullable(),
    createdAt: instantSchema
  })
  .strict()

export const integrationIdSchema = z.enum(['opencode-permissions', 'claude-hooks'])

export const integrationStateSchema = z.enum(['off', 'on-unverified', 'on-verified'])

export const supplierEntrySchema = z
  .object({
    providerId: providerIdSchema,
    label: z.string(),
    models: z.array(z.string()),
    efforts: z.array(z.string()),
    permissionModes: z.array(z.string()),
    installed: z.boolean(),
    publicLaunch: z.enum(['enabled', 'gated']),
    answerChannel: z.enum(['available', 'gated-off', 'none']),
    gatingIntegration: integrationIdSchema.optional()
  })
  .strict()

export const jevRoutingProfileSchema = z.enum(['economy', 'balanced', 'premium'])

export const hostPreferencesSchema = z
  .object({
    subagentDelegationOn: z.boolean(),
    routingProfile: jevRoutingProfileSchema,
    defaultProvider: providerIdSchema.optional(),
    defaultModel: z.string().optional(),
    defaultEffort: z.string().optional(),
    systemNotificationsOn: z.boolean(),
    openCodePermissionsOn: z.boolean()
  })
  .strict()

export const consentOriginSchema = z.enum(['settings', 'add-panel', 'first-run'])

export const integrationSettingSchema = z
  .object({
    id: integrationIdSchema,
    state: integrationStateSchema,
    consentOrigin: consentOriginSchema.optional(),
    changedAt: instantSchema
  })
  .strict()

export const welcomeStepStateSchema = z
  .object({
    due: z.boolean(),
    reason: z.enum(['first-run', 'legacy-entries']).optional(),
    legacyFound: z.array(integrationIdSchema),
    offered: z.array(integrationIdSchema)
  })
  .strict()

export const secretNameSchema = z.enum(['jev-key', 'opencode-password'])

export const secretBackendSchema = z.enum(['os-secret-store', 'unavailable'])

export const secretStatusSchema = z
  .object({ name: secretNameSchema, configured: z.boolean() })
  .strict()

// ---- conversation: the outcome line (06 §0.2, §9.2; field types chosen in development, owner ruling on ISSUE-009)

/** 06 §9.2 `TurnOutcomeKind`: exactly these six (lead decision 2026-09-30; ADR-021 D1 `TurnEndKind` + in-progress kinds). */
export type TurnOutcomeKind =
  'working' | 'concluded' | 'capped' | 'errored' | 'interrupted' | 'waiting-on-you'

export const turnOutcomeKindSchema = z.enum([
  'working',
  'concluded',
  'capped',
  'errored',
  'interrupted',
  'waiting-on-you'
])

/**
 * A count carried by a part. A part exists only from one on: with no step yet the line reads "Working" alone
 * (US-MSG-011.AC13), steps are counted "from one step on" (AC14), and an unknown count is left out (AC10).
 */
const partCountSchema = z.number().int().positive()

/**
 * The outcome line's parts, structured so the renderer words them from the story copy (`contracts/text`) and keeps
 * the idle time live without a Host timer (06 §9.2; NFR-TIM-15). This list is the ONE table of part kinds: a new
 * kind is one more entry here, and the `OutcomeLinePart` type and `OUTCOME_LINE_PART_KINDS` follow from it. A kind
 * this version does not know is refused.
 */
export const outcomeLinePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('steps'), n: partCountSchema }).strict(), // `steps(n)`: steps of a finished turn
  z.object({ kind: z.literal('steps-so-far'), n: partCountSchema }).strict(), // `steps-so-far(n)`: open run
  z.object({ kind: z.literal('waiting-questions'), n: partCountSchema }).strict(), // `waiting-questions(n)`
  z.object({ kind: z.literal('waiting-permission') }).strict(),
  z.object({ kind: z.literal('answers-received') }).strict(),
  z.object({ kind: z.literal('reading-your-message') }).strict(),
  z.object({ kind: z.literal('idle-since'), at: instantSchema }).strict() // `idle-since(instant)`, worded live
])

/** One structured part of an outcome line (06 §9.2 closed part union). */
export type OutcomeLinePart = z.infer<typeof outcomeLinePartSchema>

/** The part kinds this version knows, in table order. */
export const OUTCOME_LINE_PART_KINDS: ReadonlyArray<OutcomeLinePart['kind']> = Object.freeze(
  outcomeLinePartSchema.options.map((option) => option.shape.kind.value)
)

/** At most three parts per line (06 §9.2 "`parts` (≤ 3 …)"; 10 `outcome_lines.parts_json` "≤ 3 items"). */
const OUTCOME_LINE_PARTS_MAX = 3

/** `closingWords` is "trimmed to 200 chars" (06 §9.2). */
const CLOSING_WORDS_MAX = 200

/**
 * 06 §0.2 / §9.2 `OutcomeLine`: one per dwarf, replaced at every turn change. Types where 06 names only the field:
 * `stepCount` is a count (10 `outcome_lines.step_count` "≥ 0"); `detail` is "provider word, tooltip only" and
 * `closingWords` tooltip text, both strings; `at` is "when the turn ended" (10 `outcome_lines.at`), an `Instant`.
 */
export interface OutcomeLine {
  dwarfId: DwarfId
  kind: TurnOutcomeKind
  stepCount: number
  parts: OutcomeLinePart[]
  detail?: string
  closingWords?: string
  reliability: 'reliable' | 'inferred'
  at: Instant
}

export const outcomeLineSchema = z
  .object({
    dwarfId: dwarfIdSchema,
    kind: turnOutcomeKindSchema,
    stepCount: countSchema,
    parts: z.array(outcomeLinePartSchema).max(OUTCOME_LINE_PARTS_MAX),
    detail: z.string().optional(),
    closingWords: z.string().max(CLOSING_WORDS_MAX).optional(),
    reliability: z.enum(['reliable', 'inferred']),
    at: instantSchema
  })
  .strict()

// ---- jev: the transient suggestion (06 §12; field types chosen in development, owner ruling on ISSUE-009)

/**
 * Jev's own model tier for its pick, never `Mine.tier` (06 §12 "Jev's own confidence tier, not `Mine.tier`";
 * US-LAUNCH-008 "the frontier tier"). The values are the tiers a routing decision can land on in the found tree
 * (`src/main/jev/routeDecision.ts` `RoutingTier`); the capability-table-only 'special-purpose' is never a pick.
 */
export type JevModelTier = 'fast-cheap' | 'balanced' | 'frontier' | 'long-context'

/** Where a suggested part came from: Jev answered it, or it fell back to a safe value (06 §12 `parts`). */
export type JevPartOrigin = 'answered' | 'safe-default'

/**
 * 06 §12 `JevSuggestion` (VO, transient, never persisted, INV-87). It names no permission mode and carries no
 * reason sentence or fallback supplier (06 §12). The parts are the pick's own four: supplier, model, effort, tier.
 * - `confidence` is "per part": how sure Jev was of each part it answered, as a fraction in [0, 1] that the tooltip
 *   shows as a percentage ("88% sure", US-LAUNCH-008); a part Jev did not answer has none.
 * - `parts` is "answered vs fallen back": each part present in the pick with its origin.
 * - `truncated` is a boolean: "the prompt sent to Jev was itself trimmed to fit its request budget" (US-LAUNCH-008).
 */
export interface JevSuggestion {
  providerId?: ProviderId
  model?: string
  effort?: string
  tier?: JevModelTier
  confidence: { providerId?: number; model?: number; effort?: number; tier?: number }
  truncated: boolean
  parts: {
    providerId?: JevPartOrigin
    model?: JevPartOrigin
    effort?: JevPartOrigin
    tier?: JevPartOrigin
  }
  fallback?: JevFallbackReason
}

export const jevModelTierSchema = z.enum(['fast-cheap', 'balanced', 'frontier', 'long-context'])

export const jevPartOriginSchema = z.enum(['answered', 'safe-default'])

const confidenceSchema = z.number().min(0).max(1)

export const jevSuggestionSchema = z
  .object({
    providerId: providerIdSchema.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    tier: jevModelTierSchema.optional(),
    confidence: z
      .object({
        providerId: confidenceSchema.optional(),
        model: confidenceSchema.optional(),
        effort: confidenceSchema.optional(),
        tier: confidenceSchema.optional()
      })
      .strict(),
    truncated: z.boolean(),
    parts: z
      .object({
        providerId: jevPartOriginSchema.optional(),
        model: jevPartOriginSchema.optional(),
        effort: jevPartOriginSchema.optional(),
        tier: jevPartOriginSchema.optional()
      })
      .strict(),
    fallback: jevFallbackReasonSchema.optional()
  })
  .strict()
