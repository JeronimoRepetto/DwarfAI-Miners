// The step-4a release table (ISSUE-235; 21 §2 cut 4a) as it shipped, for the suites that prove what 4a composed and
// for the rollback cases that start from it. From 4b the release table is `routesForBuild` (`../routes.ts`), changed
// only by each step's route-switch issue (22 §5); this is that table with the step-4b switch (ISSUE-238) undone: every
// `host` route 4b added (OpenCode's A-13, A-23, A-35, A-36 and the unqualified A-36 the renderer's one catalog call
// reaches) removed, the unqualified `legacy` routes of the shape adapters back beside Claude's (A-13, A-23, A-35 through
// `PerProviderShapeAdapter`, A-36 through `CatalogMergeAdapter`), and OpenCode's A-27, A-P3, A-P4 back where 4a routed
// them, `legacy` with today's shape. Test-only (R14): production never imports it.
import {
  CATALOG_PROVIDER_IDS,
  RETIRED,
  UNROUTED,
  type ChannelKey,
  type StepId
} from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { LEGACY_BRIDGE_ADAPTERS, routesForBuild } from '../routes'

const [CLAUDE = '', , , OPENCODE = ''] = CATALOG_PROVIDER_IDS

/** The release step of this table. */
export const CUT_4A_RELEASE: StepId = 'cut-4a'

/** The rows 4a retired with no route: `RETIRED` without the entries of 4b (A-27, A-P3, A-P4). */
export const CUT_4A_RETIRED: Partial<Record<ChannelKey, StepId>> = Object.fromEntries(
  Object.entries(RETIRED).filter(([, step]) => step !== 'cut-4b')
)

/** A-13, A-23, A-35 or A-36 for every provider not yet moved, as 3a created it and 4a still shipped it (21 §3.1). */
const throughAdapter = (channel: ChannelKey, shapeAdapter: string): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'cut-3a',
  parity: 'n/a',
  shape: 'target',
  shapeAdapter
})

/** OpenCode's A-27, A-P3 or A-P4 as 3a created it and 4a still shipped it (21 §2 cut 3 common rules). */
const openCodeNotMoved = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'cut-3a',
  parity: 'n/a',
  qualifier: { provider: OPENCODE },
  shape: 'today'
})

/**
 * Each route the step-4b switch removed, placed after the route it followed in 4a: the shape adapters' route after
 * Claude's (the first `host` route of its channel since 3a), A-27 after A-25, A-P3 and A-P4 after A-P2.
 */
const REMOVED_BY_4B: ReadonlyArray<{
  after: (route: ChannelRoute) => boolean
  route: ChannelRoute
}> = [
  ...(['dwarf:activate', 'dwarf:sendText', 'agent:launch'] as const).map((channel) => ({
    after: (route: ChannelRoute) =>
      route.channel === channel && route.qualifier?.provider === CLAUDE,
    route: throughAdapter(channel, 'PerProviderShapeAdapter')
  })),
  {
    after: (route: ChannelRoute) =>
      route.channel === 'agent:providers' && route.qualifier?.provider === CLAUDE,
    route: throughAdapter('agent:providers', 'CatalogMergeAdapter')
  },
  {
    after: (route: ChannelRoute) => route.channel === 'dwarf:attachments:describe',
    route: openCodeNotMoved('dwarf:retire') // A-27
  },
  {
    after: (route: ChannelRoute) => route.channel === 'mines:update',
    route: openCodeNotMoved('agent:launchFailed') // A-P3
  },
  {
    after: (route: ChannelRoute) => route.channel === 'agent:launchFailed',
    route: openCodeNotMoved('dwarf:sendText:settled') // A-P4
  }
]

const sameRoute = (a: ChannelRoute, b: ChannelRoute): boolean =>
  a.channel === b.channel && a.qualifier?.provider === b.qualifier?.provider && a.owner === b.owner

/** A 4a build's table: `DEVELOPMENT_BUILD_ROUTES` added in a development build, as `routesForBuild` does. */
export function cut4aRoutesForBuild(build: { publicBuild: boolean }): readonly ChannelRoute[] {
  const routes: ChannelRoute[] = []
  const place = (route: ChannelRoute): void => {
    routes.push(route)
    for (const removed of REMOVED_BY_4B) {
      if (removed.after(route) && !routes.some((placed) => sameRoute(placed, removed.route))) {
        place(removed.route)
      }
    }
  }
  for (const route of routesForBuild(build)) {
    if (route.since === 'cut-4b') continue
    if (routes.some((placed) => sameRoute(placed, route))) continue
    place(route)
  }
  return routes
}

/** The development build's 4a table. */
export const CUT_4A_ROUTES: readonly ChannelRoute[] = cut4aRoutesForBuild({ publicBuild: false })

export const CUT_4A_TABLE: RouteTable = {
  release: CUT_4A_RELEASE,
  routes: CUT_4A_ROUTES,
  unrouted: UNROUTED,
  retired: CUT_4A_RETIRED,
  adapters: LEGACY_BRIDGE_ADAPTERS
}
