// The cut-0 release table (ISSUE-056; 21 §2 cut 0) as it shipped, for the suites that prove what cut 0 composed and
// for the rollback cases that start from it: the window family and the cut-0 NEW rows `ui-local`, A-N26 `host`
// through `LegacyEndFirstAdapter`, every other today row `legacy` with today's shape (the RETIRE rows included), and
// the NEW rows born later unrouted with the step that routes them. Test-only (R14): production never imports it. From
// cut 1 the release table is `ROUTES` (`../routes.ts`), changed only by each step's route-switch issue (22 §5).
import { CHANNELS, ROW_IDS, type ChannelKey, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from '../channelRoute'
import { LEGACY_BRIDGE_ADAPTERS } from '../routes'

/**
 * The 14 ids cut 0 serves `ui-local` (21 §2 cut 0 "New core serves" U), plus A-N34 (owner-approved amendment
 * 2026-10-01, ISSUE-316).
 */
// prettier-ignore
export const CUT_0_UI_LOCAL_IDS: readonly string[] = [
  'A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'A-07', 'A-08', 'A-09', 'A-10', 'A-11',
  'A-21', 'A-22', 'A-24', 'A-28', 'A-29', 'A-45', 'A-46', 'A-56', 'A-57', 'A-P1', 'A-P6', 'A-X1',
  'A-N03', 'A-N04', 'A-N05', 'A-N30', 'A-N25', 'A-N27', 'A-N34'
]

/** The NEW rows the cut-0 table listed in `unrouted.ts`, with the step that routes each. */
export const CUT_0_UNROUTED: Partial<Record<ChannelKey, StepId>> = {
  'host:connection:confirm-restart': 'generation-2',
  'ui:session:get': 'cut-1',
  'ui:session:patch': 'cut-1',
  'ui:session:changed': 'cut-1',
  'ui:preferences:get': 'cut-1',
  'ui:preferences:set': 'cut-1',
  'ui:preferences:reset': 'cut-1',
  'host:snapshot': 'cut-1',
  'host:event': 'cut-1',
  'mode:revealDwarfChat': 'cut-1',
  // A-N31 was declared after cut 0 shipped (ISSUE-221), born `host` in cut 2: the cut-0 table never routed it.
  'claude:hooks:set': 'cut-2'
}

function cut0Route(channel: ChannelKey): ChannelRoute {
  const isNew = CHANNELS[channel].status === 'new'
  if (CUT_0_UI_LOCAL_IDS.includes(ROW_IDS[channel] ?? '')) {
    return {
      channel,
      owner: 'ui-local',
      since: 'cut-0',
      parity: isNew ? 'n/a' : 'passed',
      shape: 'target'
    }
  }
  if (channel === 'tray:stopEverything:confirm') {
    return { channel, owner: 'host', since: 'cut-0', parity: 'passed', shape: 'target' }
  }
  return { channel, owner: 'legacy', since: 'pre-cut-0', parity: 'n/a', shape: 'today' }
}

export const CUT_0_ROUTES: readonly ChannelRoute[] = (Object.keys(CHANNELS) as ChannelKey[])
  .filter((channel) => CUT_0_UNROUTED[channel] === undefined)
  .map(cut0Route)

export const CUT_0_TABLE: RouteTable = {
  release: 'cut-0',
  routes: CUT_0_ROUTES,
  unrouted: CUT_0_UNROUTED,
  adapters: LEGACY_BRIDGE_ADAPTERS
}
