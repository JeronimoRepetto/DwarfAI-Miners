// The step-3e release table (ISSUE-188; 21 §2 cut 3e) as it shipped, for the suites that prove what 3e composed and
// for the rollback cases that start from it. From 4a the release table is `routesForBuild` (`../routes.ts`), changed
// only by each step's route-switch issue (22 §5); this is the development build's table with the step-4a switch
// (ISSUE-235) undone: every row 4a moved to the Host (A-33, A-42, A-43, A-47, A-51…A-55) back where 3e routed it, A-33
// through `ResetFanout`, A-47 through `JevSettingsShapeAdapter`, the others `legacy` with today's shape. Test-only
// (R14): production never imports it.
import { UNROUTED, type ChannelKey, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { ADAPTERS_AS_SHIPPED } from './adaptersAsShipped'
// AMENDED for ISSUE-238 (was: from the release table `routesForBuild` and `RETIRED`): from the step-4b switch the
// release table is 4b's, so the 3e table starts from the 4a build's table as it shipped (`cut4aRoutes.ts`).
import { CUT_4A_RETIRED, cut4aRoutesForBuild } from './cut4aRoutes'

/** The release step of this table. */
export const CUT_3E_RELEASE: StepId = 'cut-3e'

const legacyToday = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'pre-cut-0',
  parity: 'n/a',
  shape: 'today'
})

/** Each row the step-4a switch moved, as 3e routed it. */
const AS_3E_ROUTED: Partial<Record<ChannelKey, ChannelRoute>> = {
  'metrics:reset': {
    channel: 'metrics:reset', // A-33
    owner: 'legacy',
    since: 'cut-1',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: 'ResetFanout'
  },
  'notifications:enabled:get': legacyToday('notifications:enabled:get'), // A-42
  'notifications:enabled:set': legacyToday('notifications:enabled:set'), // A-43
  'jev:settings:get': {
    channel: 'jev:settings:get', // A-47
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: 'JevSettingsShapeAdapter'
  },
  'jev:preferences:set': legacyToday('jev:preferences:set'), // A-51
  'opencode:settings:get': legacyToday('opencode:settings:get'), // A-52
  'opencode:plugin:set': legacyToday('opencode:plugin:set'), // A-53
  'opencode:password:set': legacyToday('opencode:password:set'), // A-54
  'opencode:password:clear': legacyToday('opencode:password:clear') // A-55
}

/** A 3e build's table: `DEVELOPMENT_BUILD_ROUTES` added in a development build, as `routesForBuild` does. */
export function cut3eRoutesForBuild(build: { publicBuild: boolean }): readonly ChannelRoute[] {
  return cut4aRoutesForBuild(build).map((route) => {
    if (route.since !== 'cut-4a') return route
    const before = AS_3E_ROUTED[route.channel]
    if (before === undefined) throw new RangeError(`no 3e route for ${route.channel}`)
    return before
  })
}

/** The development build's 3e table. */
export const CUT_3E_ROUTES: readonly ChannelRoute[] = cut3eRoutesForBuild({ publicBuild: false })

export const CUT_3E_TABLE: RouteTable = {
  release: CUT_3E_RELEASE,
  routes: CUT_3E_ROUTES,
  unrouted: UNROUTED,
  retired: CUT_4A_RETIRED,
  adapters: ADAPTERS_AS_SHIPPED
}
