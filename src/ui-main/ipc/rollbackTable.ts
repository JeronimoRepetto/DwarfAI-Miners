// The rollback table of a cut (21 §2.1 item 1; ADR-001 item 3; procedure: docs/strangler/rollback.md). A rollback is
// a new internal build whose table is the cut's table with the cut's rows flipped back to `legacy`: the legacy code
// is still in the tree until the cut's retirement step. Pure; used only by the router test and by the maintainer who
// builds a rollback (the route rows themselves change only through a step's route-switch issue, 22 §5).
//
// - A row the cut moved off legacy code (`since` is the cut, registry status not 'new') becomes the pre-cut row:
//   `legacy`, today's shape, no shape adapter, `since: 'pre-cut-0'` (every legacy row dates from before cut 0).
// - A NEW row the cut created keeps its route: no legacy code serves it, and the cut-0 NEW rows are the ones that keep
//   the rollback build attached to its Host and able to stop it (21 §2.1 item 2a; ADR-002 D7, D8).
// - The rows of earlier cuts keep their routes: each earlier cut's retirement already deleted their legacy code, so
//   after a retirement or deletion commit only forward fixes exist (21 §2.1 item 4).
import { CHANNELS, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from './channelRoute'

/** The table of a rollback build of `cut`, from the table `cut`'s release shipped. */
export function rollbackOf(table: RouteTable, cut: StepId): RouteTable {
  if (table.release !== cut) {
    throw new RangeError(
      `a rollback of ${cut} is built from ${cut}'s table, not ${table.release}'s`
    )
  }
  return { ...table, routes: table.routes.map((route) => flipped(route, cut)) }
}

function flipped(route: ChannelRoute, cut: StepId): ChannelRoute {
  if (route.since !== cut || CHANNELS[route.channel].status === 'new') return route
  return {
    channel: route.channel,
    owner: 'legacy',
    since: 'pre-cut-0',
    parity: 'n/a',
    ...(route.qualifier === undefined ? {} : { qualifier: route.qualifier }),
    shape: 'today'
  }
}
