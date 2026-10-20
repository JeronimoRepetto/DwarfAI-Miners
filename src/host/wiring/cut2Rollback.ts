// The cut-2 rollback choices of the Host composition (21 §2 cut 2 row "Rollback"; §2.1; §1 items 4 and 8; ADR-016
// items 5, 6; ISSUE-141 lead decision 2026-10-14). The only Host file that reads `CUT_2_ROLLBACK` (inside the Host only
// `transport` and `wiring` import contracts, 05 §1.3, R9). host/main.ts composes through `CUT_2_ROLLBACK_CHOICES`,
// never through the constant.
//
// A rollback of cut 2 is a new internal build whose table is `rollbackOf(cut-2 table, 'cut-2')`, reached by the ADR-002
// D8 upgrade handshake: A-40/A-41 route `legacy` again with today's Claude hook installer composed again, and A-N31
// `setClaudeHooksEnabled` and A-N32 `answerWelcome` are withdrawn (`WRITES_A_FOREIGN_ENTRY`, no route in that build).
// Before it starts, the newer build's `--revert-integrations` removed the entry the Host wrote (the rollback
// procedure). The setting turns off, in the Host:
//
// - the first-run step: its installed tools are none, so no option is offered and the step is not due (07 S41.09:
//   nothing shown, written or reverted, and `welcome_answered_at` stays as it was, so a later build that routes A-N32
//   again offers it). Hidden until built (21 §1 item 8): the step has no close and no skip (US-SET-012.AC06), and its
//   one answer has no route in that build;
// - the Host's Claude hook entry: its config writer refuses every install, before the engine's Tx A (nothing written,
//   no `config_writes` row, no token hash; the command answers `config-write-failed`, as an unset ingress port does,
//   bridges/hostConfigWriter.ts), so the entry keeps one writer, today's installer (21 §1 item 4, §4). Verify, revert
//   and the legacy probe write no entry and pass through: the Reset saga and the boot re-verification still settle
//   what the Host wrote before (forward-only, 21 §5.1);
// - the old app's entry, which today's installer writes again in that build: the Claude hooks target leaves it alone
//   (`keepsOldAppEntries`, ClaudeHooksConfigWriter `keepOldAppEntries`), so a revert (Reset metrics) or the boot
//   settlement of a row a crash left unverified (07 S14.11) removes the Host's own entry only, never today's
//   (verifier finding, 2026-10-14). `--revert-integrations` of the newer build settles every active row before the
//   rollback build starts, so the boot settlement normally has nothing to do;
// - the asks the cut-2 build left live (#1293): an observed session outlives the Host (07 S6.17), so its ask can still
//   be `open` when the rollback build's Host boots, but no route answers a Host `AskId` there (A-asking rows route
//   `legacy`, `INVALID_PARAMS`). Hidden until built (21 §1 item 8): the Host settles each one at boot as a request it
//   no longer holds (`NO_REQUEST_HELD`), so its card disappears with no notice and no unanswerable card is shown.
import { CUT_2_ROLLBACK } from '../../contracts/strangler'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { AskRestartSettlementPath, RestartFacts } from '../modules/asking'
import type { ExternalConfigWriter, InstalledToolsReader } from '../modules/preferences'

export interface Cut2RollbackChoices {
  /** Whether this build is a cut-2 rollback build. */
  readonly rolledBack: boolean
  /** Whether the Claude hooks target leaves the old app's (today's installer's) entries alone. */
  readonly keepsOldAppEntries: boolean
  /** The first-run step's installed tools. */
  installedTools(reader: InstalledToolsReader): InstalledToolsReader
  /** The Host's one config writer. */
  externalConfig(writer: ExternalConfigWriter, log: DiagnosticsLog): ExternalConfigWriter
  /** The asks a stopped Host left live, settled once at boot. */
  settleLeftoverAsks(asks: AskRestartSettlementPath): void
}

/** The composition choices of a build whose cut-2 rollback setting is `rolledBack`. */
export function cut2RollbackChoices(rolledBack: boolean): Cut2RollbackChoices {
  return {
    rolledBack,
    keepsOldAppEntries: rolledBack,
    installedTools: (reader) => (rolledBack ? NOTHING_OFFERED : reader),
    externalConfig: (writer, log) => (rolledBack ? installRefused(writer, log) : writer),
    settleLeftoverAsks: (asks) => {
      if (rolledBack) asks.settleAfterRestart(() => NO_REQUEST_HELD)
    }
  }
}

/**
 * What a rollback build knows of every ask a stopped Host left live: no request is the Host's to hold any more. No
 * route answers a Host `AskId` in that build (the asking rows route `legacy`), so a request still waiting is answered
 * in the provider's own terminal, outside DwarfAI: the open ask closes answered elsewhere (07 S6.11) and an answer
 * that was in flight settles answered elsewhere, the side that never claims an answer the app cannot prove (S6.20).
 * Whether the session survived does not change what the person sees: the card disappears with no notice either way.
 */
const NO_REQUEST_HELD: RestartFacts = {
  sessionSurvived: true,
  stillPending: false,
  deliveryEvidence: false
}

const NOTHING_OFFERED: InstalledToolsReader = { installed: () => [] }

/** The config writer of a rollback build: every install refused and logged, everything else as it was. */
function installRefused(writer: ExternalConfigWriter, log: DiagnosticsLog): ExternalConfigWriter {
  return {
    install: (target, _token, origin) => {
      log.record({
        level: 'warn',
        event: 'config.write',
        subsystem: target,
        outcome: 'failed',
        msg: origin,
        causeClass: 'cut-2-rollback'
      })
      return Promise.resolve({ ok: false, error: 'io' })
    },
    verify: (target) => writer.verify(target),
    revert: (target) => writer.revert(target),
    findLegacy: (target) => writer.findLegacy(target)
  }
}

/** This build's choices, from its `CUT_2_ROLLBACK` (false in every normal build). */
export const CUT_2_ROLLBACK_CHOICES: Cut2RollbackChoices = cut2RollbackChoices(CUT_2_ROLLBACK)
