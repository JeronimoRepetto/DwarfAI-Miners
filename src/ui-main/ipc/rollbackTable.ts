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
// - AMENDED for ISSUE-002: a later provider step (3b, 3d, 3e, 4b) moves one more provider beside a shape-adapter route
//   an earlier step created (21 §2 cut 3 "Rollback (each step)": the provider-qualified rows flip back). Its
//   provider-qualified `host` route is dropped, so that provider reaches the earlier step's unqualified `legacy`
//   adapter route again, and every channel whose routes are all provider-qualified `legacy` rows of the providers not
//   yet moved (A-27, A-P3, A-P4) gets that provider's row back, as the earlier step's table had it.
//   AMENDED for ISSUE-186 (was: every flipped-back provider): only a catalog provider gets those rows back. Step 3d
//   moves "Other…", which is outside the catalog (INV-43) and never had an A-27, A-P3 or A-P4 row; its A-39 is a row
//   the step moved, so it becomes the pre-cut row like any other.
// - A NEW row the cut created keeps its route: no legacy code serves it, and the cut-0 NEW rows are the ones that keep
//   the rollback build attached to its Host and able to stop it (21 §2.1 item 2a; ADR-002 D7, D8). Except (ISSUE-141
//   lead decision, 2026-10-14) a NEW row that makes the Host write a foreign entry whose legacy writer the rollback build
//   composes again (`WRITES_A_FOREIGN_ENTRY`): it is withdrawn, with no route in that build (hidden until built, 21 §1
//   item 8), so the entry keeps one writer (21 §1 item 4, §4).
// - A row the cut moved that reads or writes a secret the cut's `SecretMigrationBridge` run moved into the Host and
//   deleted from today's files (`KEPT_WITH_THE_MIGRATED_SECRET`; ISSUE-001, docs/strangler/rollback.md) keeps its
//   route: today's runtime no longer holds the secret, and a rollback build never moves it back (ADR-017 items 1, 8;
//   21 §2 cut 4a "Rollback": after the bridge deletes the legacy file, roll forward).
// - AMENDED for ISSUE-235: a row the cut moved off a 21 §3.1 shape adapter an earlier cut composed for it
//   (`BACK_THROUGH_ITS_SHAPE_ADAPTER`: A-33 off `ResetFanout`, A-47 off `JevSettingsShapeAdapter`, both in 4a) goes back
//   to that adapter's `legacy` + `target` row, because the rollback build keeps this tree's preload and renderer, which
//   speak the row's target shape. The rollback table lists that adapter as living in the cut again: its code is in the
//   tree until the cut's retirement step (21 §2.1 item 1), whatever the cuts 21 §3 gives it in a forward release.
// - The rows of earlier cuts keep their routes: each earlier cut's retirement already deleted their legacy code, so
//   after a retirement or deletion commit only forward fixes exist (21 §2.1 item 4).
// - A row the cut retired with no route (`RETIRED`, lead resolution H1) is the pre-cut row again: today's runtime
//   still serves it until the cut's retirement step, so the rollback build's renderer finds it where it was.
import { CATALOG_PROVIDER_IDS, CHANNELS, type ChannelKey, type StepId } from '@dwarfai/contracts'
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
 * AMENDED for ISSUE-235: from 4a the OpenCode password (21 §2 cut 4a "Rollback": after the bridge deletes the legacy
 * file, roll forward), A-54 `setOpenCodeServerPassword`, A-55 `clearOpenCodeServerPassword`, and the two rows whose
 * `OpenCodeSettingsView` carries its status, A-52 `getOpenCodeSettings` and A-53 `setOpenCodePluginEnabled`; with A-53
 * kept, the Host stays the plugin file's one writer and today's plugin half stays off (21 §1 item 4).
 */
export const KEPT_WITH_THE_MIGRATED_SECRET: Partial<Record<ChannelKey, StepId>> = {
  'jev:apiKey:set': 'cut-3a',
  'jev:apiKey:clear': 'cut-3a',
  'jev:route': 'cut-3a',
  'jev:settings:get': 'cut-3a',
  'opencode:settings:get': 'cut-4a',
  'opencode:plugin:set': 'cut-4a',
  'opencode:password:set': 'cut-4a',
  'opencode:password:clear': 'cut-4a'
}

/**
 * The rows a step moved off the 21 §3.1 shape adapter an earlier cut composed for them, with that step and the route
 * the earlier release shipped (ISSUE-235): a rollback of the step routes them through that adapter again.
 */
export const BACK_THROUGH_ITS_SHAPE_ADAPTER: Partial<
  Record<ChannelKey, { step: StepId; route: ChannelRoute }>
> = {
  'metrics:reset': {
    step: 'cut-4a',
    route: {
      channel: 'metrics:reset', // A-33
      owner: 'legacy',
      since: 'cut-1',
      parity: 'n/a',
      shape: 'target',
      shapeAdapter: 'ResetFanout'
    }
  },
  'jev:settings:get': {
    step: 'cut-4a',
    route: {
      channel: 'jev:settings:get', // A-47
      owner: 'legacy',
      since: 'cut-3a',
      parity: 'n/a',
      shape: 'target',
      shapeAdapter: 'JevSettingsShapeAdapter'
    }
  }
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
  const flippedBack = new Set<string>()
  for (const route of table.routes) {
    if (isWithdrawn(route, cut)) continue
    const provider = route.qualifier?.provider
    if (provider !== undefined && flipsBackToAnEarlierAdapter(table, route, cut)) {
      flippedBack.add(provider)
      continue
    }
    if (!movedBy(route, cut) || KEPT_WITH_THE_MIGRATED_SECRET[route.channel] === cut) {
      routes.push(route)
      continue
    }
    if (folded.has(route.channel)) continue
    folded.add(route.channel)
    routes.push(foldedRow(table, route.channel, cut))
  }
  const rolledBack = [...routes, ...notMovedRowsOf(routes, flippedBack), ...restored]
  return {
    ...table,
    routes: rolledBack,
    adapters: table.adapters.map((adapter) =>
      !adapter.cuts.includes(cut) && rolledBack.some((route) => route.shapeAdapter === adapter.name)
        ? { ...adapter, cuts: [...adapter.cuts, cut] }
        : adapter
    ),
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
  const back = BACK_THROUGH_ITS_SHAPE_ADAPTER[channel]
  if (back?.step === cut) return back.route
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

/**
 * Whether a rollback of `cut` drops this route: a provider-qualified `host` route `cut` moved, beside an unqualified
 * `legacy` + `target` shape-adapter route an earlier step created for the same channel (the provider's way back).
 */
function flipsBackToAnEarlierAdapter(table: RouteTable, route: ChannelRoute, cut: StepId): boolean {
  return (
    movedBy(route, cut) &&
    route.owner === 'host' &&
    table.routes.some(
      (other) =>
        other.channel === route.channel &&
        other.since !== cut &&
        other.owner === 'legacy' &&
        other.qualifier === undefined &&
        other.shape === 'target' &&
        other.shapeAdapter !== undefined
    )
  )
}

/**
 * The rows the providers `flippedBack` get again on each channel whose routes are all provider-qualified `legacy`
 * rows (A-27, A-P3, A-P4 from 3a): a copy of that channel's first row, qualified to the provider. Only a catalog
 * provider had such a row ("Other…", moved in 3d, never did).
 */
function notMovedRowsOf(
  routes: readonly ChannelRoute[],
  flippedBack: ReadonlySet<string>
): ChannelRoute[] {
  if (flippedBack.size === 0) return []
  const catalogProviders: ReadonlySet<string> = new Set(CATALOG_PROVIDER_IDS)
  const byChannel = new Map<ChannelKey, ChannelRoute[]>()
  for (const route of routes)
    byChannel.set(route.channel, [...(byChannel.get(route.channel) ?? []), route])
  const rows: ChannelRoute[] = []
  for (const [, ofChannel] of byChannel) {
    const first = ofChannel[0]
    const perProvider = ofChannel.every(
      (route) => route.owner === 'legacy' && route.qualifier?.provider !== undefined
    )
    if (first === undefined || !perProvider) continue
    for (const provider of flippedBack) {
      if (catalogProviders.has(provider)) rows.push({ ...first, qualifier: { provider } })
    }
  }
  return rows
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
