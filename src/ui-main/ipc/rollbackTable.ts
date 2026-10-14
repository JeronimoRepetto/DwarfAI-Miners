// The rollback table of a cut (21 §2.1 item 1; ADR-001 item 3; procedure: docs/strangler/rollback.md). A rollback is
// a new internal build whose table is the cut's table with the cut's rows flipped back to `legacy`: the legacy code
// is still in the tree until the cut's retirement step. Pure; used only by the router test and by the maintainer who
// builds a rollback (the route rows themselves change only through a step's route-switch issue, 22 §5).
//
// - A row the cut moved off legacy code (`since` is the cut, registry status not 'new') becomes the pre-cut row:
//   `legacy`, today's shape, no shape adapter, `since: 'pre-cut-0'` (every legacy row dates from before cut 0). The
//   cut's qualified routes of one channel fold into that one row (AMENDED for ISSUE-141: the first cut with qualified
//   rows, A-40/A-41 in cut 2; before cut 2 that channel had one owner, today's runtime).
// - A NEW row the cut created keeps its route: no legacy code serves it, and the cut-0 NEW rows are the ones that keep
//   the rollback build attached to its Host and able to stop it (21 §2.1 item 2a; ADR-002 D7, D8). Except (ISSUE-141
//   lead decision, 2026-10-14) a NEW row that makes the Host write a foreign entry whose legacy writer the rollback build
//   composes again (`WRITES_A_FOREIGN_ENTRY`): it is withdrawn, with no route in that build (hidden until built, 21 §1
//   item 8), so the entry keeps one writer (21 §1 item 4, §4).
// - The rows of earlier cuts keep their routes: each earlier cut's retirement already deleted their legacy code, so
//   after a retirement or deletion commit only forward fixes exist (21 §2.1 item 4).
// - A row the cut retired with no route (`RETIRED`, lead resolution H1) is the pre-cut row again: today's runtime
//   still serves it until the cut's retirement step, so the rollback build's renderer finds it where it was.
import { CHANNELS, type ChannelKey, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, RouteTable } from './channelRoute'

/**
 * The NEW rows that turn on an entry the Host writes into another tool's config (21 §4): A-N31 `setClaudeHooksEnabled`
 * and A-N32 `answerWelcome` (the Claude hook entry from cut 2; ADR-016 items 1, 5). A cut-2 rollback build composes
 * today's Claude hook installer again (21 §2 cut 2 row "Rollback"), so these have no route there.
 */
export const WRITES_A_FOREIGN_ENTRY: readonly ChannelKey[] = ['claude:hooks:set', 'welcome:answer']

/** The table of a rollback build of `cut`, from the table `cut`'s release shipped. */
export function rollbackOf(table: RouteTable, cut: StepId): RouteTable {
  if (table.release !== cut) {
    throw new RangeError(
      `a rollback of ${cut} is built from ${cut}'s table, not ${table.release}'s`
    )
  }
  const retired = Object.entries(table.retired ?? {}) as [ChannelKey, StepId][]
  const restored = retired.filter(([, step]) => step === cut).map(([channel]) => preCutRow(channel))
  const withdrawn = table.routes
    .filter((route) => isWithdrawn(route, cut))
    .map((route) => route.channel)
  const routes: ChannelRoute[] = []
  const folded = new Set<ChannelKey>()
  for (const route of table.routes) {
    if (isWithdrawn(route, cut)) continue
    if (!movedBy(route, cut)) {
      routes.push(route)
      continue
    }
    if (folded.has(route.channel)) continue
    folded.add(route.channel)
    routes.push(preCutRow(route.channel))
  }
  return {
    ...table,
    routes: [...routes, ...restored],
    retired: Object.fromEntries(retired.filter(([, step]) => step !== cut)),
    ...(withdrawn.length === 0
      ? {}
      : {
          withdrawn: {
            ...table.withdrawn,
            ...Object.fromEntries(withdrawn.map((channel) => [channel, cut]))
          }
        })
  }
}

/** A row as every legacy row stood before cut 0: today's runtime, today's shape. */
function preCutRow(channel: ChannelKey): ChannelRoute {
  return { channel, owner: 'legacy', since: 'pre-cut-0', parity: 'n/a', shape: 'today' }
}

/** Whether `cut` moved this row off legacy code (a NEW row has none to go back to). */
function movedBy(route: ChannelRoute, cut: StepId): boolean {
  return route.since === cut && CHANNELS[route.channel].status !== 'new'
}

/** Whether a rollback of `cut` withdraws this row: a NEW row of `cut` that writes a foreign entry. */
function isWithdrawn(route: ChannelRoute, cut: StepId): boolean {
  return (
    route.since === cut &&
    CHANNELS[route.channel].status === 'new' &&
    WRITES_A_FOREIGN_ENTRY.includes(route.channel)
  )
}
