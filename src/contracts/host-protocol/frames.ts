// The seam-B frame catalog (14 §3.5): one `'<name>': <payload>` entry per Host → UI evt frame.
// Each entry lands here, in this file, with the issue that publishes it (hot spot, 22 §5).
// HostFrameName and HostFrameData derive from it once, in envelope.ts.
//
// Each entry has its strict() data schema in HOST_FRAME_SCHEMAS (14 §1.4: frames are validated in
// tests); the type test in frames.test.ts keeps every schema equal to its interface entry. The
// mapping is Partial only because a test may merge a frame of its own into HostFrames.
import { z } from 'zod'
import { preferencesViewSchema, resetIdSchema, type PreferencesView, type ResetId } from '../wire'
import type { HelloOk } from './adr-003'
import { resetEpochSchema, resetStepSchema, type ResetStep } from './params/preferences'

// An interface, not a type alias, so that entries merge into it.
// verbatim: 14 §3.5 (the B-F03, B-F04, B-F05, B-F24, B-F26 and B-F27 entries, byte-for-byte; `prettier-ignore` keeps their alignment)
// prettier-ignore
export interface HostFrames {
  'resync-required':      { reason: 'epoch-changed' | 'seq-not-in-ring' | 'ring-overrun' | 'backpressure' | 'metrics-reset' }
  'host.state':           { state: HelloOk['state']; jobStatus: HelloOk['jobStatus'] }
  'host.closing':         { reason: 'idle' | 'stop-all' | 'upgrade' | 'os-session-end'; clean: true }   // 'idle' retired by AMENDMENT-5 (OQ-63), never sent
  'preferences.changed':  PreferencesView
  'ui.resetPreferences':  { epoch: number }
  'reset.progress':       { resetId: ResetId; epoch: number; step: ResetStep }
}
// end verbatim: 14 §3.5

/** The strict() schema of each frame's `data`, by frame name. */
export const HOST_FRAME_SCHEMAS = {
  'resync-required': z
    .object({
      reason: z.enum([
        'epoch-changed',
        'seq-not-in-ring',
        'ring-overrun',
        'backpressure',
        'metrics-reset'
      ])
    })
    .strict(),
  'host.state': z
    .object({
      state: z.enum(['starting', 'migrating', 'ready', 'upgrade-pending']),
      jobStatus: z.enum(['none', 'breakaway-ok', 'in-job', 'n/a'])
    })
    .strict(),
  'host.closing': z
    .object({
      reason: z.enum(['idle', 'stop-all', 'upgrade', 'os-session-end']),
      clean: z.literal(true)
    })
    .strict(),
  'preferences.changed': preferencesViewSchema,
  'ui.resetPreferences': z.object({ epoch: resetEpochSchema }).strict(),
  'reset.progress': z
    .object({ resetId: resetIdSchema, epoch: resetEpochSchema, step: resetStepSchema })
    .strict()
} as const satisfies Partial<{ [F in keyof HostFrames]: z.ZodType<HostFrames[F]> }>
