// The step-3b release table (ISSUE-002; 21 §2 cut 3b) as it shipped, for the suites that prove what 3b composed and
// for the rollback cases that start from it. From 3d the release table is `ROUTES` (`../routes.ts`), changed only by
// each step's route-switch issue (22 §5); this is that table with the step-3d switch (ISSUE-186) undone: the "Other…"
// `host` routes 3d added (A-13, A-23, A-35) removed, so an "Other…" dwarf reaches `PerProviderShapeAdapter` again, and
// A-39 back on today's runtime with today's shape, as every table before 3d had it. Test-only (R14): production never
// imports it.
import { RETIRED, UNROUTED, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { LEGACY_BRIDGE_ADAPTERS, ROUTES } from '../routes'

/** The release step of this table. */
export const CUT_3B_RELEASE: StepId = 'cut-3b'

/** A-39 as every table before 3d routed it: today's runtime, today's shape (21 §3.1 "switch in the moving cut"). */
const LAUNCH_HOSTED_BEFORE_3D: ChannelRoute = {
  channel: 'agent:launchHosted',
  owner: 'legacy',
  since: 'pre-cut-0',
  parity: 'n/a',
  shape: 'today'
}

export const CUT_3B_ROUTES: readonly ChannelRoute[] = ROUTES.flatMap((route) => {
  if (route.since !== 'cut-3d') return [route]
  return route.channel === LAUNCH_HOSTED_BEFORE_3D.channel ? [LAUNCH_HOSTED_BEFORE_3D] : []
})

export const CUT_3B_TABLE: RouteTable = {
  release: CUT_3B_RELEASE,
  routes: CUT_3B_ROUTES,
  unrouted: UNROUTED,
  retired: RETIRED,
  adapters: LEGACY_BRIDGE_ADAPTERS
}
