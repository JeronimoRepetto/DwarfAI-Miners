// The cut-1 release table (ISSUE-123; 21 §2 cut 1) as it shipped, for the suites that prove what cut 1 composed and
// for the rollback and retirement cases that start from it. From cut 2 the release table is `ROUTES` (`../routes.ts`),
// changed only by each step's route-switch issue (22 §5); this is that table with the cut-2 switch (ISSUE-141) undone:
// A-40 and A-41 one `legacy` route with today's shape each, and the NEW rows born `host` in cut 2 (A-N07, A-N31, A-N32)
// unrouted with the step that routes them. Test-only (R14): production never imports it.
//
// AMENDED for ISSUE-001 (was: derived from the release's `ROUTES`, `UNROUTED` and `RETIRED`): from the step-3a switch
// the release table is 3a's, so the cut-1 table is derived from the cut-2 table as it shipped (`cut2Routes.ts`).
import { type ChannelKey, type HostMethod, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { HOST_ROUTE_MEMBERS } from '../routes'
import { ADAPTERS_AS_SHIPPED } from './adaptersAsShipped'
import { CUT_2_RETIRED, CUT_2_ROUTES, CUT_2_UNROUTED } from './cut2Routes'

/** The rows the cut-2 switch moved off today's runtime: A-40 and A-41, served by today's runtime in cut 1. */
const CUT_2_MOVED: readonly ChannelKey[] = ['agent:answerQuestion', 'agent:answerPermission']

/** The NEW rows the cut-1 table listed in `unrouted.ts`, with the step that routes each. */
export const CUT_1_UNROUTED: Partial<Record<ChannelKey, StepId>> = {
  ...CUT_2_UNROUTED,
  'claude:hooks:set': 'cut-2', // A-N31, born `host` in cut 2 (ISSUE-221)
  'ask:step:set': 'cut-2', // A-N07, born `host` in cut 2 (ISSUE-129)
  'welcome:answer': 'cut-2', // A-N32, born `host` in cut 2 (ISSUE-223)
  'dwarf:rename': 'cut-2', // A-N08, born `host` in cut 2 (ISSUE-172 lead decision)
  'dwarf:name:reset': 'cut-2' // A-N09, born `host` in cut 2 (ISSUE-172 lead decision)
}

export const CUT_1_ROUTES: readonly ChannelRoute[] = [
  ...CUT_2_ROUTES.filter((route) => route.since !== 'cut-2'),
  ...CUT_2_MOVED.map((channel): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'pre-cut-0',
    parity: 'n/a',
    shape: 'today'
  }))
]

export const CUT_1_TABLE: RouteTable = {
  release: 'cut-1',
  routes: CUT_1_ROUTES,
  unrouted: CUT_1_UNROUTED,
  retired: CUT_2_RETIRED,
  adapters: ADAPTERS_AS_SHIPPED
}

/** The seam B members of the cut-1 table's `host` routes. */
export const CUT_1_HOST_ROUTE_MEMBERS: Partial<Record<ChannelKey, readonly HostMethod[]>> =
  Object.fromEntries(
    CUT_1_ROUTES.filter((route) => route.owner === 'host').map((route) => [
      route.channel,
      HOST_ROUTE_MEMBERS[route.channel]
    ])
  )
