// The seam-B frame catalog (14 §3.5): one `'<name>': <payload>` entry per Host → UI evt frame.
// Each entry lands here, in this file, with the issue that publishes it (hot spot, 22 §5).
// HostFrameName and HostFrameData derive from it once, in envelope.ts.
//
// Each entry has its strict() data schema in HOST_FRAME_SCHEMAS (14 §1.4: frames are validated in
// tests); the type test in frames.test.ts keeps every schema equal to its interface entry. The
// mapping is Partial only because a test may merge a frame of its own into HostFrames.
import { z } from 'zod'
import {
  dwarfIdSchema,
  dwarfWireSchema,
  materialTotalsSchema,
  messageViewSchema,
  mineIdSchema,
  mineWireSchema,
  osNotificationSchema,
  preferencesViewSchema,
  resetIdSchema,
  type DwarfId,
  type DwarfWire,
  type Material,
  type MaterialAmount,
  type MessageView,
  type MineId,
  type MineWire,
  type OsNotification,
  type PreferencesView,
  type ResetId
} from '../wire'
import type { HelloOk } from './adr-003'
import { departureCauseSchema, type DepartureCause } from './params/crew'
import { resetEpochSchema, resetStepSchema, type ResetStep } from './params/preferences'

// An interface, not a type alias, so that entries merge into it.
// verbatim: 14 §3.5 (the B-F03, B-F04, B-F05, B-F06, B-F08, B-F09, B-F10, B-F11, B-F20, B-F22, B-F23, B-F24, B-F26 and B-F27 entries, byte-for-byte; `prettier-ignore` keeps their alignment)
// prettier-ignore
export interface HostFrames {
  'resync-required':      { reason: 'epoch-changed' | 'seq-not-in-ring' | 'ring-overrun' | 'backpressure' | 'metrics-reset' }
  'host.state':           { state: HelloOk['state']; jobStatus: HelloOk['jobStatus'] }
  'host.closing':         { reason: 'idle' | 'stop-all' | 'upgrade' | 'os-session-end'; clean: true }   // 'idle' retired by AMENDMENT-5 (OQ-63), never sent
  'mine.changed':         { mine: MineWire }
  'dwarf.arrived':        { dwarf: DwarfWire; announce: boolean }
  'dwarf.changed':        { dwarf: DwarfWire }
  'dwarf.departed':       { dwarfId: DwarfId; mineId: MineId; cause: DepartureCause }
  'conversation.appended': { dwarfId: DwarfId; messages: MessageView[] }
  'ledger.changed':       { mineId: MineId; totals: Record<Material, MaterialAmount> }
  'attention.notify':     OsNotification
  'attention.withdraw':   { keys: string[] }
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
  'mine.changed': z.object({ mine: mineWireSchema }).strict(),
  'dwarf.arrived': z.object({ dwarf: dwarfWireSchema, announce: z.boolean() }).strict(),
  'dwarf.changed': z.object({ dwarf: dwarfWireSchema }).strict(),
  'dwarf.departed': z
    .object({ dwarfId: dwarfIdSchema, mineId: mineIdSchema, cause: departureCauseSchema })
    .strict(),
  'conversation.appended': z
    .object({ dwarfId: dwarfIdSchema, messages: z.array(messageViewSchema) })
    .strict(),
  'ledger.changed': z.object({ mineId: mineIdSchema, totals: materialTotalsSchema }).strict(),
  'attention.notify': osNotificationSchema,
  'attention.withdraw': z.object({ keys: z.array(z.string()) }).strict(),
  'preferences.changed': preferencesViewSchema,
  'ui.resetPreferences': z.object({ epoch: resetEpochSchema }).strict(),
  'reset.progress': z
    .object({ resetId: resetIdSchema, epoch: resetEpochSchema, step: resetStepSchema })
    .strict()
} as const satisfies Partial<{ [F in keyof HostFrames]: z.ZodType<HostFrames[F]> }>

// Every name of the 14 §3.5 list, also those whose frame lands with a later issue: the list is the
// contract's, and the transport logs a frame's name, seq and size only, never its data (14 §1.10).
// verbatim: 14 §3.5 (SENSITIVE_FRAMES, byte-for-byte; `prettier-ignore` keeps its alignment)
/** Payloads never written to a log, debug dump or crash report (§1.10); the transport logs names, ids, seq and sizes only. */
// prettier-ignore
export const SENSITIVE_FRAMES = [
  'attention.notify',        // OsNotification: custom names, question text
  'conversation.appended',   // message text
  'dwarf.arrived', 'dwarf.changed',   // custom names, outcome line
  'ask.opened',              // ask payloads (question steps, tool summaries)
  'activity.changed',        // tool-step summaries
  'launch.changed', 'launch.failed',  // LaunchFailure.toolOutputTail
  'host.recovered',          // report items (dwarf names, provider causes)
  'toast',                   // provider-error cause
  'mine.changed',            // folder paths
] as const
// end verbatim: 14 §3.5

// The 14 §3.5 list of methods whose params, result or both are never logged: the dispatcher logs a
// method's name, correlation fields, outcome and error code only (host/transport/dispatcher.ts).
// verbatim: 14 §3.5 (SENSITIVE_METHODS, byte-for-byte; `prettier-ignore` keeps its alignment)
// prettier-ignore
export const SENSITIVE_METHODS = {          // 'params' | 'result' | 'both' is what must not be logged
  'settings.secret.set': 'params', 'settings.secret.clear': 'params',
  'conversation.send': 'params', 'conversation.feed': 'result', 'conversation.mineHistory': 'result',
  'conversation.describeAttachments': 'both', 'conversation.resolveConsole': 'result',   // paths, credentialFile path
  'session.snapshot': 'result',             // tails, asks, launches, mines, dwarfs
  'asking.answerQuestion': 'params',        // free-text answers
  'launching.launch': 'params', 'launching.launchCustom': 'params',   // prompt, custom command
  'jev.suggest': 'params',                  // prompt
  'crew.rename': 'params',                  // custom name
  'mines.declare': 'params', 'mines.adoptMainProject': 'params', 'mines.list': 'result', 'mines.resolveFile': 'both',
  'host.upgrade.request': 'params',
} as const
// end verbatim: 14 §3.5
