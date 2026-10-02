// Seam-B params and results of `preferences.*` that host-placed seam A rows relay unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import { CATALOG_PROVIDER_IDS } from '../../catalog'
import {
  consentOriginSchema,
  integrationStateSchema,
  jevRoutingProfileSchema,
  providerIdSchema,
  type ConsentOrigin,
  type HostPreferences,
  type IntegrationState
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
