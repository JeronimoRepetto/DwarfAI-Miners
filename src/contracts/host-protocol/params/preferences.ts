// Seam-B params and results of `preferences.*` that host-placed seam A rows relay unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import {
  consentOriginSchema,
  integrationStateSchema,
  type ConsentOrigin,
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
