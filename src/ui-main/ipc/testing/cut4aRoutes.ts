// The step-4a release table (ISSUE-235; 21 §2 cut 4a) as it shipped, for the suites that prove what 4a composed and
// for the rollback cases that start from it. From 4b the release table is `routesForBuild` (`../routes.ts`), changed
// only by each step's route-switch issue (22 §5); this is that table with the step-4b switch (ISSUE-238) undone: every
// `host` route 4b added (OpenCode's A-13, A-23, A-35, A-36 and the unqualified A-36 the renderer's one catalog call
// reaches) removed, the unqualified `legacy` routes of the shape adapters back beside Claude's (A-13, A-23, A-35 through
// `PerProviderShapeAdapter`, A-36 through `CatalogMergeAdapter`), and OpenCode's A-27, A-P3, A-P4 back where 4a routed
// them, `legacy` with today's shape. Test-only (R14): production never imports it.
// AMENDED for ISSUE-241, the end of cut 4: the release table no longer has A-40/A-41's `legacy` routes through
// `LegacyAnswerShapeAdapter`, one per origin of the relay's `legacy:` AskIds, which cut 2 created and 4a still shipped,
// so they are back after each row's `host` route too (`LEGACY_ANSWER_ROUTES`).
// AMENDED for ISSUE-242, the first cut-5 deletion: the release table no longer has A-12 and A-P2, which every release
// from cut 1 to 4b routed `host` through `BoardFacadeAdapter`, so they are back where 4a routed them
// (`REMOVED_BY_BOARD_FACADE_DELETION`), with their seam B members (`HOST_ROUTE_MEMBERS_AS_SHIPPED`).
// AMENDED for ISSUE-243, the deletion of today's runtime: the release table no longer has 14 §8 I-21's `dwarf:setName`
// and `dwarf:resetName`, which every release up to 4b served `legacy` with today's shape, so they are back where 4a
// routed them (`REMOVED_BY_RUNTIME_DELETION`).
import {
  CATALOG_PROVIDER_IDS,
  RETIRED,
  UNROUTED,
  type ChannelKey,
  type StepId
} from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import type { HostMethod } from '@dwarfai/contracts'
import { HOST_ROUTE_MEMBERS, routesForBuild } from '../routes'
import { ADAPTERS_AS_SHIPPED } from './adaptersAsShipped'

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

/** A-40 or A-41's `legacy` route for one origin, as cut 2 created it and 4a still shipped it (21 §3.1). */
const legacyAnswer = (
  channel: ChannelKey,
  origin: 'legacy-launch' | 'legacy-ask-channel'
): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'cut-2',
  parity: 'n/a',
  qualifier: { origin },
  shape: 'target',
  shapeAdapter: 'LegacyAnswerShapeAdapter'
})

/** The routes the ISSUE-241 deletion removed: each answer row's two origins, after the row's `host` route. */
const LEGACY_ANSWER_ROUTES = (['agent:answerQuestion', 'agent:answerPermission'] as const).flatMap(
  (channel) =>
    (['legacy-launch', 'legacy-ask-channel'] as const).map((origin) => ({
      after: (route: ChannelRoute) =>
        route.channel === channel && route.owner === 'host' && route.qualifier === undefined,
      route: legacyAnswer(channel, origin)
    }))
)

/** A-12 or A-P2 as the cut-1 switch routed it and 4a still shipped it, through `BoardFacadeAdapter` (21 §3). */
const throughBoardFacade = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-1',
  parity: 'passed',
  shape: 'target'
})

/** The routes the ISSUE-242 deletion removed: A-12 after A-11, A-P2 after A-P1. */
const REMOVED_BY_BOARD_FACADE_DELETION = [
  {
    after: (route: ChannelRoute) => route.channel === 'shortcut:set',
    route: throughBoardFacade('mines:get') // A-12
  },
  {
    after: (route: ChannelRoute) => route.channel === 'panel:visible:changed',
    route: throughBoardFacade('mines:update') // A-P2
  }
]

/** 14 §8 I-21's legacy rename or reset as every release up to 4b served it: today's runtime, today's shape. */
const servedToday = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'pre-cut-0',
  parity: 'n/a',
  shape: 'today'
})

/** The routes the ISSUE-243 deletion removed: `dwarf:setName` after A-X1, `dwarf:resetName` after it. */
const REMOVED_BY_RUNTIME_DELETION = [
  {
    after: (route: ChannelRoute) => route.channel === 'pathForDroppedFile',
    route: servedToday('dwarf:setName')
  },
  {
    after: (route: ChannelRoute) => route.channel === 'dwarf:setName',
    route: servedToday('dwarf:resetName')
  }
]

/**
 * The seam B members of every `host` route the releases up to 4b shipped: the release's, and A-12 and A-P2's, the
 * facade's reading of the Host board (the snapshot, then the frames).
 */
export const HOST_ROUTE_MEMBERS_AS_SHIPPED: Partial<Record<ChannelKey, readonly HostMethod[]>> = {
  ...HOST_ROUTE_MEMBERS,
  'mines:get': ['session.snapshot', 'events.subscribe'],
  'mines:update': ['session.snapshot', 'events.subscribe']
}

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
  },
  ...LEGACY_ANSWER_ROUTES,
  ...REMOVED_BY_BOARD_FACADE_DELETION,
  ...REMOVED_BY_RUNTIME_DELETION
]

const sameRoute = (a: ChannelRoute, b: ChannelRoute): boolean =>
  a.channel === b.channel &&
  JSON.stringify(a.qualifier ?? {}) === JSON.stringify(b.qualifier ?? {}) &&
  a.owner === b.owner

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
  adapters: ADAPTERS_AS_SHIPPED
}
