// Seam-B params and results of `preferences.*` that host-placed seam A rows relay unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import { CATALOG_PROVIDER_IDS } from '../../catalog'
import {
  consentOriginSchema,
  integrationStateSchema,
  jevRoutingProfileSchema,
  providerIdSchema,
  welcomeStepStateSchema,
  type ConsentOrigin,
  type HostPreferences,
  type IntegrationId,
  type IntegrationState,
  type WelcomeStepState
} from '../../wire'
import { outcomeSchema, type Outcome } from '../errors'
import { requestIdSchema } from '../requestId'

// As ADR-023 item 5 writes them. ResetMetricsCommand is validated in main and Host (ADR-019).
export interface ResetMetricsCommand {
  confirmed: 'yes'
}
export type MetricsResetResult =
  | { outcome: 'reset'; epoch: number }
  | { outcome: 'failed'; reason: string; resumesOnNextStart: boolean }
export type ResetStep =
  'begun' | 'db' | 'secrets' | 'external-config' | 'ui-prefs' | 'install-moment' | 'done'

// As 16 §4.12 writes them (names, members and comments; layout by prettier); 14 §3.4 imports them from 05,
// never restated (AMENDMENT-7)
export interface WelcomeChoice {
  claudeHooks: boolean
  openCodePermissions: boolean
} // AMENDMENT-7: the ticks at "Activate" (both pre-selected); "Not now" = both false
export type WelcomeResult = Record<
  IntegrationId,
  { state: IntegrationState; failure?: 'config-write-failed' | 'config-revert-failed' }
> // AMENDMENT-7: per integration, after its write or revert settled

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): preferences, B-M13
export type PreferenceSetParams = {
  [K in HostPreferenceKey]: { key: K; value: HostPreferences[K]; requestId: string }
}[HostPreferenceKey]
export type HostPreferenceKey =
  // writable keys (openCodePermissionsOn is derived, 06)
  | 'subagentDelegationOn'
  | 'routingProfile'
  | 'defaultProvider'
  | 'defaultModel'
  | 'defaultEffort'
  | 'systemNotificationsOn'

/** A default provider is a catalog provider: never "Other…" (06 §14.2, PO #36), never another string. */
const defaultProviderSchema = providerIdSchema.refine(
  (id) => (CATALOG_PROVIDER_IDS as readonly string[]).includes(id),
  { message: 'a default provider is a catalog provider' }
)

/**
 * A key whose value may be absent ("None"): JSON carries no `undefined`, so the value is left out
 * on the wire, and the parsed params name it as `value: undefined`, as `HostPreferences[K]` does.
 */
function withValueKey<P extends { key: string; value?: string; requestId: string }>(params: P) {
  return { key: params.key as P['key'], value: params.value, requestId: params.requestId }
}

/**
 * B-M13 `preferences.set` params: exactly one writable key (`openCodePermissionsOn` is derived and
 * a secret is never a preference, ADR-017), its value of the 06 §14.2 type, and a UUIDv7
 * `requestId` (14 §1.6). `defaultProvider` is a catalog provider id or absent ("None").
 */
export const preferenceSetParamsSchema = z.union([
  z
    .object({
      key: z.literal('subagentDelegationOn'),
      value: z.boolean(),
      requestId: requestIdSchema
    })
    .strict(),
  z
    .object({
      key: z.literal('routingProfile'),
      value: jevRoutingProfileSchema,
      requestId: requestIdSchema
    })
    .strict(),
  z
    .object({
      key: z.literal('defaultProvider'),
      value: defaultProviderSchema.optional(),
      requestId: requestIdSchema
    })
    .strict()
    .transform(withValueKey),
  z
    .object({
      key: z.literal('defaultModel'),
      value: z.string().optional(),
      requestId: requestIdSchema
    })
    .strict()
    .transform(withValueKey),
  z
    .object({
      key: z.literal('defaultEffort'),
      value: z.string().optional(),
      requestId: requestIdSchema
    })
    .strict()
    .transform(withValueKey),
  z
    .object({
      key: z.literal('systemNotificationsOn'),
      value: z.boolean(),
      requestId: requestIdSchema
    })
    .strict()
])

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): preferences
export interface SetOpenCodePermissionsParams {
  on: boolean
  origin: ConsentOrigin
  requestId: string
}
// revert failed: option stays on (16 §7.4)
export type SetOpenCodePermissionsResult = Outcome<
  { state: IntegrationState },
  'config-write-failed' | 'config-revert-failed'
>
// AMENDMENT-7 (OQ-68): Settings only; the Host records origin 'settings'
export interface SetClaudeHooksParams {
  on: boolean
  requestId: string
}
// = SetOpenCodePermissionsResult; revert failed: option stays on
export type SetClaudeHooksResult = Outcome<
  { state: IntegrationState },
  'config-write-failed' | 'config-revert-failed'
>
// AMENDMENT-7: { claudeHooks, openCodePermissions } = the ticks at "Activate"; both false = "Not now"
export interface AnswerWelcomeParams extends WelcomeChoice {
  requestId: string
}
// AMENDMENT-7: per-integration outcome; welcome.due false once answered
export interface AnswerWelcomeResult {
  integrations: WelcomeResult
  welcome: WelcomeStepState
}
// ResetMetricsCommand = { confirmed: 'yes' }
export interface ResetMetricsParams extends ResetMetricsCommand {
  requestId: string
}

/** B-M15 `preferences.resetMetrics` params; A-33's request is this same object (14 §1.2). */
export const resetMetricsParamsSchema = z
  .object({ confirmed: z.literal('yes'), requestId: requestIdSchema })
  .strict()

export const metricsResetResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('reset'), epoch: z.number() }).strict(),
  z
    .object({ outcome: z.literal('failed'), reason: z.string(), resumesOnNextStart: z.boolean() })
    .strict()
])

/** ADR-023 item 5 `ResetStep`: the saga's steps in their order (07 machine 13). */
export const resetStepSchema = z.enum([
  'begun',
  'db',
  'secrets',
  'external-config',
  'ui-prefs',
  'install-moment',
  'done'
])

/** A reset epoch carried by a frame or an ack: `app_meta.reset_epoch` after a reset, so ≥ 1 (09 §4.1). */
export const resetEpochSchema = z.number().int().positive()

/**
 * B-M14 `preferences.setOpenCodePermissions` params; A-53's request is this same object (14 §1.2). `origin`
 * 'first-run' is refused here: only `answerWelcome` carries it (14 §3.4, AMENDMENT-7).
 */
export const setOpenCodePermissionsParamsSchema = z
  .object({
    on: z.boolean(),
    origin: consentOriginSchema.refine((origin): boolean => origin !== 'first-run', {
      message: "origin 'first-run' is carried only by answerWelcome"
    }),
    requestId: requestIdSchema
  })
  .strict()

export const setOpenCodePermissionsResultSchema = outcomeSchema(
  z.object({ state: integrationStateSchema }).strict(),
  z.enum(['config-write-failed', 'config-revert-failed'])
)

/**
 * B-M39 `preferences.setClaudeHooks` params (14 §3.4; AMENDMENT-7, OQ-68); A-N31's request is this same
 * object (14 §1.2). It carries no origin: the toggle is in Settings only and the Host records `settings`, so
 * an `origin` key is refused like any other.
 */
export const setClaudeHooksParamsSchema = z
  .object({ on: z.boolean(), requestId: requestIdSchema })
  .strict()

/** B-M39's result: the stored state, with the two failures as outcomes (= `SetOpenCodePermissionsResult`). */
export const setClaudeHooksResultSchema = setOpenCodePermissionsResultSchema

/**
 * B-M40 `preferences.answerWelcome` params (14 §3.4; AMENDMENT-7, OQ-68); A-N32's request is this same
 * object (14 §1.2): the two ticks at "Activate" and a requestId, nothing else (no origin: the Host records
 * `first-run`).
 */
export const answerWelcomeParamsSchema = z
  .object({
    claudeHooks: z.boolean(),
    openCodePermissions: z.boolean(),
    requestId: requestIdSchema
  })
  .strict()

/** 16 §4.12 `WelcomeResult`: every integration's state after its write or revert settled, with its failure. */
const welcomeIntegrationResultSchema = z
  .object({
    state: integrationStateSchema,
    failure: z.enum(['config-write-failed', 'config-revert-failed']).optional()
  })
  .strict()

export const welcomeResultSchema = z
  .object({
    'claude-hooks': welcomeIntegrationResultSchema,
    'opencode-permissions': welcomeIntegrationResultSchema
  })
  .strict()

/** B-M40's result: a per-integration failure is in the result, never a call error (14 §2.3). */
export const answerWelcomeResultSchema = z
  .object({ integrations: welcomeResultSchema, welcome: welcomeStepStateSchema })
  .strict()
