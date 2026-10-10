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
  mineIdSchema,
  preferencesViewSchema,
  stopAllOutcomeSchema,
  stranglerDwarfIdentitySchema,
  feedPageSchema,
  mineHistoryViewSchema,
  type DwarfId,
  type FeedPage,
  type FolderPath,
  type HostEpoch,
  type HostPreferences,
  type Instant,
  type MineHistoryView,
  type MineId,
  type PreferencesView,
  type StopAllOutcome,
  type StranglerDwarfIdentity
} from '../wire'
import {
  adoptMainProjectParamsSchema,
  adoptMainProjectResultSchema,
  declareMineParamsSchema,
  declareMineResultSchema,
  mineListParamsSchema,
  mineListResultSchema,
  resolveFileParamsSchema,
  resolveFileResultSchema,
  type AdoptMainProjectResult,
  type DeclareMineResult,
  type MineListParams,
  type MineListResult,
  type ResolveFileResult
} from './params/mines'
import {
  metricsResetResultSchema,
  preferenceSetParamsSchema,
  resetEpochSchema,
  resetMetricsParamsSchema,
  setClaudeHooksParamsSchema,
  setClaudeHooksResultSchema,
  type MetricsResetResult,
  type PreferenceSetParams,
  type ResetMetricsParams,
  type SetClaudeHooksParams,
  type SetClaudeHooksResult
} from './params/preferences'
import { feedParamsSchema, type FeedParams } from './params/conversation'
import {
  answerOutcomeSchema,
  answerPermissionParamsSchema,
  answerQuestionParamsSchema,
  type AnswerOutcome,
  type AnswerPermissionParams,
  type AnswerQuestionParams
} from './params/asking'
import { outcomeSchema, type Outcome } from './errors'
import { requestIdSchema } from './requestId'
import {
  snapshotPageSchema,
  snapshotParamsSchema,
  type SnapshotPage,
  type SnapshotParams
} from './snapshot'

// An interface, not a type alias, so that entries merge into it.
// verbatim: 14 §3.4 (the B-M02, B-M03, B-M04, B-M05, B-M06, B-M07, B-M08, B-M09, B-M12, B-M13, B-M15, B-M16, B-M17, B-M18, B-M19, B-M20, B-M26, B-M27, B-M30, B-M31, B-M39 and B-M41 entries and their group comments, byte-for-byte; `prettier-ignore` keeps their alignment)
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
  'presence':                        { params: PresenceParams; result: {} }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty result as {}
  'attention.clicked':               { params: { key: string }; result: {} }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty result as {}
  'ui.resetPreferences.ack':         { params: { epoch: number }; result: {} }
  // preferences and secrets
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty params as {}
  'preferences.get':                 { params: {}; result: PreferencesView }
  'preferences.set':                 { params: PreferenceSetParams; result: HostPreferences }
  'preferences.setClaudeHooks':      { params: SetClaudeHooksParams; result: SetClaudeHooksResult }       // AMENDMENT-7
  'preferences.resetMetrics':        { params: ResetMetricsParams; result: MetricsResetResult }
  // mines
  'mines.declare':                   { params: { path: FolderPath; requestId: string }; result: DeclareMineResult }
  'mines.adoptMainProject':          { params: { worktreePath: FolderPath; requestId: string }; result: AdoptMainProjectResult }
  'mines.remove':                    { params: { mineId: MineId; requestId: string }; result: RemoveMineResult }
  'mines.list':                      { params: MineListParams; result: MineListResult }
  'mines.resolveFile':               { params: { mineId: MineId; dwarfId?: DwarfId; target: string }; result: ResolveFileResult }
  // conversation
  'conversation.feed':               { params: FeedParams; result: FeedPage }
  'conversation.mineHistory':        { params: { mineId: MineId }; result: MineHistoryView }
  // asking
  'asking.answerQuestion':           { params: AnswerQuestionParams; result: AnswerOutcome }
  'asking.answerPermission':         { params: AnswerPermissionParams; result: AnswerOutcome }
  // strangler-only (AMENDMENT-8, OQ-69): ui role, called only by LegacyDwarfIdBridge; deleted at the end of cut 4
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty params as {}
  'strangler.dwarfIdentities':       { params: {}; result: StranglerDwarfIdentity[] }
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

// As 14 §3.4 writes it (names, fields and comments; layout by prettier): protocol, B-M07
export interface PresenceParams {
  // 06 UiPresence on the wire; the Host adds anyUiAttached itself
  onScreenMineIds: MineId[]
  anyWindowVisible: boolean
  seq: number // UI-side counter; the Host ignores an older seq
}

// As 14 §3.4 writes it (names, fields and comments; layout by prettier): mines, B-M18
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty value as {}
export type RemoveMineResult = Outcome<{}, 'dwarf-could-not-be-ended'> // the ONE toast arrives as a frame (PO #79)

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
  // B-M07 (14 §2.3): `ui` only; not mutating, so no requestId (14 §1.6). Which report wins is the
  // Host's rule (an older `seq` of the same client is ignored, 16 §4.11), not the wire's.
  presence: {
    params: z
      .object({
        onScreenMineIds: z.array(mineIdSchema),
        anyWindowVisible: z.boolean(),
        seq: z.number().int().nonnegative()
      })
      .strict(),
    result: z.object({}).strict()
  },
  // B-M08 (14 §2.3): `notifier` only; not mutating, so no requestId (14 §1.6). The key is a
  // diagnostics counter's input only (ADR-018 item 6); the frame codec bounds its size.
  'attention.clicked': {
    params: z.object({ key: z.string() }).strict(),
    result: z.object({}).strict()
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
  // B-M39 (14 §2.3, §3.4; AMENDMENT-7): `ui` only, mutating (requestId). The origin is the Host's
  // (`settings`, host/transport/methods/setClaudeHooks.ts), never the wire's.
  'preferences.setClaudeHooks': {
    params: setClaudeHooksParamsSchema,
    result: setClaudeHooksResultSchema
  },
  'ui.resetPreferences.ack': {
    params: z.object({ epoch: resetEpochSchema }).strict(),
    result: z.object({}).strict()
  },
  'preferences.resetMetrics': {
    params: resetMetricsParamsSchema,
    result: metricsResetResultSchema
  },
  // B-M16, B-M17 (14 §2.3, §1.10): `ui` only, mutating (requestId). Whether the path names a
  // folder is the Host's re-validation (host/modules/mines/application/declare.ts), not the wire's.
  'mines.declare': {
    params: declareMineParamsSchema,
    result: declareMineResultSchema
  },
  'mines.adoptMainProject': {
    params: adoptMainProjectParamsSchema,
    result: adoptMainProjectResultSchema
  },
  // B-M18 (14 §2.3, §1.7): `ui` only, mutating (requestId); answered after every end settled. The
  // dwarfs that could not be ended reach the UI in the one `toast {mine-removal-failed}` frame.
  'mines.remove': {
    params: z.object({ mineId: mineIdSchema, requestId: requestIdSchema }).strict(),
    result: outcomeSchema(z.object({}).strict(), z.literal('dwarf-could-not-be-ended'))
  },
  // B-M19 (14 §2.3): `ui` only; a query, so no requestId (14 §1.6). The field names are today's
  // ProjectQuery's (14 §8 I-10); the page bounds are params/mines.ts's.
  'mines.list': {
    params: mineListParamsSchema,
    result: mineListResultSchema
  },
  // B-M20 (14 §2.3, §1.10; ADR-019 item 9): `ui` only; a query. The containment rule is the Host's
  // (host/modules/mines/application/resolveFile.ts).
  'mines.resolveFile': {
    params: resolveFileParamsSchema,
    result: resolveFileResultSchema
  },
  // B-M26 (14 §2.3, §3.6): `ui` and `viewer` (its own dwarf only, host/transport/methods/conversationFeed.ts);
  // a query, so no requestId (14 §1.6). Its result is sensitive (14 §3.5 SENSITIVE_METHODS).
  'conversation.feed': {
    params: feedParamsSchema,
    result: feedPageSchema
  },
  // B-M27 (14 §2.3, §3.6): `ui` only (host/transport/methods/conversationMineHistory.ts); a query, so no
  // requestId (14 §1.6). Its result is sensitive (14 §3.5 SENSITIVE_METHODS).
  'conversation.mineHistory': {
    params: z.object({ mineId: mineIdSchema }).strict(),
    result: mineHistoryViewSchema
  },
  // B-M30, B-M31 (14 §2.3, §1.7; ADR-010): `ui` only, mutating (requestId = the `ask_answers` PK, a
  // durable key, 14 §1.6); answered after the channel result. A permission is Allow or Deny only
  // (INV-73). B-M30's params are sensitive (14 §3.5 SENSITIVE_METHODS: free-text answers).
  'asking.answerQuestion': {
    params: answerQuestionParamsSchema,
    result: answerOutcomeSchema
  },
  'asking.answerPermission': {
    params: answerPermissionParamsSchema,
    result: answerOutcomeSchema
  },
  // B-M41 (14 §2.3, §1.10; AMENDMENT-8, OQ-69): `ui` only, never relayed to seam A; deleted with
  // LegacyDwarfIdBridge at the end of cut 4 (later: ISSUE-241).
  'strangler.dwarfIdentities': {
    params: z.object({}).strict(),
    result: z.array(stranglerDwarfIdentitySchema)
  }
} as const satisfies Partial<{
  [M in keyof HostMethods]: {
    params: z.ZodType<HostMethods[M]['params']>
    result: z.ZodType<HostMethods[M]['result']>
  }
}>
