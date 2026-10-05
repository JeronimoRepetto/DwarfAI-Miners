// `LegacyLaunchObservation` (21 §3, cuts 1–4b; 14 §5; ADR-001 Consequences; 13 FM-094): a session the legacy runtime
// launched is an ordinary **observed** session for the Host. It is not owned by the Host: the Host observer finds it
// in its provider's own files, by its provider identity, like any session started outside DwarfAI, and shows it once.
// The legacy runtime keeps its own channel to that launch (its launched register: the rows still `legacy` that stop
// or end it, A-27 and the `LegacyEndFirstAdapter` path of A-N26).
//
// What the bridge composes is therefore only that channel, unchanged. It composes no legacy observation path for the
// launch (no poller, no board publish: the legacy observer is off from cut 1, so no session is counted twice), and it
// has no Host command path: it is handed nothing of the Host, so it can neither claim the session as owned nor feed
// the Host a second copy of what the observer reads (AGENTS §5; FM-094: one fact, one path).
//
// Candidate decision (21 §6): today's launched register (`LegacyLaunchRegister` over the legacy
// `LaunchedSessionRegistry`, reached through `LegacyRuntimeRoute`) is KEPT unchanged as the channel; nothing of the
// legacy launch path is rewritten. Deleted at the end of 4b with the last legacy launch path (ISSUE-240).
import type { LegacyLaunchedSessions } from './LegacyEndFirstAdapter'

export interface LegacyLaunchObservation {
  /** The legacy runtime's own launch channel, for the rows still `legacy` that end its launches. */
  readonly channel: LegacyLaunchedSessions
}

export function createLegacyLaunchObservation(deps: {
  /** Today's launched register, reached through `LegacyRuntimeRoute`. */
  launches: LegacyLaunchedSessions
}): LegacyLaunchObservation {
  const { launches } = deps
  return {
    channel: {
      liveLaunches: () => launches.liveLaunches(),
      endLaunch: (launchId) => launches.endLaunch(launchId)
    }
  }
}
