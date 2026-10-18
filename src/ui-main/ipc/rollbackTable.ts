// The rollback table of a cut (21 §2.1 item 1; ADR-001 item 3; procedure: docs/strangler/rollback.md). A rollback is
// a new internal build whose table is the cut's table with the cut's rows flipped back to `legacy`: the legacy code
// is still in the tree until the cut's retirement step. Pure; used only by the router test and by the maintainer who
// builds a rollback (the route rows themselves change only through a step's route-switch issue, 22 §5).
//
// - A row the cut moved off legacy code (`since` is the cut, registry status not 'new') becomes the pre-cut row:
//   `legacy`, today's shape, no shape adapter, `since: 'pre-cut-0'` (every legacy row dates from before cut 0). The
//   cut's qualified routes of one channel fold into that one row (AMENDED for ISSUE-141: the first cut with qualified
//   rows, A-40/A-41 in cut 2; before cut 2 that channel had one owner, today's runtime). Except a channel whose cut
//   qualified routes reach today's runtime through a 21 §3.1 shape adapter (A-40/A-41 through
//   `LegacyAnswerShapeAdapter`; the first qualified rows, so no earlier cut's rollback changes): the
//   rollback build keeps this tree's preload and renderer, which speak the row's target shape, so it folds into ONE
//   unqualified `legacy` row with `shape: 'target'` and that adapter (ISSUE-141, verifier finding 2026-10-14).
//   AMENDED for ISSUE-001 (was: the adapter of a qualified `legacy` route only): from step 3a the providers not yet
//   moved reach today's runtime through an UNQUALIFIED `legacy` route with its adapter (A-13, A-23, A-35 through
//   `PerProviderShapeAdapter`, A-36 through `CatalogMergeAdapter`), so a qualified channel folds into the cut's
//   `legacy` + `target` adapter route, qualified or not.
// - A NEW row the cut created keeps its route: no legacy code serves it, and the cut-0 NEW rows are the ones that keep
//   the rollback build attached to its Host and able to stop it (21 §2.1 item 2a; ADR-002 D7, D8). Except (ISSUE-141
//   lead decision, 2026-10-14) a NEW row that makes the Host write a foreign entry whose legacy writer the rollback build
//   composes again (`WRITES_A_FOREIGN_ENTRY`): it is withdrawn, with no route in that build (hidden until built, 21 §1
//   item 8), so the entry keeps one writer (21 §1 item 4, §4).
// - A row the cut moved that reads or writes a secret the cut's `SecretMigrationBridge` run moved into the Host and
//   deleted from today's files (`KEPT_WITH_THE_MIGRATED_SECRET`; ISSUE-001, docs/strangler/rollback.md) keeps its
//   route: today's runtime no longer holds the secret, and a rollback build never moves it back (ADR-017 items 1, 8;
//   21 §2 cut 4a "Rollback": after the bridge deletes the legacy file, roll forward).
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

/**
 * The rows a rollback of their step keeps where the step's table routes them, because the step's one-time
 * `SecretMigrationBridge` run moved the secret they read or write into the Host's `SecretStore` and deleted today's file
 * (ADR-017 item 8): from 3a the Jev key, A-48 `setJevApiKey`, A-49 `clearJevApiKey`, A-50 `routeJevLaunch` (which
 * suggests with that key) and A-47 `getJevSettings` (the key's status from the Host, through `JevSettingsShapeAdapter`).
 */
export const KEPT_WITH_THE_MIGRATED_SECRET: Partial<Record<ChannelKey, StepId>> = {
  'jev:apiKey:set': 'cut-3a',
  'jev:apiKey:clear': 'cut-3a',
  'jev:route': 'cut-3a',
  'jev:settings:get': 'cut-3a'
}

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
    if (!movedBy(route, cut) || KEPT_WITH_THE_MIGRATED_SECRET[route.channel] === cut) {
      routes.push(route)
      continue
    }
    if (folded.has(route.channel)) continue
    folded.add(route.channel)
    routes.push(foldedRow(table, route.channel, cut))
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

/**
 * The one row a rollback folds a moved channel into: the pre-cut row, or, where the cut's qualified routes reached
 * today's runtime for it through a shape adapter, that adapter's unqualified `legacy` + `target` row.
 */
function foldedRow(table: RouteTable, channel: ChannelKey, cut: StepId): ChannelRoute {
  const ofCut = table.routes.filter((route) => route.channel === channel && route.since === cut)
  const adapter = ofCut.some((route) => route.qualifier !== undefined)
    ? ofCut.find(
        (route) =>
          route.owner === 'legacy' && route.shape === 'target' && route.shapeAdapter !== undefined
      )?.shapeAdapter
    : undefined
  if (adapter === undefined) return preCutRow(channel)
  return {
    channel,
    owner: 'legacy',
    since: cut,
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: adapter
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
