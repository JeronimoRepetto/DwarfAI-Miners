// The step-3a release table (ISSUE-001; 21 §2 cut 3a) as it shipped, for the suites that prove what 3a composed and
// for the rollback cases that start from it. AMENDED for ISSUE-186 (was: from the release table `ROUTES`): it starts
// from the 3b table as it shipped (`cut3bRoutes.ts`, the release table with the step-3d switch undone) and undoes the
// step-3b switch (ISSUE-002): the Codex
// `host` routes 3b added (A-13, A-23, A-35, A-36) removed, so Codex reaches the shape adapters again, and the Codex
// `legacy` route of A-27, A-P3 and A-P4 back beside the other providers not moved in 3a. Test-only (R14): production
// never imports it.
import { CATALOG_PROVIDER_IDS, UNROUTED, type ChannelKey, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { ADAPTERS_AS_SHIPPED } from './adaptersAsShipped'
import { CUT_3B_ROUTES } from './cut3bRoutes'
// AMENDED for ISSUE-238 (was: `RETIRED`, the release's list): from 4b the release retires A-27, A-P3 and A-P4, which
// this release still routed, so its table lists the 4a retirements (`cut4aRoutes.ts`).
import { CUT_4A_RETIRED } from './cut4aRoutes'

const [, CODEX = '', ANTIGRAVITY = ''] = CATALOG_PROVIDER_IDS

/** The release step of this table. */
export const CUT_3A_RELEASE: StepId = 'cut-3a'

/** A-27, A-P3, A-P4: `legacy` with today's shape, qualified to each provider not yet moved (21 §2 cut 3 rules). */
const NOT_MOVED_ROWS: readonly ChannelKey[] = [
  'dwarf:retire', // A-27
  'agent:launchFailed', // A-P3
  'dwarf:sendText:settled' // A-P4
]

/** Codex's A-27, A-P3 or A-P4 route as 3a shipped it. */
const codexNotMoved = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'cut-3a',
  parity: 'n/a',
  qualifier: { provider: CODEX },
  shape: 'today'
})

const hasCodexRow = (channel: ChannelKey): boolean =>
  CUT_3B_ROUTES.some((route) => route.channel === channel && route.qualifier?.provider === CODEX)

export const CUT_3A_ROUTES: readonly ChannelRoute[] = CUT_3B_ROUTES.filter(
  (route) => route.since !== 'cut-3b'
).flatMap((route) =>
  NOT_MOVED_ROWS.includes(route.channel) &&
  route.qualifier?.provider === ANTIGRAVITY &&
  !hasCodexRow(route.channel)
    ? [codexNotMoved(route.channel), route]
    : [route]
)

export const CUT_3A_TABLE: RouteTable = {
  release: CUT_3A_RELEASE,
  routes: CUT_3A_ROUTES,
  unrouted: UNROUTED,
  retired: CUT_4A_RETIRED,
  adapters: ADAPTERS_AS_SHIPPED
}
