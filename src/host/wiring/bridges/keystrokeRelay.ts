// The asking `KeystrokeRelay` bridge (ADR-012 item 3; ADR-014 item 1; #1285, the cut-2 slice of
// ISSUE-167): the observed-Claude keystroke channel's one key — `1` for Allow, `Esc` for Deny —
// goes into the terminal of the dwarf's observed session through conversation's observed-session
// key delivery (`ConsoleKeystrokeDelivery`), aimed at the process identity observation recorded
// for that session (pid + start time + boot), which the delivery re-checks just before writing.
// It replaces `NO_KEYSTROKE_RELAY`, which refused every key.
//
// Refused, with nothing pressed, when there is no positively identified target:
// - the dwarf is unknown or departed (its session is gone);
// - the dwarf is owned: owned Claude sessions never use this channel (ADR-012 item 4);
// - the dwarf's observed session is not the one the dialog was read from (`providerSessionId`);
// - observation recorded no process identity for it (ADR-014 item 2: no pid heuristic).
// Only the dwarf id and the process identity cross it; nothing is logged here.
import type { KeystrokeRelay } from '../../modules/asking/adapters/observedClaude/ObservedClaudeKeystrokeChannel'
import type { ConsoleKeystrokeDelivery } from '../../modules/conversation/adapters/observed-send/ConsoleKeystrokeDelivery'
import type { CrewQueries } from '../../modules/crew'
import type { ObservedProcessIdentities } from '../../modules/observation'

export interface KeystrokeRelayBridgeDeps {
  crew: Pick<CrewQueries, 'get'>
  /** Observation's read of the process identity its adapter recorded for an observed session. */
  observed: ObservedProcessIdentities
  /** Conversation's observed-session key delivery (identity re-checked just before writing). */
  delivery: Pick<ConsoleKeystrokeDelivery, 'press'>
}

export function createKeystrokeRelay(deps: KeystrokeRelayBridgeDeps): KeystrokeRelay {
  return {
    async press(target, key) {
      const dwarf = deps.crew.get(target.dwarfId)
      if (dwarf === null || dwarf.departed || dwarf.owned) return 'refused'
      if (dwarf.identity.providerSessionId !== target.providerSessionId) return 'refused'
      const identity = deps.observed.processIdentityOf(target.dwarfId)
      if (identity === null) return 'refused'
      try {
        return (await deps.delivery.press(identity, key)) === 'pressed' ? 'pressed' : 'refused'
      } catch {
        return 'refused'
      }
    }
  }
}
