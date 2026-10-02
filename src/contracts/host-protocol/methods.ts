// The seam-B method catalog (14 §3.4): one `'<name>': { params; result }` entry per UI → Host request.
// Each entry lands here, in this file, with the issue that serves its handler (hot spot, 22 §5); `hello` is the
// first frame, not a method. HostMethod, HostParams and HostResult derive from it once, in envelope.ts.
//
// Each entry has its strict() params and result schemas in HOST_METHOD_SCHEMAS (14 §1.4: both sides validate
// every frame); the type test in methods.test.ts keeps every schema equal to its interface entry. The mapping is
// Partial only because a test may merge a method of its own into HostMethods.
import { z } from 'zod'
import {
  hostEpochSchema,
  hostPreferencesSchema,
  instantSchema,
  preferencesViewSchema,
  stopAllOutcomeSchema,
  type HostEpoch,
  type HostPreferences,
  type Instant,
  type PreferencesView,
  type StopAllOutcome
} from '../wire'
import {
  metricsResetResultSchema,
  preferenceSetParamsSchema,
  resetEpochSchema,
  resetMetricsParamsSchema,
  type MetricsResetResult,
  type PreferenceSetParams,
  type ResetMetricsParams
} from './params/preferences'
import { requestIdSchema } from './requestId'
import {
  snapshotPageSchema,
  snapshotParamsSchema,
  type SnapshotPage,
  type SnapshotParams
} from './snapshot'

// An interface, not a type alias, so that entries merge into it.
// verbatim: 14 §3.4 (the B-M02, B-M03, B-M04, B-M05, B-M06, B-M09, B-M12, B-M13 and B-M15 entries and their group comments, byte-for-byte; `prettier-ignore` keeps their alignment)
// prettier-ignore
export interface HostMethods {
  // protocol
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty params as {}
  'ping':                            { params: {}; result: { at: Instant } }
  'events.subscribe':                { params: SubscribeParams; result: SubscribeResult }
  'session.snapshot':                { params: SnapshotParams; result: SnapshotPage }
  'host.shutdown':                   { params: HostShutdownParams; result: HostShutdownResult }
  'host.upgrade.request':            { params: { targetVersion: string; targetDir: string; requestId: string }; result: { state: 'upgrade-pending' } }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty result as {}
  'ui.resetPreferences.ack':         { params: { epoch: number }; result: {} }
  // preferences and secrets
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty params as {}
  'preferences.get':                 { params: {}; result: PreferencesView }
  'preferences.set':                 { params: PreferenceSetParams; result: HostPreferences }
  'preferences.resetMetrics':        { params: ResetMetricsParams; result: MetricsResetResult }
}
// end verbatim: 14 §3.4

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): protocol, B-M03
export interface SubscribeParams {
  resume?: { epoch: HostEpoch; lastSeq: number }
} // mirrors Hello.resume
export type SubscribeResult =
  | { status: 'replaying'; fromSeq: number; toSeq: number } // missed frames follow, then live frames
  | { status: 'live'; fromSeq: number } // fresh subscription: no resume, snapshot next
  | { status: 'resync-required' } // a resync-required frame also follows; snapshot next

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): protocol, B-M05
export interface HostShutdownParams {
  mode: 'when-idle' | 'stop-all' | 'upgrade-drain'
  requestId: string
} // ADR-002 D7, D8; this shape is generation-stable (§1.3); 'when-idle' retired by AMENDMENT-5 (OQ-63), never sent → INVALID_PARAMS
export type HostShutdownResult =
  | { mode: 'when-idle'; accepted: true } // retired by AMENDMENT-5 (OQ-63): never returned; the Host never exits on its own
  | { mode: 'stop-all'; outcome: StopAllOutcome } // answered after every end settled (ADR-002 D7 step 3)
  | { mode: 'upgrade-drain'; accepted: true } // AMENDMENT-2 (SC-AR-03): sent only after the person confirmed (ADR-027 item 4)

/** The strict() schemas of each method's `params` and `result`, by method name. */
export const HOST_METHOD_SCHEMAS = {
  ping: {
    params: z.object({}).strict(),
    result: z.object({ at: instantSchema }).strict()
  },
  'events.subscribe': {
    params: z
      .object({
        resume: z
          .object({ epoch: hostEpochSchema, lastSeq: z.number().int().nonnegative() })
          .strict()
          .optional()
      })
      .strict(),
    // A replay with nothing missed has toSeq = fromSeq - 1 (framePublisher.ts).
    result: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('replaying'),
          fromSeq: z.number().int().positive(),
          toSeq: z.number().int().nonnegative()
        })
        .strict(),
      z.object({ status: z.literal('live'), fromSeq: z.number().int().positive() }).strict(),
      z.object({ status: z.literal('resync-required') }).strict()
    ])
  },
  // B-M04 (14 §3.7, §4): the Host's own rules (a continuation, the advertised sections, the role
  // filter) are host/transport/methods/sessionSnapshot.ts's, not the wire's.
  'session.snapshot': {
    params: snapshotParamsSchema,
    result: snapshotPageSchema
  },
  // The whole generation-stable shape (14 §1.3): which modes the Host serves is the Host's rule
  // (host/transport/methods/hostShutdown.ts), not the wire's.
  'host.shutdown': {
    params: z
      .object({
        mode: z.enum(['when-idle', 'stop-all', 'upgrade-drain']),
        requestId: requestIdSchema
      })
      .strict(),
    result: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('when-idle'), accepted: z.literal(true) }).strict(),
      z.object({ mode: z.literal('stop-all'), outcome: stopAllOutcomeSchema }).strict(),
      z.object({ mode: z.literal('upgrade-drain'), accepted: z.literal(true) }).strict()
    ])
  },
  'host.upgrade.request': {
    // The 14 §1.10 targetDir rule needs the file system: it is the Host's
    // (host/transport/methods/hostUpgradeRequest.ts), not the wire's.
    params: z
      .object({ targetVersion: z.string(), targetDir: z.string(), requestId: requestIdSchema })
      .strict(),
    result: z.object({ state: z.literal('upgrade-pending') }).strict()
  },
  // B-M12, B-M13 (14 §2.3): `ui` only; B-M13 answers the stored HostPreferences (IPC Gap 10).
  'preferences.get': {
    params: z.object({}).strict(),
    result: preferencesViewSchema
  },
  'preferences.set': {
    params: preferenceSetParamsSchema,
    result: hostPreferencesSchema
  },
  // B-M09 (14 §2.3): `ui` only; idempotent by its own shape, so it carries no requestId
  // (dedupe/mutatingMethods.ts). B-M15: `confirmed: 'yes'` only (ADR-019; the trimmed,
  // case-insensitive comparison of the typed text is the dialog's, 07 S13.01).
  'ui.resetPreferences.ack': {
    params: z.object({ epoch: resetEpochSchema }).strict(),
    result: z.object({}).strict()
  },
  'preferences.resetMetrics': {
    params: resetMetricsParamsSchema,
    result: metricsResetResultSchema
  }
} as const satisfies Partial<{
  [M in keyof HostMethods]: {
    params: z.ZodType<HostMethods[M]['params']>
    result: z.ZodType<HostMethods[M]['result']>
  }
}>
