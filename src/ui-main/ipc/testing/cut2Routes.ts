// The cut-2 release table (ISSUE-141; 21 §2 cut 2) as it shipped, for the suites that prove what cut 2 composed and for
// the rollback cases that start from it. From 3a the release table is `ROUTES` (`../routes.ts`), changed only by each
// step's route-switch issue (22 §5); this is that table with the step-3a switch (ISSUE-001) undone: every row 3a moved,
// qualified or retired one `legacy` route with today's shape, and the NEW rows born `host` in 3a (A-N06, A-N10, A-N11,
// A-N29) unrouted with the step that routes them. Test-only (R14): production never imports it.
// AMENDED for ISSUE-186 (was: from the release table `ROUTES`): it starts from the 3a table as it shipped
// (`cut3aRoutes.ts`), so a later step's switch (3d's A-39) never leaks into it.
import {
  RETIRED,
  UNROUTED,
  type ChannelKey,
  type HostMethod,
  type StepId
} from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { HOST_ROUTE_MEMBERS, LEGACY_BRIDGE_ADAPTERS } from '../routes'
import { CUT_3A_ROUTES } from './cut3aRoutes'

/**
 * The today rows the step-3a switch moved, qualified or retired (21 §2 cut 3a): A-13, A-23, A-25, A-26, A-27, A-35…A-38,
 * A-47…A-50, A-P3, A-P4. Each was served by today's runtime with today's shape in cut 2.
 */
const CUT_3A_TOUCHED: readonly ChannelKey[] = [
  'dwarf:activate', // A-13
  'dwarf:sendText', // A-23
  'dwarf:attachments:describe', // A-25
  'dwarf:kick', // A-26
  'dwarf:retire', // A-27
  'agent:launch', // A-35
  'agent:providers', // A-36
  'agent:models', // A-37
  'agent:launchHeld', // A-38
  'jev:settings:get', // A-47
  'jev:apiKey:set', // A-48
  'jev:apiKey:clear', // A-49
  'jev:route', // A-50
  'agent:launchFailed', // A-P3
  'dwarf:sendText:settled' // A-P4
]

/** The NEW rows the cut-2 table listed in `unrouted.ts`, with the step that routes each. */
export const CUT_2_UNROUTED: Partial<Record<ChannelKey, StepId>> = {
  ...UNROUTED,
  'dwarf:stop': 'cut-3a', // A-N29, born `host` in 3a (ISSUE-171)
  'dwarf:message:retry': 'cut-3a', // A-N06, born `host` in 3a (ISSUE-168)
  'host:recovery:retry': 'cut-3a', // A-N10, born `host` in 3a (ISSUE-174)
  'host:recovery:dismiss': 'cut-3a' // A-N11, born `host` in 3a (ISSUE-174)
}

/** The rows the cut-2 table listed as retired: the step-3a retirements (A-26, A-37, A-38) were not reached yet. */
export const CUT_2_RETIRED: Partial<Record<ChannelKey, StepId>> = Object.fromEntries(
  Object.entries(RETIRED).filter(([, step]) => step !== 'cut-3a')
)

export const CUT_2_ROUTES: readonly ChannelRoute[] = [
  ...CUT_3A_ROUTES.filter(
    (route) =>
      route.since !== 'cut-3a' &&
      !CUT_3A_TOUCHED.includes(route.channel) &&
      CUT_2_UNROUTED[route.channel] === undefined
  ),
  ...CUT_3A_TOUCHED.map((channel): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'pre-cut-0',
    parity: 'n/a',
    shape: 'today'
  }))
]

export const CUT_2_TABLE: RouteTable = {
  release: 'cut-2',
  routes: CUT_2_ROUTES,
  unrouted: CUT_2_UNROUTED,
  retired: CUT_2_RETIRED,
  adapters: LEGACY_BRIDGE_ADAPTERS
}

/** The seam B members of the cut-2 table's `host` routes. */
export const CUT_2_HOST_ROUTE_MEMBERS: Partial<Record<ChannelKey, readonly HostMethod[]>> =
  Object.fromEntries(
    CUT_2_ROUTES.filter((route) => route.owner === 'host').map((route) => [
      route.channel,
      HOST_ROUTE_MEMBERS[route.channel]
    ])
  )
