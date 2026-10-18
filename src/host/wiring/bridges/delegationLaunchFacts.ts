// The `DelegationLaunchFacts` read (16 §5.2 item 5, §5.3; INV-80, INV-81; ISSUE-209): the gate
// facts of a relay's launch, which the delegation endpoint re-reads on every `delegate` call.
//
// - The launch is known through its live token row, which `DwarfLaunched` bound to the launch's
//   dwarf (`bindParent`); the endpoint reads it after it waited for that bind.
// - `launchedWithLetJevChoose` is launching's, read through that dwarf's launch record (09 D-17;
//   16 §4.5 `LaunchQueries.launchedWithLetJevChoose`), so a resumed session keeps its launch's gate.
// - `delegated` is crew's (INV-28): a delegated worker is never gated in (depth 1, INV-81).
// - A launch with no live token, no bound dwarf, or a dwarf crew does not know has no gate (`null`):
//   the endpoint opens nothing for it.
import type { DwarfId } from '../../kernel/domain/values'
import type { DelegationLaunchFacts, DelegationTokenStore } from '../../modules/delegation'

export interface DelegationLaunchFactsDeps {
  tokens: Pick<DelegationTokenStore, 'byLaunch'>
  launching: { launchedWithLetJevChoose(dwarfId: DwarfId): boolean }
  crew: { get(dwarfId: DwarfId): { delegated: boolean } | null }
}

export function createDelegationLaunchFacts(
  deps: DelegationLaunchFactsDeps
): DelegationLaunchFacts {
  return {
    gateOf: (launchId) => {
      const parent = deps.tokens.byLaunch(launchId)?.parentDwarfId ?? null
      if (parent === null) return null
      const dwarf = deps.crew.get(parent)
      if (dwarf === null) return null
      return {
        launchedWithLetJevChoose: deps.launching.launchedWithLetJevChoose(parent),
        delegated: dwarf.delegated
      }
    }
  }
}
