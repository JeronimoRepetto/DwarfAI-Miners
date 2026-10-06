// The cut-1 rollback choices of the Host composition (21 §2 cut 1 row "Rollback", `21-migration-plan.md:172`; §2.1;
// §1 items 1 and 4; ADR-001 items 3, 6). The only Host file that reads `CUT_1_ROLLBACK` (inside the Host only
// `transport` and `wiring` import contracts, 05 §1.3, R9; `cut1Rollback.test.ts` pins that no other Host file
// reads it). host/main.ts composes through `CUT_1_ROLLBACK_CHOICES`, never through the constant.
//
// A rollback of cut 1 is a new internal build whose cut-1 router rows route `legacy` again with the legacy observer,
// ledger and notifier composed again, reached by the ADR-002 D8 upgrade handshake: the Host keeps running from the
// same generation over the same `dwarfai.db`. So that there is still one observer, one ledger writer and one
// notifier (21 §1 item 4), the setting turns off, in the Host:
//
// - the observer's writes: observation is constructed over `observationWritesOff` (routes/observation.ts) and never
//   started, so no cursor, session, usage or ledger credit is written. Every path that writes what observation feeds
//   is gated by `observesWith` on the sink this file chose: step 7's `WiredObservation.start` (null), the coal
//   backfill (`startBackfillWhenObserving`, null) and the per-mine backfill `runMineCoalBackfill`
//   (`routeMineBackfillWhenObserving`, not subscribed; O-11-10). The issue names "ledger credits": both backfills credit the ledger, so both are
//   included. Rows the Host wrote before stay (forward-only, 21 §5.1): nothing here deletes;
// - its level-3 OS notifications: attention's `Level3Sink` delivers nothing (no `attention.notify` or
//   `attention.withdraw` frame reaches the tray `notifier`). The policy still decides and records its keys, and
//   each withheld notification is logged as `attention.decision` by its event name, kind and dwarf only, never the
//   notification's title or body (19 §9.4; ADR-026; ADR-018 item 9).
//
// How host/main.ts keeps these choices since ISSUE-108 turned observation and the coal backfills on: keep passing the bridge's sink through
// `CUT_1_ROLLBACK_CHOICES.observedBatchSink(batches.sink)` and keep that returned sink as `modules.batchSink`;
// start step 7 only through `modules.observation.start?.()` (never `observation.control.start()` or `catchUp()`
// directly); start the coal backfill only through `startBackfillWhenObserving(modules.ledger, modules.batchSink)`;
// route the per-mine backfill only when `observesWith(modules.batchSink)`.
import { CUT_1_ROLLBACK } from '../../contracts/strangler'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { Level3Sink } from '../modules/attention'
import type { ObservedBatchSink } from '../modules/observation'
import { observationWritesOff } from './routes/observation'

/** The diagnostics event of a level-3 decision (19 §9.4 `attention.decision`, debug). */
export const ATTENTION_DECISION_EVENT = 'attention.decision'

export interface Cut1RollbackChoices {
  /** Whether this build is a cut-1 rollback build. */
  readonly rolledBack: boolean
  /** Observation's batch sink: `sink`, or `observationWritesOff` in a rollback build (the module never starts). */
  observedBatchSink(sink: ObservedBatchSink): ObservedBatchSink
  /** Attention's level-3 sink: `sink`, or one that delivers nothing in a rollback build. */
  level3Sink(sink: Level3Sink, log: DiagnosticsLog): Level3Sink
}

/** The composition choices of a build whose cut-1 rollback setting is `rolledBack`. */
export function cut1RollbackChoices(rolledBack: boolean): Cut1RollbackChoices {
  return {
    rolledBack,
    observedBatchSink: (sink) => (rolledBack ? observationWritesOff : sink),
    level3Sink: (sink, log) => (rolledBack ? withheldLevel3Sink(log) : sink)
  }
}

/** This build's choices, from its `CUT_1_ROLLBACK` (false in every normal build). */
export const CUT_1_ROLLBACK_CHOICES: Cut1RollbackChoices = cut1RollbackChoices(CUT_1_ROLLBACK)

/**
 * The level-3 sink of a rollback build: nothing reaches a `notifier` (the legacy notifier is the one notifier).
 * `'no-ui'` is the honest answer (16 §4.11 row `Level3Sink`): the notification was not delivered.
 */
function withheldLevel3Sink(log: DiagnosticsLog): Level3Sink {
  return {
    notify: (n) => {
      log.record({
        level: 'debug',
        event: ATTENTION_DECISION_EVENT,
        subsystem: 'attention',
        dwarfId: n.dwarfId,
        causeClass: n.kind,
        outcome: 'skipped'
      })
      return 'no-ui'
    },
    withdraw: () => undefined
  }
}
