// The step-3d release table (ISSUE-186; 21 §2 cut 3d) as it shipped, for the suites that prove what 3d composed and
// for the rollback cases that start from it. From 3e the release table is a development build's `routesForBuild`
// (`../routes.ts`), changed only by each step's route-switch issue (22 §5); this is that table with the step-3e switch
// (ISSUE-188) undone: the Antigravity `host` routes 3e added (A-13, A-23, A-35, A-36) removed, so Antigravity reaches
// the shape adapters again, and the Antigravity `legacy` route of A-27, A-P3 and A-P4 back beside OpenCode's, as 3d had
// it. Test-only (R14): production never imports it.
//
// AMENDED for ISSUE-235 (was: from the release table `routesForBuild`): from the step-4a switch the release table is
// 4a's, so the 3d table starts from the 3e development build's table as it shipped (`cut3eRoutes.ts`).
import { CATALOG_PROVIDER_IDS, UNROUTED, type ChannelKey, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { ADAPTERS_AS_SHIPPED } from './adaptersAsShipped'
import { CUT_3E_ROUTES } from './cut3eRoutes'
// AMENDED for ISSUE-238 (was: `RETIRED`, the release's list): from 4b the release retires A-27, A-P3 and A-P4, which
// this release still routed, so its table lists the 4a retirements (`cut4aRoutes.ts`).
import { CUT_4A_RETIRED } from './cut4aRoutes'

const [, , ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS

/** The release step of this table. */
export const CUT_3D_RELEASE: StepId = 'cut-3d'

/** A-27, A-P3, A-P4: `legacy` with today's shape, qualified to each provider not yet moved (21 §2 cut 3 rules). */
const NOT_MOVED_ROWS: readonly ChannelKey[] = [
  'dwarf:retire', // A-27
  'agent:launchFailed', // A-P3
  'dwarf:sendText:settled' // A-P4
]

/** Antigravity's A-27, A-P3 or A-P4 route as 3a, 3b and 3d shipped it. */
const antigravityNotMoved = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'cut-3a',
  parity: 'n/a',
  qualifier: { provider: ANTIGRAVITY },
  shape: 'today'
})

/** The development build's table: 3d had no build-only row, so every 3d row is in it. */
const RELEASE_ROUTES = CUT_3E_ROUTES

const hasAntigravityRow = (channel: ChannelKey): boolean =>
  RELEASE_ROUTES.some(
    (route) => route.channel === channel && route.qualifier?.provider === ANTIGRAVITY
  )

export const CUT_3D_ROUTES: readonly ChannelRoute[] = RELEASE_ROUTES.filter(
  (route) => route.since !== 'cut-3e'
).flatMap((route) =>
  NOT_MOVED_ROWS.includes(route.channel) &&
  route.qualifier?.provider === OPENCODE &&
  !hasAntigravityRow(route.channel)
    ? [antigravityNotMoved(route.channel), route]
    : [route]
)

export const CUT_3D_TABLE: RouteTable = {
  release: CUT_3D_RELEASE,
  routes: CUT_3D_ROUTES,
  unrouted: UNROUTED,
  retired: CUT_4A_RETIRED,
  adapters: ADAPTERS_AS_SHIPPED
}
