import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  activitySummarySchema,
  activityWireSchema,
  askIdSchema,
  askRecordSchema,
  attachmentMetaSchema,
  deliverySchema,
  dwarfNameWireSchema,
  dwarfWireSchema,
  dwarfIdSchema,
  dwarfWorkplaceSchema,
  feedPageRequestSchema,
  feedPageSchema,
  folderPathSchema,
  hostEpochSchema,
  hostPreferencesSchema,
  hostRecoveryReportSchema,
  hostRecoveryReportViewSchema,
  hostToastSchema,
  integrationSettingSchema,
  jevSuggestionSchema,
  jevSuggestionViewSchema,
  launchFailureSchema,
  launchWireSchema,
  launchIdSchema,
  materialAmountSchema,
  messageViewSchema,
  messageIdSchema,
  mineHistoryViewSchema,
  mineIdSchema,
  mineNameWireSchema,
  mineWireSchema,
  OUTCOME_LINE_PART_KINDS,
  outcomeLinePartSchema,
  outcomeLineSchema,
  modelOptionViewSchema,
  permissionPayloadSchema,
  preferencesViewSchema,
  providerIdentitySchema,
  questionPayloadSchema,
  questionStepSchema,
  resetIdSchema,
  secretStatusSchema,
  sessionProfileSchema,
  stopUnavailableReasonSchema,
  stranglerDwarfIdentitySchema,
  supplierEntrySchema,
  supplierEntryViewSchema,
  welcomeStepStateSchema,
  type ActivitySummary,
  type ActivityWire,
  type AskId,
  type AskRecord,
  type AttachmentMeta,
  type Delivery,
  type DwarfId,
  type DwarfNameWire,
  type DwarfWire,
  type DwarfWorkplace,
  type FeedPage,
  type FeedPageRequest,
  type FolderPath,
  type HostEpoch,
  type HostPreferences,
  type HostRecoveryReport,
  type HostRecoveryReportView,
  type HostToast,
  type IntegrationSetting,
  type JevSuggestion,
  type JevSuggestionView,
  type Instant,
  type LaunchFailure,
  type LaunchId,
  type LaunchWire,
  type Material,
  type MaterialAmount,
  type MessageId,
  type MessageView,
  type MineHistoryView,
  type MineId,
  type MineNameWire,
  type MineWire,
  type ModelOptionView,
  type OutcomeLine,
  type OutcomeLinePart,
  type PermissionPayload,
  type PreferencesView,
  type ProviderId,
  type ProviderIdentity,
  type QuestionPayload,
  type QuestionStep,
  type ResetId,
  type SecretStatus,
  type SessionProfile,
  type StopUnavailableReason,
  type StranglerDwarfIdentity,
  type TurnOutcomeKind,
  type SupplierEntry,
  type SupplierEntryView,
  type WelcomeStepState
} from './index'

// ---- samples: one valid payload per schema, typed against the 14 / owner types

const MINE = '01920000-0000-7000-8000-000000000001' as MineId
const DWARF = '01920000-0000-7000-8000-000000000002' as DwarfId
const MESSAGE = '01920000-0000-7000-8000-000000000003' as MessageId
const LAUNCH = '01920000-0000-7000-8000-000000000004' as LaunchId
const EARLIER_LAUNCH = '01920000-0000-7000-8000-000000000005' as LaunchId
const ASK = '01920000-0000-7000-8000-000000000006' as AskId

const MATERIALS = ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium'] as const

const totals = {
  coal: { tokens: 10 },
  bronze: { tokens: 20 },
  copper: { tokens: 0 },
  silver: { tokens: 0 },
  gold: { tokens: 5 },
  uranium: { tokens: 0 }
} satisfies Record<Material, MaterialAmount>

const mineWire = {
  id: MINE,
  path: '/work/alpha' as FolderPath,
  name: 'alpha',
  state: 'active',
  tier: 'gold',
  hasBeenMeasured: true,
  unenterableReason: 'reason',
  mapSite: { xPct: 10, yPct: 20 },
  lastUsedAt: 1,
  totals
} satisfies MineWire

const delivery = {
  messageId: MESSAGE,
  dwarfId: DWARF,
  kind: 'answers-record',
  phase: 'failed',
  heldUntilTurnEnd: false,
  failure: { kind: 'refused', reason: 'ask-closed' },
  attempts: 1,
  phaseAt: 5
} satisfies Delivery

const messageView = {
  id: MESSAGE,
  dwarfId: DWARF,
  role: 'person',
  text: 'hello',
  issuer: { dwarfId: DWARF },
  activity: { steps: 1, summaries: ['read a file'] },
  attachments: [{ name: 'a.png', bytes: 10 }],
  delivery,
  providerTime: null,
  createdAt: 2
} satisfies MessageView

const launchFailure = {
  cause: 'jev-could-not-choose',
  supplierLabel: 'Claude',
  jevReason: 'low-confidence',
  reasonSentence: 'sentence',
  actions: ['pick-manually'],
  toolOutputTail: 'tail'
} satisfies LaunchFailure

const launchWire = {
  launchId: LAUNCH,
  mineId: MINE,
  state: 'failed',
  wayKind: 'supplier',
  providerId: 'claude',
  model: 'model',
  effort: 'high',
  dwarfId: DWARF,
  retryOf: EARLIER_LAUNCH,
  picks: { providerId: 'codex', model: 'model', effort: 'low' },
  failure: launchFailure,
  requestedAt: 3
} satisfies LaunchWire

const activityWire = {
  dwarfId: DWARF,
  disclosureId: 'disclosure-1',
  open: true,
  stepCount: 2,
  summaries: ['one', 'two']
} satisfies ActivityWire

const feedPageRequest = { before: MESSAGE, limit: 50 } satisfies FeedPageRequest
const feedPage = { dwarfId: DWARF, messages: [messageView], reachedStart: false } satisfies FeedPage
const mineHistoryView = {
  mineId: MINE,
  speakers: [{ dwarfId: DWARF, displayName: 'Borin', departed: false, messages: [messageView] }]
} satisfies MineHistoryView

const modelOptionView = {
  value: 'model',
  label: 'Model',
  efforts: ['low', 'high']
} satisfies ModelOptionView
const supplierEntry = {
  providerId: 'claude',
  label: 'Claude',
  models: ['model'],
  efforts: ['low'],
  permissionModes: ['default'],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'gated-off',
  gatingIntegration: 'claude-hooks'
} satisfies SupplierEntry
const supplierEntryView = {
  providerId: 'claude',
  label: 'Claude',
  permissionModes: ['default'],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'gated-off',
  gatingIntegration: 'claude-hooks',
  models: [modelOptionView],
  offeredModes: ['default']
} satisfies SupplierEntryView

const hostRecoveryReport = {
  hostEpoch: 'epoch-1',
  at: 4,
  resumed: [DWARF],
  unrecovered: [{ dwarfId: DWARF, reason: 'turn-lost', messageIds: [MESSAGE] }]
} satisfies HostRecoveryReport
const hostRecoveryReportView = {
  ...hostRecoveryReport,
  state: 'shown',
  shownAt: 5,
  settledAt: 6,
  retryOutcomes: [{ dwarfId: DWARF, outcome: 'resumed' }]
} satisfies HostRecoveryReportView

const hostToasts = [
  { kind: 'mine-removal-failed', requestId: 'r1', mineId: MINE, failed: [DWARF] },
  { kind: 'dwarf-stop-failed', requestId: 'r2', dwarfId: DWARF },
  { kind: 'stop-all-incomplete', requestId: 'r3', ended: [DWARF], failed: [] },
  { kind: 'session-crashed', dwarfId: DWARF, launchId: LAUNCH },
  { kind: 'provider-error', providerId: 'opencode', cause: 'cause', dwarfId: DWARF }
] satisfies HostToast[]

const hostPreferences = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  defaultProvider: 'claude',
  defaultModel: 'model',
  defaultEffort: 'high',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
} satisfies HostPreferences
const integrationSetting = {
  id: 'opencode-permissions',
  state: 'on-verified',
  consentOrigin: 'add-panel',
  changedAt: 7
} satisfies IntegrationSetting
const welcomeStepState = {
  due: true,
  reason: 'first-run',
  legacyFound: [],
  offered: ['claude-hooks', 'opencode-permissions']
} satisfies WelcomeStepState
const secretStatus = { name: 'jev-key', configured: true } satisfies SecretStatus
const preferencesView = {
  preferences: hostPreferences,
  secrets: [secretStatus],
  secretBackend: 'os-secret-store',
  integrations: [integrationSetting],
  welcome: welcomeStepState
} satisfies PreferencesView

const providerIdentity = {
  providerId: 'claude',
  providerSessionId: 'session-1',
  providerAgentId: 'agent-1'
} satisfies ProviderIdentity
const stranglerDwarfIdentity = {
  dwarfId: DWARF,
  providerId: 'claude',
  identity: providerIdentity
} satisfies StranglerDwarfIdentity

const questionStep = {
  text: 'Which one?',
  options: ['a', 'b'],
  allowsFreeText: true
} satisfies QuestionStep
const questionAsk = {
  id: ASK,
  dwarfId: DWARF,
  kind: 'question',
  channel: 'driver',
  providerRequestId: 'request-1',
  payload: { steps: [questionStep] },
  currentStep: 0,
  state: 'answered-in-app',
  reannounce: true,
  openedAt: 1,
  closedAt: 2
} satisfies AskRecord
const permissionAsk = {
  ...questionAsk,
  kind: 'permission',
  channel: 'hook-keystroke',
  payload: { toolName: 'Bash', requestText: 'run a command' },
  state: 'open'
} satisfies AskRecord

const sessionProfile = {
  providerId: 'claude',
  model: 'model',
  effort: 'high',
  permissionMode: 'default'
} satisfies SessionProfile
const dwarfWorkplace = {
  path: '/work/alpha-tree' as FolderPath,
  branch: 'main'
} satisfies DwarfWorkplace
const outcomeLine = {
  dwarfId: DWARF,
  kind: 'capped',
  stepCount: 5,
  parts: [
    { kind: 'steps', n: 5 },
    { kind: 'idle-since', at: 100 }
  ],
  detail: 'max_tokens',
  closingWords: 'Stopped here.',
  reliability: 'reliable',
  at: 90
} satisfies OutcomeLine

const dwarfWire = {
  id: DWARF,
  mineId: MINE,
  providerId: 'claude',
  baseName: 'Borin',
  customName: null,
  rank: 'foreman',
  parentDwarfId: null,
  delegated: false,
  sessionProfile,
  presence: 'present',
  processState: 'running',
  status: 'idle',
  needsYou: false,
  askedAt: 3,
  canReceiveMessages: true,
  stopInFlight: false,
  stopUnavailableReason: null,
  owned: true,
  workplace: dwarfWorkplace,
  outcome: outcomeLine,
  arrivedAt: 1
} satisfies DwarfWire

const jevSuggestion = {
  providerId: 'claude',
  model: 'model',
  effort: 'high',
  tier: 'frontier',
  confidence: { providerId: 0.91, model: 0.74, tier: 0.88 },
  truncated: false,
  parts: { providerId: 'answered', model: 'answered', effort: 'safe-default', tier: 'answered' },
  fallback: 'effort-ceiling'
} satisfies JevSuggestionView

const attachmentMeta = { name: 'a.png', bytes: 10 } satisfies AttachmentMeta
const activitySummary = { steps: 2, summaries: ['one', 'two'] } satisfies ActivitySummary

/** Every object-shaped wire schema with one valid payload. */
const objectCases: Array<[string, z.ZodTypeAny, Record<string, unknown>]> = [
  ['MineWire', mineWireSchema, mineWire],
  ['DwarfWire', dwarfWireSchema, dwarfWire],
  ['ActivityWire', activityWireSchema, activityWire],
  ['LaunchWire', launchWireSchema, launchWire],
  ['FeedPageRequest', feedPageRequestSchema, feedPageRequest],
  ['FeedPage', feedPageSchema, feedPage],
  ['MineHistoryView', mineHistoryViewSchema, mineHistoryView],
  ['ModelOptionView', modelOptionViewSchema, modelOptionView],
  ['SupplierEntryView', supplierEntryViewSchema, supplierEntryView],
  ['JevSuggestionView', jevSuggestionViewSchema, jevSuggestion],
  ['HostRecoveryReportView', hostRecoveryReportViewSchema, hostRecoveryReportView],
  ...hostToasts.map((toast): [string, z.ZodTypeAny, Record<string, unknown>] => [
    `HostToast ${toast.kind}`,
    hostToastSchema,
    toast
  ]),
  ['PreferencesView', preferencesViewSchema, preferencesView],
  ['MineNameWire', mineNameWireSchema, { id: MINE, name: 'alpha' } satisfies MineNameWire],
  [
    'DwarfNameWire',
    dwarfNameWireSchema,
    { id: DWARF, mineId: MINE, displayName: 'Borin' } satisfies DwarfNameWire
  ],
  ['StranglerDwarfIdentity', stranglerDwarfIdentitySchema, stranglerDwarfIdentity],
  // imported types (14 §3 intro)
  ['MaterialAmount', materialAmountSchema, totals.coal],
  ['Delivery', deliverySchema, delivery],
  ['MessageView', messageViewSchema, messageView],
  ['AttachmentMeta', attachmentMetaSchema, attachmentMeta],
  ['ActivitySummary', activitySummarySchema, activitySummary],
  ['LaunchFailure', launchFailureSchema, launchFailure],
  ['HostRecoveryReport', hostRecoveryReportSchema, hostRecoveryReport],
  ['AskRecord question', askRecordSchema, questionAsk],
  ['AskRecord permission', askRecordSchema, permissionAsk],
  ['QuestionStep', questionStepSchema, questionStep],
  ['QuestionPayload', questionPayloadSchema, questionAsk.payload],
  ['PermissionPayload', permissionPayloadSchema, permissionAsk.payload],
  ['SupplierEntry', supplierEntrySchema, supplierEntry],
  ['HostPreferences', hostPreferencesSchema, hostPreferences],
  ['IntegrationSetting', integrationSettingSchema, integrationSetting],
  ['WelcomeStepState', welcomeStepStateSchema, welcomeStepState],
  ['SecretStatus', secretStatusSchema, secretStatus],
  ['ProviderIdentity', providerIdentitySchema, providerIdentity],
  ['SessionProfile', sessionProfileSchema, sessionProfile],
  ['DwarfWorkplace', dwarfWorkplaceSchema, dwarfWorkplace],
  ['OutcomeLine', outcomeLineSchema, outcomeLine],
  ...outcomeLine.parts.map((part): [string, z.ZodTypeAny, Record<string, unknown>] => [
    `OutcomeLinePart ${part.kind}`,
    outcomeLinePartSchema,
    part
  ]),
  ['JevSuggestion', jevSuggestionSchema, jevSuggestion]
]

/** Nested objects are strict too: an extra key one level down is refused. */
const nestedExtraKeyCases: Array<[string, z.ZodTypeAny, unknown]> = [
  ['MineWire.mapSite', mineWireSchema, { ...mineWire, mapSite: { xPct: 1, yPct: 2, zPct: 3 } }],
  ['LaunchWire.picks', launchWireSchema, { ...launchWire, picks: { model: 'm', prompt: 'p' } }],
  ['LaunchWire.failure', launchWireSchema, { ...launchWire, failure: { ...launchFailure, x: 1 } }],
  ['MessageView.issuer', messageViewSchema, { ...messageView, issuer: { dwarfId: DWARF, x: 1 } }],
  ['MessageView.delivery', messageViewSchema, { ...messageView, delivery: { ...delivery, x: 1 } }],
  [
    'Delivery.failure',
    deliverySchema,
    { ...delivery, failure: { kind: 'session-closed', reason: 'r' } }
  ],
  [
    'MineHistoryView.speakers[]',
    mineHistoryViewSchema,
    { ...mineHistoryView, speakers: [{ ...mineHistoryView.speakers[0], x: 1 }] }
  ],
  [
    'HostRecoveryReportView.unrecovered[]',
    hostRecoveryReportViewSchema,
    { ...hostRecoveryReportView, unrecovered: [{ dwarfId: DWARF, reason: 'no-resume', x: 1 }] }
  ],
  [
    'StranglerDwarfIdentity.identity',
    stranglerDwarfIdentitySchema,
    { ...stranglerDwarfIdentity, identity: { ...providerIdentity, pid: 1 } }
  ],
  [
    'AskRecord.payload',
    askRecordSchema,
    { ...questionAsk, payload: { steps: [questionStep], toolName: 'Bash' } }
  ],
  [
    'PreferencesView.preferences',
    preferencesViewSchema,
    { ...preferencesView, preferences: { ...hostPreferences, x: 1 } }
  ],
  ['DwarfWire.outcome', dwarfWireSchema, { ...dwarfWire, outcome: { ...outcomeLine, x: 1 } }],
  [
    'DwarfWire.sessionProfile',
    dwarfWireSchema,
    { ...dwarfWire, sessionProfile: { ...sessionProfile, x: 1 } }
  ],
  [
    'OutcomeLine.parts[]',
    outcomeLineSchema,
    { ...outcomeLine, parts: [{ kind: 'steps', n: 1, x: 1 }] }
  ],
  [
    'JevSuggestion.confidence',
    jevSuggestionViewSchema,
    { ...jevSuggestion, confidence: { model: 0.5, permissionMode: 0.5 } }
  ],
  [
    'JevSuggestion.parts',
    jevSuggestionViewSchema,
    { ...jevSuggestion, parts: { model: 'answered', permissionMode: 'answered' } }
  ]
]

describe('wire view types (14 §3.6)', () => {
  it('[ADR-019] every view schema is strict and refuses extra keys and wrong types', () => {
    for (const [name, schema, sample] of objectCases) {
      expect(schema.safeParse(sample).success, `${name} accepts its sample`).toBe(true)
      expect(
        schema.safeParse({ ...sample, extra: 1 }).success,
        `${name} refuses an extra key`
      ).toBe(false)
      for (const key of Object.keys(sample)) {
        const wrong = { ...sample, [key]: Symbol('wrong type') }
        expect(schema.safeParse(wrong).success, `${name}.${key} refuses a wrong type`).toBe(false)
      }
    }
    for (const [name, schema, payload] of nestedExtraKeyCases) {
      expect(schema.safeParse(payload).success, `${name} refuses an extra key`).toBe(false)
    }
    // Closed unions refuse an unknown value; wire ids are UUIDv7 (14 §3 intro).
    expect(stopUnavailableReasonSchema.safeParse('already-stopping').success).toBe(true)
    expect(stopUnavailableReasonSchema.safeParse('turn-open').success).toBe(false)
    expect(mineWireSchema.safeParse({ ...mineWire, state: 'removed' }).success).toBe(false)
    expect(hostToastSchema.safeParse({ kind: 'unknown', requestId: 'r' }).success).toBe(false)
    expect(mineWireSchema.safeParse({ ...mineWire, id: 'mine-1' }).success).toBe(false)
    const uuidV4 = '01920000-0000-4000-8000-000000000001'
    expect(mineWireSchema.safeParse({ ...mineWire, id: uuidV4 }).success).toBe(false)
    expect(askRecordSchema.safeParse({ ...questionAsk, dwarfId: 'dwarf-1' }).success).toBe(false)
    // HostEpoch is a plain string (06 §0.1; ADR-003 `HelloOk.epoch: string`), not a UUIDv7 id.
    expect(hostEpochSchema.safeParse('boot-epoch-1').success).toBe(true)
    expect(hostEpochSchema.safeParse(1).success).toBe(false)
    expect(feedPageRequestSchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(
      launchFailureSchema.safeParse({ ...launchFailure, toolOutputTail: 'x'.repeat(401) }).success
    ).toBe(false)
  })

  it('[INV-93] MineWire totals carry the six materials separately and never a summed total', () => {
    const parsed = mineWireSchema.safeParse(mineWire)
    expect(parsed.success).toBe(true)
    expect(Object.keys(parsed.data?.totals ?? {}).sort()).toEqual([...MATERIALS].sort())

    // No summed total, neither beside the materials nor instead of them.
    expect(
      mineWireSchema.safeParse({ ...mineWire, totals: { ...totals, total: { tokens: 35 } } })
        .success
    ).toBe(false)
    expect(mineWireSchema.safeParse({ ...mineWire, total: 35 }).success).toBe(false)
    expect(mineWireSchema.safeParse({ ...mineWire, totals: 35 }).success).toBe(false)
    // Each material is carried separately: none may be left out.
    for (const material of MATERIALS) {
      const withoutOne = Object.fromEntries(
        Object.entries(totals).filter(([key]) => key !== material)
      )
      expect(
        mineWireSchema.safeParse({ ...mineWire, totals: withoutOne }).success,
        `totals without ${material}`
      ).toBe(false)
    }
    // A MaterialAmount is a non-negative integer token count.
    for (const tokens of [-1, 1.5]) {
      expect(
        mineWireSchema.safeParse({ ...mineWire, totals: { ...totals, gold: { tokens } } }).success
      ).toBe(false)
    }

    expectTypeOf<keyof MineWire['totals']>().toEqualTypeOf<Material>()
    expectTypeOf<(typeof MATERIALS)[number]>().toEqualTypeOf<Material>()
    expectTypeOf<MineWire['totals'][Material]>().toEqualTypeOf<MaterialAmount>()
  })

  it('[ADR-015] StranglerDwarfIdentity is built only from DwarfId, ProviderId and ProviderIdentity', () => {
    const parsed = stranglerDwarfIdentitySchema.safeParse(stranglerDwarfIdentity)
    expect(parsed.success).toBe(true)
    expect(Object.keys(parsed.data ?? {}).sort()).toEqual(['dwarfId', 'identity', 'providerId'])

    // No new field (AMENDMENT-8): no process id, no name, nothing beside the three imported names.
    for (const extra of [{ pid: 1234 }, { customName: 'Borin' }, { mineId: MINE }]) {
      expect(
        stranglerDwarfIdentitySchema.safeParse({ ...stranglerDwarfIdentity, ...extra }).success
      ).toBe(false)
    }
    // dwarfId is the DwarfAI UUID, never the provider's session id (ADR-015 item 7).
    expect(
      stranglerDwarfIdentitySchema.safeParse({ ...stranglerDwarfIdentity, dwarfId: 'session-1' })
        .success
    ).toBe(false)
    // identity is ProviderIdentity: providerSessionId required, providerAgentId optional.
    const { providerAgentId, ...withoutAgent } = providerIdentity
    expect(providerAgentId).toBe('agent-1')
    expect(
      stranglerDwarfIdentitySchema.safeParse({ ...stranglerDwarfIdentity, identity: withoutAgent })
        .success
    ).toBe(true)
    expect(
      stranglerDwarfIdentitySchema.safeParse({
        ...stranglerDwarfIdentity,
        identity: { providerId: 'claude' }
      }).success
    ).toBe(false)

    expectTypeOf<keyof StranglerDwarfIdentity>().toEqualTypeOf<
      'dwarfId' | 'providerId' | 'identity'
    >()
    expectTypeOf<StranglerDwarfIdentity['dwarfId']>().toEqualTypeOf<DwarfId>()
    expectTypeOf<StranglerDwarfIdentity['providerId']>().toEqualTypeOf<ProviderId>()
    expectTypeOf<StranglerDwarfIdentity['identity']>().toEqualTypeOf<ProviderIdentity>()
  })

  it('[ADR-032] DwarfWire carries no StatusFacts and no process ids', () => {
    const parsed = dwarfWireSchema.safeParse(dwarfWire)
    expect(parsed.success).toBe(true)
    // Exactly the 14 §3.6 fields.
    expect(Object.keys(parsed.data ?? {}).sort()).toEqual(Object.keys(dwarfWire).sort())

    const statusFacts = {
      processState: 'running',
      turn: { state: 'ended', endedAt: 5, reliability: 'reliable' },
      lastActivityAt: 5
    }
    const processIdentity = { pid: 4242, processStartTimeMs: 1, bootId: 'boot-1' }
    for (const extra of [
      { facts: statusFacts }, // the Host's internal StatusFacts (ADR-032 D1)
      { process: processIdentity }, // ProcessIdentity (ADR-014 item 1)
      { pid: 4242 },
      { processStartTimeMs: 1 },
      { identity: providerIdentity } // the provider's own ids stay in the Host (ADR-015 item 7)
    ]) {
      expect(
        dwarfWireSchema.safeParse({ ...dwarfWire, ...extra }).success,
        `DwarfWire refuses ${Object.keys(extra)[0]}`
      ).toBe(false)
    }
    // The status is the Host's product status, never a legacy or UI-derived value.
    expect(dwarfWireSchema.safeParse({ ...dwarfWire, status: 'leaving' }).success).toBe(false)

    expectTypeOf<
      Extract<keyof DwarfWire, 'facts' | 'process' | 'pid' | 'processStartTimeMs' | 'identity'>
    >().toEqualTypeOf<never>()
  })

  it('[ADR-019] OutcomeLine parts are at most three structured parts of the kinds this version knows', () => {
    expect([...OUTCOME_LINE_PART_KINDS]).toEqual([
      'steps',
      'steps-so-far',
      'waiting-questions',
      'waiting-permission',
      'answers-received',
      'reading-your-message',
      'idle-since'
    ])
    const onePerKind: OutcomeLinePart[] = [
      { kind: 'steps', n: 1 },
      { kind: 'steps-so-far', n: 3 },
      { kind: 'waiting-questions', n: 2 },
      { kind: 'waiting-permission' },
      { kind: 'answers-received' },
      { kind: 'reading-your-message' },
      { kind: 'idle-since', at: 100 }
    ]
    for (const part of onePerKind) {
      expect(outcomeLinePartSchema.safeParse(part).success, `part ${part.kind}`).toBe(true)
    }
    const line = (patch: Record<string, unknown>) =>
      outcomeLineSchema.safeParse({ ...outcomeLine, ...patch }).success

    // Parts are structured, never pre-worded strings, and only the known kinds.
    expect(line({ parts: ['Turn finished · 5 steps'] })).toBe(false)
    expect(line({ parts: [{ kind: 'celebrating' }] })).toBe(false)
    // Each kind carries exactly its own value.
    expect(line({ parts: [{ kind: 'idle-since' }] })).toBe(false)
    expect(line({ parts: [{ kind: 'idle-since', at: 'yesterday' }] })).toBe(false)
    expect(line({ parts: [{ kind: 'steps' }] })).toBe(false)
    expect(line({ parts: [{ kind: 'waiting-permission', n: 1 }] })).toBe(false)
    // A count part exists only from one on (US-MSG-011.AC13/AC14 leave the count out otherwise).
    for (const n of [0, -1, 1.5]) {
      expect(line({ parts: [{ kind: 'steps-so-far', n }] }), `n = ${n}`).toBe(false)
    }
    // At most three parts.
    expect(line({ parts: onePerKind.slice(0, 3) })).toBe(true)
    expect(line({ parts: onePerKind.slice(0, 4) })).toBe(false)
    expect(line({ parts: [] })).toBe(true)
    // The six outcome kinds and nothing else; closing words trimmed to 200 characters.
    for (const kind of [
      'working',
      'concluded',
      'capped',
      'errored',
      'interrupted',
      'waiting-on-you'
    ]) {
      expect(line({ kind }), `kind ${kind}`).toBe(true)
    }
    expect(line({ kind: 'done' })).toBe(false)
    expect(line({ reliability: 'guessed' })).toBe(false)
    expect(line({ closingWords: 'x'.repeat(200) })).toBe(true)
    expect(line({ closingWords: 'x'.repeat(201) })).toBe(false)

    expectTypeOf<OutcomeLinePart>().toEqualTypeOf<
      | { kind: 'steps'; n: number }
      | { kind: 'steps-so-far'; n: number }
      | { kind: 'waiting-questions'; n: number }
      | { kind: 'waiting-permission' }
      | { kind: 'answers-received' }
      | { kind: 'reading-your-message' }
      | { kind: 'idle-since'; at: Instant }
    >()
    expectTypeOf<(typeof OUTCOME_LINE_PART_KINDS)[number]>().toEqualTypeOf<
      OutcomeLinePart['kind']
    >()
    expectTypeOf<TurnOutcomeKind>().toEqualTypeOf<
      'working' | 'concluded' | 'capped' | 'errored' | 'interrupted' | 'waiting-on-you'
    >()
  })

  it('[ADR-019] JevSuggestionView carries the pick with per-part confidence and origin, and no permission mode or reason', () => {
    const view = (patch: Record<string, unknown>) =>
      jevSuggestionViewSchema.safeParse({ ...jevSuggestion, ...patch }).success

    // A decision that left parts out carries only what it answered (US-LAUNCH-003.AC03).
    expect(
      jevSuggestionViewSchema.safeParse({ confidence: {}, truncated: false, parts: {} }).success
    ).toBe(true)
    // No permission mode, no reason sentence, no fallback supplier (06 §12).
    expect(view({ permissionMode: 'default' })).toBe(false)
    expect(view({ reasonSentence: 'Because.' })).toBe(false)
    expect(view({ fallbackProvider: 'codex' })).toBe(false)
    // Confidence is a fraction per part, shown as a percentage by the tooltip (US-LAUNCH-008).
    for (const value of [-0.01, 1.01]) {
      expect(view({ confidence: { model: value } }), `confidence ${value}`).toBe(false)
    }
    expect(view({ confidence: { model: 0, tier: 1 } })).toBe(true)
    // A part is answered or fell back to a safe value, nothing else.
    expect(view({ parts: { model: 'guessed' } })).toBe(false)
    // Jev's model tier is never a mine's ore tier.
    expect(view({ tier: 'gold' })).toBe(false)
    expect(view({ tier: 'special-purpose' })).toBe(false)
    expect(view({ fallback: 'no-reason-at-all' })).toBe(false)
    // truncated is required: the tooltip reads it on every suggestion.
    const { truncated, ...withoutTruncated } = jevSuggestion
    expect(truncated).toBe(false)
    expect(jevSuggestionViewSchema.safeParse(withoutTruncated).success).toBe(false)

    expectTypeOf<JevSuggestionView>().toEqualTypeOf<JevSuggestion>()
    expectTypeOf<keyof JevSuggestion['confidence']>().toEqualTypeOf<keyof JevSuggestion['parts']>()
  })

  it('[ADR-019] each zod-inferred view type equals its 14 §3.6 TypeScript type', () => {
    // Enforced by `pnpm typecheck`: a drift between a schema and its 14 / owner type fails compilation here.
    // ids and scalars as 06 §0.1 defines them: branded only where the owner says "branded".
    expectTypeOf<z.infer<typeof hostEpochSchema>>().toEqualTypeOf<HostEpoch>()
    expectTypeOf<HostEpoch>().toEqualTypeOf<string>()
    expectTypeOf<ProviderId>().toEqualTypeOf<string>()
    expectTypeOf<Instant>().toEqualTypeOf<number>()
    expectTypeOf<z.infer<typeof mineIdSchema>>().toEqualTypeOf<MineId>()
    expectTypeOf<z.infer<typeof dwarfIdSchema>>().toEqualTypeOf<DwarfId>()
    expectTypeOf<z.infer<typeof askIdSchema>>().toEqualTypeOf<AskId>()
    expectTypeOf<z.infer<typeof messageIdSchema>>().toEqualTypeOf<MessageId>()
    expectTypeOf<z.infer<typeof launchIdSchema>>().toEqualTypeOf<LaunchId>()
    expectTypeOf<z.infer<typeof resetIdSchema>>().toEqualTypeOf<ResetId>()
    expectTypeOf<z.infer<typeof folderPathSchema>>().toEqualTypeOf<FolderPath>()
    expectTypeOf<MineId>().not.toEqualTypeOf<string>()
    expectTypeOf<FolderPath>().not.toEqualTypeOf<string>()
    expectTypeOf<z.infer<typeof mineWireSchema>>().toEqualTypeOf<MineWire>()
    expectTypeOf<z.infer<typeof dwarfWireSchema>>().toEqualTypeOf<DwarfWire>()
    expectTypeOf<z.infer<typeof jevSuggestionViewSchema>>().toEqualTypeOf<JevSuggestionView>()
    expectTypeOf<z.infer<typeof jevSuggestionSchema>>().toEqualTypeOf<JevSuggestion>()
    expectTypeOf<z.infer<typeof outcomeLineSchema>>().toEqualTypeOf<OutcomeLine>()
    expectTypeOf<
      z.infer<typeof stopUnavailableReasonSchema>
    >().toEqualTypeOf<StopUnavailableReason>()
    expectTypeOf<z.infer<typeof activityWireSchema>>().toEqualTypeOf<ActivityWire>()
    expectTypeOf<z.infer<typeof launchWireSchema>>().toEqualTypeOf<LaunchWire>()
    expectTypeOf<z.infer<typeof feedPageRequestSchema>>().toEqualTypeOf<FeedPageRequest>()
    expectTypeOf<z.infer<typeof feedPageSchema>>().toEqualTypeOf<FeedPage>()
    expectTypeOf<z.infer<typeof mineHistoryViewSchema>>().toEqualTypeOf<MineHistoryView>()
    expectTypeOf<z.infer<typeof modelOptionViewSchema>>().toEqualTypeOf<ModelOptionView>()
    expectTypeOf<z.infer<typeof supplierEntryViewSchema>>().toEqualTypeOf<SupplierEntryView>()
    expectTypeOf<
      z.infer<typeof hostRecoveryReportViewSchema>
    >().toEqualTypeOf<HostRecoveryReportView>()
    expectTypeOf<z.infer<typeof hostToastSchema>>().toEqualTypeOf<HostToast>()
    expectTypeOf<z.infer<typeof preferencesViewSchema>>().toEqualTypeOf<PreferencesView>()
    expectTypeOf<z.infer<typeof mineNameWireSchema>>().toEqualTypeOf<MineNameWire>()
    expectTypeOf<z.infer<typeof dwarfNameWireSchema>>().toEqualTypeOf<DwarfNameWire>()
    expectTypeOf<
      z.infer<typeof stranglerDwarfIdentitySchema>
    >().toEqualTypeOf<StranglerDwarfIdentity>()
    // imported types
    expectTypeOf<z.infer<typeof materialAmountSchema>>().toEqualTypeOf<MaterialAmount>()
    expectTypeOf<z.infer<typeof deliverySchema>>().toEqualTypeOf<Delivery>()
    expectTypeOf<z.infer<typeof messageViewSchema>>().toEqualTypeOf<MessageView>()
    expectTypeOf<z.infer<typeof attachmentMetaSchema>>().toEqualTypeOf<AttachmentMeta>()
    expectTypeOf<z.infer<typeof activitySummarySchema>>().toEqualTypeOf<ActivitySummary>()
    expectTypeOf<z.infer<typeof launchFailureSchema>>().toEqualTypeOf<LaunchFailure>()
    expectTypeOf<z.infer<typeof hostRecoveryReportSchema>>().toEqualTypeOf<HostRecoveryReport>()
    expectTypeOf<z.infer<typeof askRecordSchema>>().toEqualTypeOf<AskRecord>()
    expectTypeOf<z.infer<typeof questionStepSchema>>().toEqualTypeOf<QuestionStep>()
    expectTypeOf<z.infer<typeof questionPayloadSchema>>().toEqualTypeOf<QuestionPayload>()
    expectTypeOf<z.infer<typeof permissionPayloadSchema>>().toEqualTypeOf<PermissionPayload>()
    expectTypeOf<z.infer<typeof supplierEntrySchema>>().toEqualTypeOf<SupplierEntry>()
    expectTypeOf<z.infer<typeof hostPreferencesSchema>>().toEqualTypeOf<HostPreferences>()
    expectTypeOf<z.infer<typeof integrationSettingSchema>>().toEqualTypeOf<IntegrationSetting>()
    expectTypeOf<z.infer<typeof welcomeStepStateSchema>>().toEqualTypeOf<WelcomeStepState>()
    expectTypeOf<z.infer<typeof secretStatusSchema>>().toEqualTypeOf<SecretStatus>()
    expectTypeOf<z.infer<typeof providerIdentitySchema>>().toEqualTypeOf<ProviderIdentity>()
    expectTypeOf<z.infer<typeof sessionProfileSchema>>().toEqualTypeOf<SessionProfile>()
    expectTypeOf<z.infer<typeof dwarfWorkplaceSchema>>().toEqualTypeOf<DwarfWorkplace>()
  })
})
