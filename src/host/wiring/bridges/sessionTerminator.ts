// The crew `SessionTerminator` bridge (05 §4 item 1; 16 §4.2 row `SessionTerminator`; ADR-014
// items 1–3, 7, frozen; 07 machine 15). Every end goes through the kernel's identity-checked tree
// kill (`ProcessControl.killTree`, ISSUE-019) of a recorded process identity (pid + start time +
// boot id), never a bare pid: the kernel re-checks the identity before the first signal and before
// every escalation, signals nothing when the recorded process is gone or its pid now names another
// process (S15.08; INV-51), and answers `ended` only once the root's exit is observed (S15.10,
// S15.12). Each `ended` session's provider identity goes to observation's ended ledger, so a late
// transcript write never resurrects the dwarf (item 7).
//
// - Observed (S15.07): the identity observation recorded for it, never signalling the process group
//   (`group: 'foreign'`, the person's terminal's). No recorded or readable identity →
//   `failed: 'no-identity'`, nothing signalled (item 2; FM-063; S15.17). Spike S-014-1 is
//   `partial`, so this is every observed Codex, Antigravity and OpenCode session for now: no pid
//   heuristic is tried here.
// - Owned (ISSUE-171; item 1; S15.05, S15.06): first the driver's graceful end over the session the
//   Host holds — `interrupt` (a no-op with no open turn), then `close('end-thread')` — within
//   `OWNED_CLOSE_BUDGET_MS`; whatever it answers, or when the budget runs out, the tree kill of the
//   process identity recorded at spawn follows, as the leader of its own process group
//   (`group: 'owned'`). An owned session with no recorded identity is `ended` only when its close
//   was observed as the session's exit (the Host no longer holds a driver session for it), else
//   `failed: 'no-identity'` with nothing signalled (item 2). The owned sessions are read through
//   `owned()`, bound once launching and suppliers exist; until then an owned dwarf is not reachable
//   and answers `failed: 'no-identity'` with nothing signalled rather than a guess.
// - Shared-server sessions (item 5; S15.03, S15.04): no driver opens one yet (later: the Codex and
//   OpenCode driver issues), so no protocol close is tried here.
// - A dwarf that is not present (departed, or unknown) has no session left: `ended`, nothing
//   signalled (16 §4.2 "ending an ended session is `ended`").
//
// Only dwarf ids, process identities and provider identities cross it: the custom name never
// reaches a call (NFR-PRIV-03). `endAll` ends the mine's present dwarfs in parallel (16 §2.5).
import type { EndOutcome, ProcessIdentity } from '../../kernel/domain/processIdentity'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { ProcessControl } from '../../kernel/ports/processControl'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { CrewQueries, DwarfView, EndReason, SessionTerminator } from '../../modules/crew'
import type { ObservationControl, ObservedProcessIdentities } from '../../modules/observation'
import type { LaunchRecord } from '../../modules/launching'
import type { DriverSession, SessionChannels } from '../../modules/suppliers'

/** A live owned session as the terminator ends it (glossary "Owned session"). */
export interface OwnedSession {
  /** The process identity recorded right after spawn (15 §1.2 `onSpawned`), or null if none was. */
  process: ProcessIdentity | null
  /** The driver session the Host holds for it, null once the session exited. */
  driver(): Pick<DriverSession, 'interrupt' | 'close'> | null
}

/** Launching's live owned sessions, with suppliers' driver sessions (`ownedSessionsOver`). */
export interface OwnedSessionLookup {
  /** The dwarf's live owned session, null when launching owns none for it. */
  liveSessionOf(dwarfId: DwarfId): OwnedSession | null
}

export interface SessionTerminatorBridgeDeps {
  crew: Pick<CrewQueries, 'get' | 'crewOf'>
  /** Observation's read of the process identity its adapter recorded for an observed session. */
  observed: ObservedProcessIdentities
  /** The kernel's identity-checked tree kill (R17: process control only through the kernel). */
  processes: Pick<ProcessControl, 'killTree'>
  /** Observation's anti-ghost record of an ended identity (ADR-014 item 7). */
  endedLedger: Pick<ObservationControl, 'recordEnded'>
  clock: Clock
  /** The graceful close's budget (16 §2.6). */
  scheduler: Scheduler
  /** The owned sessions, once launching and suppliers are bound; null until then. */
  owned: () => OwnedSessionLookup | null
}

/**
 * The owned sessions over launching's live records (the process identity recorded at spawn,
 * 09 §4.3) and the driver sessions suppliers holds for them (`SessionChannels.sessionFor`, which
 * drops a session once it exited).
 */
export function ownedSessionsOver(deps: {
  launching: { liveRecordOf(dwarfId: DwarfId): Pick<LaunchRecord, 'ref' | 'process'> | null }
  channels: Pick<SessionChannels, 'sessionFor'>
}): OwnedSessionLookup {
  return {
    liveSessionOf: (dwarfId) => {
      const record = deps.launching.liveRecordOf(dwarfId)
      if (record === null) return null
      return {
        process: record.process === undefined ? null : { ...record.process },
        driver: () => deps.channels.sessionFor(record.ref)
      }
    }
  }
}

/** ADR-014 item 3: the wait after the first (catchable) step before the uncatchable one (16 §2.6). */
export const OBSERVED_TERM_GRACE_MS = 3_000
/** ADR-014 item 3: the same wait for the Host's own process group (S15.10). */
export const OWNED_TERM_GRACE_MS = 3_000
/** ADR-014 item 1: the driver's graceful close or interrupt before the tree kill (S15.06). */
export const OWNED_CLOSE_BUDGET_MS = 2_000

const NO_IDENTITY: EndOutcome = { kind: 'failed', reason: 'no-identity' }

export function createSessionTerminator(deps: SessionTerminatorBridgeDeps): SessionTerminator {
  /** S15.09–S15.12 through the kernel; an `ended` identity joins the ended ledger (item 7). */
  async function killTree(
    dwarf: DwarfView,
    identity: ProcessIdentity,
    group: 'owned' | 'foreign'
  ): Promise<EndOutcome> {
    const graceMs = group === 'owned' ? OWNED_TERM_GRACE_MS : OBSERVED_TERM_GRACE_MS
    const outcome = await deps.processes.killTree(identity, { graceMs, group })
    if (outcome.kind === 'ended') deps.endedLedger.recordEnded(dwarf.identity, deps.clock.now())
    return outcome
  }

  /** S15.05, S15.06: interrupt, then close; settles when both answered or the budget ran out. */
  function closeGracefully(session: OwnedSession): Promise<void> {
    const driver = session.driver()
    if (driver === null) return Promise.resolve()
    return new Promise((resolve) => {
      const budget = deps.scheduler.after(OWNED_CLOSE_BUDGET_MS, resolve)
      void (async () => {
        try {
          await driver.interrupt()
          await driver.close('end-thread')
        } catch {
          // A failed close falls through to the tree kill (15 §1.3 `CloseOutcome`).
        }
        budget.cancel()
        resolve()
      })()
    })
  }

  async function endOwned(dwarf: DwarfView): Promise<EndOutcome> {
    const session = deps.owned()?.liveSessionOf(dwarf.id) ?? null
    if (session === null) return { ...NO_IDENTITY }
    await closeGracefully(session)
    if (session.process !== null) return killTree(dwarf, session.process, 'owned')
    // S15.17: with no identity, only the session's own observed exit proves it ended (item 2).
    if (session.driver() !== null) return { ...NO_IDENTITY }
    deps.endedLedger.recordEnded(dwarf.identity, deps.clock.now())
    return { kind: 'ended' }
  }

  // `why` changes nothing on these paths: every reason ends the whole tree (OQ-54); what a reason
  // means for the dwarf afterwards is crew's (06 §5.1).
  async function end(dwarfId: DwarfId, _why: EndReason): Promise<EndOutcome> {
    const dwarf = deps.crew.get(dwarfId)
    if (dwarf === null || dwarf.departed) return { kind: 'ended' }
    if (dwarf.owned) return endOwned(dwarf)
    const identity = deps.observed.processIdentityOf(dwarfId)
    if (identity === null) return { ...NO_IDENTITY }
    return killTree(dwarf, identity, 'foreign')
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
