// The crew `SessionTerminator` bridge (05 §4 item 1; 16 §4.2 row `SessionTerminator`; ADR-014
// items 1–3, 7, frozen). It ends an observed session by the kernel's identity-checked tree kill
// of the process identity observation recorded for it (pid + start time + boot id), never by a
// bare pid and never signalling the process group (`group: 'foreign'`): the kernel re-checks the
// identity before the first signal and before every escalation, and answers `ended` only once
// the root's exit is observed, or the recorded process no longer exists (`ProcessControl.killTree`,
// ISSUE-019). Each `ended` session's provider identity goes to observation's ended ledger, so a
// late transcript write never resurrects the dwarf (item 7).
//
// - No recorded or readable identity → `failed: 'no-identity'`, nothing signalled (item 2; FM-063;
//   15 §5 per-path table). Spike S-014-1 is `partial`, so this is every observed Codex,
//   Antigravity and OpenCode session for now: no pid heuristic is tried here.
// - An owned dwarf: its graceful close and tree kill go through the suppliers channel that
//   EPIC-09/EPIC-10 bind (05 §4 item 1); until then it is not reachable from this cut (legacy
//   launches end through `LegacyEndFirstAdapter`, later: ISSUE-090), and it answers
//   `failed: 'no-identity'` with nothing signalled rather than a guess (item 2, "if a driver
//   could not record one, the same rule applies").
// - A dwarf that is not present (departed, or unknown) has no session left: `ended`, nothing
//   signalled (16 §4.2 "ending an ended session is `ended`").
//
// Only dwarf ids, process identities and provider identities cross it: the custom name never
// reaches a call (NFR-PRIV-03). `endAll` ends the mine's present dwarfs in parallel (16 §2.5).
import type { EndOutcome } from '../../kernel/domain/processIdentity'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { ProcessControl } from '../../kernel/ports/processControl'
import type { CrewQueries, EndReason, SessionTerminator } from '../../modules/crew'
import type { ObservationControl, ObservedProcessIdentities } from '../../modules/observation'

export interface SessionTerminatorBridgeDeps {
  crew: Pick<CrewQueries, 'get' | 'crewOf'>
  /** Observation's read of the process identity its adapter recorded for an observed session. */
  observed: ObservedProcessIdentities
  /** The kernel's identity-checked tree kill (R17: process control only through the kernel). */
  processes: Pick<ProcessControl, 'killTree'>
  /** Observation's anti-ghost record of an ended identity (ADR-014 item 7). */
  endedLedger: Pick<ObservationControl, 'recordEnded'>
  clock: Clock
}

/** ADR-014 item 3: the wait after the first (catchable) step before the uncatchable one (16 §2.6). */
export const OBSERVED_TERM_GRACE_MS = 3_000

const NO_IDENTITY: EndOutcome = { kind: 'failed', reason: 'no-identity' }

export function createSessionTerminator(deps: SessionTerminatorBridgeDeps): SessionTerminator {
  // `why` changes nothing on the observed path: every reason ends the whole tree (OQ-54); what a
  // reason means for the dwarf afterwards is crew's (06 §5.1).
  async function end(dwarfId: DwarfId, _why: EndReason): Promise<EndOutcome> {
    const dwarf = deps.crew.get(dwarfId)
    if (dwarf === null || dwarf.departed) return { kind: 'ended' }
    if (dwarf.owned) return { ...NO_IDENTITY }
    const identity = deps.observed.processIdentityOf(dwarfId)
    if (identity === null) return { ...NO_IDENTITY }
    const outcome = await deps.processes.killTree(identity, {
      graceMs: OBSERVED_TERM_GRACE_MS,
      group: 'foreign'
    })
    if (outcome.kind === 'ended') deps.endedLedger.recordEnded(dwarf.identity, deps.clock.now())
    return outcome
  }

  return {
    end,
    async endAll(mineId: MineId): Promise<Map<DwarfId, EndOutcome>> {
      const crew = deps.crew.crewOf(mineId)
      const outcomes = await Promise.all(
        crew.map(async (d) => [d.id, await end(d.id, 'remove-mine')] as const)
      )
      return new Map(outcomes)
    }
  }
}
