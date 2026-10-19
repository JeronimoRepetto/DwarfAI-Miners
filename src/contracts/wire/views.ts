// Wire view types defined by 14 §3.6 (frozen; field lists exactly as written) and their strict schemas (ADR-019).
import { z } from 'zod'
import {
  dwarfIdSchema,
  folderPathSchema,
  instantSchema,
  launchIdSchema,
  messageIdSchema,
  mineIdSchema,
  providerIdSchema,
  type DwarfId,
  type FolderPath,
  type Instant,
  type LaunchId,
  type MessageId,
  type MineId,
  type ProviderId
} from './ids'
import {
  dwarfPresenceSchema,
  dwarfProcessStateSchema,
  dwarfRankSchema,
  dwarfStatusSchema,
  dwarfWorkplaceSchema,
  jevSuggestionSchema,
  outcomeLineSchema,
  sessionProfileSchema,
  hostPreferencesSchema,
  hostRecoveryReportSchema,
  integrationSettingSchema,
  launchFailureSchema,
  launchStateSchema,
  materialTotalsSchema,
  messageViewSchema,
  secretBackendSchema,
  secretStatusSchema,
  supplierEntrySchema,
  tierSchema,
  welcomeStepStateSchema,
  type DwarfPresence,
  type DwarfProcessState,
  type DwarfRank,
  type DwarfStatus,
  type DwarfWorkplace,
  type HostPreferences,
  type HostRecoveryReport,
  type JevSuggestion,
  type OutcomeLine,
  type SessionProfile,
  type IntegrationSetting,
  type LaunchFailure,
  type LaunchState,
  type Material,
  type MaterialAmount,
  type MessageView,
  type SecretBackend,
  type SecretStatus,
  type SupplierEntry,
  type Tier,
  type WelcomeStepState
} from './imported'

/** 14 §3.6 `MineWire`: Mine view (06 §0.2) as it crosses the channel. */
export interface MineWire {
  id: MineId
  path: FolderPath
  name: string
  state: 'unrecorded' | 'measuring' | 'active' | 'unenterable'
  tier: Tier | null
  hasBeenMeasured: boolean
  unenterableReason?: string
  mapSite?: { xPct: number; yPct: number }
  lastUsedAt: Instant
  totals: Record<Material, MaterialAmount>
}

/** 14 §3.6 `StopUnavailableReason` (US-MSG-016.AC02; an open turn no longer disables Stop, OQ-54, AMENDMENT-2). */
export type StopUnavailableReason = 'already-stopping'

/** 14 §3.6 `DwarfWire`: DwarfView (06 §0.2) wire subset; no StatusFacts, no process ids (ADR-032 D1). */
export interface DwarfWire {
  id: DwarfId
  mineId: MineId
  providerId: ProviderId
  baseName: string
  customName: string | null
  rank: DwarfRank
  parentDwarfId: DwarfId | null
  delegated: boolean
  sessionProfile: SessionProfile
  presence: DwarfPresence
  processState: DwarfProcessState
  status: DwarfStatus
  needsYou: boolean
  askedAt?: Instant
  canReceiveMessages: boolean
  stopInFlight: boolean
  stopUnavailableReason: StopUnavailableReason | null
  owned: boolean
  workplace?: DwarfWorkplace
  outcome?: OutcomeLine
  arrivedAt: Instant
}

/** 14 §3.6 `ActivityWire`: ActivityDisclosure (06 §0.2). */
export interface ActivityWire {
  dwarfId: DwarfId
  disclosureId: string
  open: boolean
  stepCount: number
  summaries: string[]
}

/** 14 §3.6 `LaunchWire`: Launch (06 §0.2) wire subset; no prompt (09 D-16). */
export interface LaunchWire {
  launchId: LaunchId
  mineId: MineId
  state: LaunchState
  wayKind: 'supplier' | 'custom' | 'jev'
  providerId?: ProviderId
  model?: string
  effort?: string
  dwarfId?: DwarfId
  retryOf?: LaunchId
  picks?: { providerId?: ProviderId; model?: string; effort?: string }
  failure?: LaunchFailure
  requestedAt: Instant
}

/** 14 §3.6 `FeedPageRequest`: limit ≤ 50 (at most 50 rows exist, PO #87). */
export interface FeedPageRequest {
  before?: MessageId
  limit?: number
}

/** 14 §3.6 `FeedPage`. */
export interface FeedPage {
  dwarfId: DwarfId
  messages: MessageView[]
  reachedStart: boolean
}

/**
 * 14 §3.6 `MineHistoryView`: ≤ 50 messages per speaker. Amended (owner amendment F, 2026-10-07): each speaker
 * carries its `rank` and `providerId`, so a departed speaker keeps its role portrait.
 */
export interface MineHistoryView {
  mineId: MineId
  speakers: Array<{
    dwarfId: DwarfId
    displayName: string
    rank: DwarfRank // Amended: owner amendment F, 2026-10-07
    providerId: ProviderId // Amended: owner amendment F, 2026-10-07
    departed: boolean
    messages: MessageView[]
  }>
}

/** 14 §3.6 `ModelOptionView`. */
export interface ModelOptionView {
  value: string
  label?: string
  efforts: string[]
}

/** 14 §3.6 `SupplierEntryView`. */
export interface SupplierEntryView extends Omit<SupplierEntry, 'models' | 'efforts'> {
  models: ModelOptionView[]
  offeredModes: string[]
}

/** 14 §3.6 `JevSuggestionView` = `JevSuggestion` (06 §12, transient, never persisted, INV-87). */
export type JevSuggestionView = JevSuggestion

/** 14 §3.6 `HostRecoveryReportView`: ADR-015 item 5 + display state. */
export interface HostRecoveryReportView extends HostRecoveryReport {
  state: 'pending-display' | 'shown' | 'retrying' | 'settled'
  shownAt?: Instant
  settledAt?: Instant
  retryOutcomes?: Array<{ dwarfId: DwarfId; outcome: 'resumed' | 'failed' }>
}

/** 14 §3.6 `HostToast`: one toast contract (BR-23); copy per story, rendered by the UI. */
export type HostToast =
  | { kind: 'mine-removal-failed'; requestId: string; mineId: MineId; failed: DwarfId[] }
  | { kind: 'dwarf-stop-failed'; requestId: string; dwarfId: DwarfId }
  | { kind: 'stop-all-incomplete'; requestId: string; ended: DwarfId[]; failed: DwarfId[] }
  | { kind: 'session-crashed'; dwarfId: DwarfId; launchId: LaunchId }
  | { kind: 'provider-error'; providerId: ProviderId; cause: string; dwarfId?: DwarfId }

/** 14 §3.6 `PreferencesView`. */
export interface PreferencesView {
  preferences: HostPreferences
  secrets: SecretStatus[]
  secretBackend: SecretBackend
  integrations: IntegrationSetting[]
  welcome: WelcomeStepState
}

// ---- schemas: strict (ADR-019, 14 §1.4); each infers exactly its type above (type tests in views.contract.test.ts)

const countSchema = z.number().int().nonnegative()

export const mineWireSchema = z
  .object({
    id: mineIdSchema,
    path: folderPathSchema,
    name: z.string(),
    state: z.enum(['unrecorded', 'measuring', 'active', 'unenterable']),
    tier: tierSchema.nullable(),
    hasBeenMeasured: z.boolean(),
    unenterableReason: z.string().optional(),
    mapSite: z.object({ xPct: z.number(), yPct: z.number() }).strict().optional(),
    lastUsedAt: instantSchema,
    totals: materialTotalsSchema
  })
  .strict()

export const stopUnavailableReasonSchema = z.literal('already-stopping')

export const dwarfWireSchema = z
  .object({
    id: dwarfIdSchema,
    mineId: mineIdSchema,
    providerId: providerIdSchema,
    baseName: z.string(),
    customName: z.string().nullable(),
    rank: dwarfRankSchema,
    parentDwarfId: dwarfIdSchema.nullable(),
    delegated: z.boolean(),
    sessionProfile: sessionProfileSchema,
    presence: dwarfPresenceSchema,
    processState: dwarfProcessStateSchema,
    status: dwarfStatusSchema,
    needsYou: z.boolean(),
    askedAt: instantSchema.optional(),
    canReceiveMessages: z.boolean(),
    stopInFlight: z.boolean(),
    stopUnavailableReason: stopUnavailableReasonSchema.nullable(),
    owned: z.boolean(),
    workplace: dwarfWorkplaceSchema.optional(),
    outcome: outcomeLineSchema.optional(),
    arrivedAt: instantSchema
  })
  .strict()

export const activityWireSchema = z
  .object({
    dwarfId: dwarfIdSchema,
    disclosureId: z.string(),
    open: z.boolean(),
    stepCount: countSchema,
    summaries: z.array(z.string())
  })
  .strict()

export const launchWireSchema = z
  .object({
    launchId: launchIdSchema,
    mineId: mineIdSchema,
    state: launchStateSchema,
    wayKind: z.enum(['supplier', 'custom', 'jev']),
    providerId: providerIdSchema.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    dwarfId: dwarfIdSchema.optional(),
    retryOf: launchIdSchema.optional(),
    picks: z
      .object({
        providerId: providerIdSchema.optional(),
        model: z.string().optional(),
        effort: z.string().optional()
      })
      .strict()
      .optional(),
    failure: launchFailureSchema.optional(),
    requestedAt: instantSchema
  })
  .strict()

/** At most 50 rows exist per dwarf (PO #87). */
const FEED_PAGE_LIMIT_MAX = 50

export const feedPageRequestSchema = z
  .object({
    before: messageIdSchema.optional(),
    limit: z.number().int().positive().max(FEED_PAGE_LIMIT_MAX).optional()
  })
  .strict()

export const feedPageSchema = z
  .object({
    dwarfId: dwarfIdSchema,
    messages: z.array(messageViewSchema),
    reachedStart: z.boolean()
  })
  .strict()

export const mineHistoryViewSchema = z
  .object({
    mineId: mineIdSchema,
    speakers: z.array(
      z
        .object({
          dwarfId: dwarfIdSchema,
          displayName: z.string(),
          rank: dwarfRankSchema, // Amended: owner amendment F, 2026-10-07
          providerId: providerIdSchema, // Amended: owner amendment F, 2026-10-07
          departed: z.boolean(),
          messages: z.array(messageViewSchema).max(FEED_PAGE_LIMIT_MAX)
        })
        .strict()
    )
  })
  .strict()

export const modelOptionViewSchema = z
  .object({ value: z.string(), label: z.string().optional(), efforts: z.array(z.string()) })
  .strict()

export const supplierEntryViewSchema = supplierEntrySchema
  .omit({ models: true, efforts: true })
  .extend({ models: z.array(modelOptionViewSchema), offeredModes: z.array(z.string()) })
  .strict()

export const jevSuggestionViewSchema = jevSuggestionSchema

export const hostRecoveryReportViewSchema = hostRecoveryReportSchema
  .extend({
    state: z.enum(['pending-display', 'shown', 'retrying', 'settled']),
    shownAt: instantSchema.optional(),
    settledAt: instantSchema.optional(),
    retryOutcomes: z
      .array(z.object({ dwarfId: dwarfIdSchema, outcome: z.enum(['resumed', 'failed']) }).strict())
      .optional()
  })
  .strict()

export const hostToastSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('mine-removal-failed'),
      requestId: z.string(),
      mineId: mineIdSchema,
      failed: z.array(dwarfIdSchema)
    })
    .strict(),
  z
    .object({ kind: z.literal('dwarf-stop-failed'), requestId: z.string(), dwarfId: dwarfIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal('stop-all-incomplete'),
      requestId: z.string(),
      ended: z.array(dwarfIdSchema),
      failed: z.array(dwarfIdSchema)
    })
    .strict(),
  z
    .object({
      kind: z.literal('session-crashed'),
      dwarfId: dwarfIdSchema,
      launchId: launchIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('provider-error'),
      providerId: providerIdSchema,
      cause: z.string(),
      dwarfId: dwarfIdSchema.optional()
    })
    .strict()
])

export const preferencesViewSchema = z
  .object({
    preferences: hostPreferencesSchema,
    secrets: z.array(secretStatusSchema),
    secretBackend: secretBackendSchema,
    integrations: z.array(integrationSettingSchema),
    welcome: welcomeStepStateSchema
  })
  .strict()
