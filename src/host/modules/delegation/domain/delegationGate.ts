// The delegation gate (06 §11 `DelegationGate.allows`; ADR-013 item 4; 07 §8 "(gate)"; C-26).
//
// Both gates together, and only for a launch that was not itself delegated:
// - the Host preference "Subagent delegation" (`subagentDelegationOn`, off on a fresh install,
//   09 §4.8) is on, and
// - the parent's own launch used "Let Jev choose" (`launchedWithLetJevChoose`);
// either alone is not enough (PO #50, INV-80). A delegated worker's launch never opens it,
// whatever the setting (depth 1, INV-81): its launch row has `launched_with_let_jev_choose = 0`
// (09 D-17), and `delegated` is checked on its own so depth 1 never rests on that one column.
//
// The gate is read at injection (`DelegationLifecycle.issueFor`) and again on every call
// (`DelegationEndpoint.delegate`, S8.02); turning the setting off gates new attempts only, never
// one in flight (S8.10). Pure: no I/O, no clock (05 §2.2, R1).

/** What the gate reads of the Host preferences (06 §14.2 `HostPreferences`). */
export interface DelegationGatePreferences {
  readonly subagentDelegationOn: boolean
}

/** What the gate reads of the parent's launch record (06 `LaunchRecord`; 09 D-17). */
export interface DelegationGateLaunch {
  readonly launchedWithLetJevChoose: boolean
  readonly delegated: boolean
}

/** True only with both gates open and a launch that was not delegated (INV-80, INV-81). */
export function allows(
  preferences: DelegationGatePreferences,
  launch: DelegationGateLaunch
): boolean {
  if (launch.delegated) return false
  return preferences.subagentDelegationOn && launch.launchedWithLetJevChoose
}

/** 06 §11 `DelegationGate`. */
export const DelegationGate = { allows } as const
