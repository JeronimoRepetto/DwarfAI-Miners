// layer: L6
import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_PROVIDER_IDS,
  CHANNELS,
  MEMBER_REMOVED,
  PRELOAD_HELPERS,
  RETIRED,
  ROW_IDS,
  STEP_ORDER,
  TODAY_SHAPES,
  UNROUTED,
  type ChannelKey,
  type DwarfId,
  type FolderPath,
  type HostResult,
  type MineId,
  type SnapshotPage,
  type StepId,
  supplierEntryViewSchema
} from '@dwarfai/contracts'
import {
  composeAskAnswers,
  composeAskStepAndIntegrationRows,
  composeBoardFacade,
  composeConversationAndLaunchRows,
  composeDwarfNameRows,
  composeOpenCodeSettingsRows,
  composeLegacyAgentRegistryFeed,
  composeLegacyAskRelay,
  composeLegacyDwarfIdBridge,
  composeLegacyLaunchObservation,
  composeHostReads,
  composeJevRouteRow,
  composeJevKeyRows,
  composeMinesAdmin,
  composeOpenCodePasswordRows,
  composePresence,
  composeProviderRouting,
  composeProviderShapeAdapters,
  composeResetMetricsRow,
  composeSettlementJoin,
  composeStopAllRelay,
  composeStopDwarf,
  composeSystemNotificationRows,
  legacyFeedModesOf,
  legacyOpenCodePluginComposed,
  type LegacyAskRelayComposition,
  type LegacyRuntimeSurface
} from '../index'
import type { HostEvent } from '../window/ports/hostClient'
import { createStopEverything } from '../window/application/stopEverything'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CUT_1_ROLLBACK, CUT_2_ROLLBACK } from '../../contracts/strangler'
import { UI_MAIN_PUSHES } from '../index'
import { checkRouteTable, type ChannelRoute, type RouteTable } from './channelRoute'
import { composeRouteTargets } from './composeRouteTargets'
import { createStopEverythingRows, STOP_EVERYTHING_CONFIRM } from './handlers/stopEverything'
import { rollbackOf } from './rollbackTable'
import { createRouter } from './router'
import { resolveRoute } from './routeResolver'
import { CUT_0_ROUTES, CUT_0_TABLE, CUT_0_UI_LOCAL_IDS, CUT_0_UNROUTED } from './testing/cut0Routes'
import {
  CUT_1_HOST_ROUTE_MEMBERS,
  CUT_1_ROUTES,
  CUT_1_TABLE,
  CUT_1_UNROUTED
} from './testing/cut1Routes'
import {
  CUT_2_HOST_ROUTE_MEMBERS,
  CUT_2_RETIRED,
  CUT_2_ROUTES,
  CUT_2_UNROUTED
} from './testing/cut2Routes'
import { CUT_3A_RELEASE, CUT_3A_ROUTES } from './testing/cut3aRoutes'
import { CUT_3B_RELEASE, CUT_3B_ROUTES } from './testing/cut3bRoutes'
import { CUT_3D_RELEASE, CUT_3D_ROUTES } from './testing/cut3dRoutes'
import { CUT_3E_RELEASE, CUT_3E_ROUTES, cut3eRoutesForBuild } from './testing/cut3eRoutes'
import {
  CUT_4A_RELEASE,
  CUT_4A_RETIRED,
  CUT_4A_ROUTES,
  cut4aRoutesForBuild
} from './testing/cut4aRoutes'
import { PRE_CUT_0_ROUTES } from './testing/preCutRoutes'
import { ADAPTERS_AS_SHIPPED } from './testing/adaptersAsShipped'
import {
  DEVELOPMENT_BUILD_ROUTES,
  HOST_ROUTE_MEMBERS,
  LEGACY_BRIDGE_ADAPTERS,
  ROUTES,
  ROUTES_RELEASE,
  routesForBuild,
  SEAM_B_METHODS_BORN
} from './routes'
import {
  dwarfWire,
  hostEntry,
  providerRowsWorld,
  WORLD_MINE,
  WORLD_MINTED
} from './testing/providerRowsWorld'

/**
 * The router's contract (ADR-001 item 3; 21 §1 items 1, 2, 2a; 14 §6.5 "Router"): every registry row has exactly one
 * route per (channel, qualifier) in a release, or one unrouted entry naming a later step (22 §5); every `legacy` +
 * `target` route names a listed shape adapter (21 §3.1); no `host` route has `shape: 'today'` or, in a release
 * build, `parity: 'pending'`; every legacy-bridge adapter is listed with its cuts and absent after cut 5 (21 §3).
 */
const KEYS = Object.keys(CHANNELS) as ChannelKey[]

/** The registry key a wire speaks for: the key itself, or the one key sharing its 14 id (A-44's today wire). */
function keyOfWire(wire: string): string {
  if (wire in CHANNELS) return wire
  const matches = KEYS.filter((key) => ROW_IDS[key] !== undefined && ROW_IDS[key] === ROW_IDS[wire])
  return matches.length === 1 ? (matches[0] ?? wire) : wire
}

// AMENDED for ISSUE-123 (was: no `retired`): from cut 1 the release table lists the rows it retired (`RETIRED`).
const preCut: RouteTable = {
  release: ROUTES_RELEASE,
  routes: ROUTES,
  unrouted: UNROUTED,
  retired: RETIRED,
  adapters: LEGACY_BRIDGE_ADAPTERS
}

/**
 * The pre-cut table with every unrouted NEW row routed as its step will route it (its registry placement, target
 * shape), so a table built for another release or with other unrouted entries checks only the change under test.
 *
 * AMENDED for ISSUE-123 (was: the release table `ROUTES` plus its unrouted entries): from cut 1 the release table names
 * a shape adapter that lives only in cuts 1–3e (A-33, `ResetFanout`) and has no route for the rows it retired, so the
 * base is the pre-cut table (every today row `legacy` with today's shape) with every NEW row routed by its placement.
 */
const routedBase: RouteTable = {
  ...preCut,
  routes: [
    ...PRE_CUT_0_ROUTES,
    ...KEYS.filter((channel) => CHANNELS[channel].status === 'new').map(
      (channel): ChannelRoute => ({
        channel,
        owner: CHANNELS[channel].placement === 'host' ? 'host' : 'ui-local',
        since: CUT_0_UNROUTED[channel] ?? 'cut-0',
        parity: CHANNELS[channel].placement === 'host' ? 'passed' : 'n/a',
        shape: 'target'
      })
    )
  ],
  unrouted: {},
  retired: {}
}

/** The pre-cut table with one change: the route of `channel` replaced by `routes` (none when empty). */
function withRoutes(table: RouteTable, channel: ChannelKey, ...routes: ChannelRoute[]): RouteTable {
  return { ...table, routes: [...table.routes.filter((r) => r.channel !== channel), ...routes] }
}

const legacyToday = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'pre-cut-0',
  parity: 'n/a',
  shape: 'today'
})

const reasons = (table: RouteTable): string[] =>
  checkRouteTable(table, KEYS).map((p) => `${p.reason} ${p.channel ?? p.adapter ?? ''}`.trim())

describe('pre-cut table', () => {
  it('[ADR-001] every CHANNELS key has exactly one route per qualifier or exactly one unrouted entry naming a later step', () => {
    // AMENDED for ISSUE-056 (was: the release is 'pre-cut-0' and, TC-043-01, every route is today's runtime with
    // today's shape): the cut-0 switch moved the table to its first release, whose rows `describe('release cut-0')`
    // pins; this case keeps the invariant every release's table holds.
    expect(checkRouteTable(preCut, KEYS)).toEqual([])
    for (const key of KEYS) {
      const routes = ROUTES.filter((r) => r.channel === key)
      // AMENDED for ISSUE-123 (was: a route or an unrouted entry): or one retired entry (`RETIRED`, lead resolution H1).
      // AMENDED for ISSUE-141 (was: `routes.length + … toBe(1)`): from cut 2 a qualified channel (A-40, A-41) has one
      // route per qualifier, so a key has its routes, one per qualifier, or else one unrouted or retired entry.
      const pairs = new Set(routes.map((r) => JSON.stringify(r.qualifier ?? {})))
      expect(pairs.size, key).toBe(routes.length)
      expect(
        (routes.length > 0 ? 1 : 0) + (UNROUTED[key] ? 1 : 0) + (RETIRED[key] ? 1 : 0),
        key
      ).toBe(1)
    }
  })

  it('[ADR-001] an unrouted entry naming the table’s release or an earlier step, or a key with both a route and an unrouted entry, is rejected', () => {
    const newRow: ChannelKey = 'panel:hide' // stands for a NEW row declared before its step
    const unroutedAt = (release: StepId, step: StepId): RouteTable => ({
      ...withRoutes(routedBase, newRow),
      release,
      unrouted: { [newRow]: step }
    })

    // TC-043-05: accepted only while its step is later than the table's release.
    expect(reasons(unroutedAt('pre-cut-0', 'cut-1'))).toEqual([])
    expect(reasons(unroutedAt('cut-1', 'cut-1'))).toEqual([`unrouted-not-later ${newRow}`])
    expect(reasons(unroutedAt('cut-2', 'cut-1'))).toEqual([`unrouted-not-later ${newRow}`])
    expect(reasons({ ...routedBase, unrouted: { [newRow]: 'cut-1' } })).toEqual([
      `routed-and-unrouted ${newRow}`
    ])
  })

  it('[ADR-001] STEP_ORDER lists the release steps of 21 §2 in order with generation-2 after v1, and an entry naming generation-2 is accepted by the release-5 and v1 tables', () => {
    expect(STEP_ORDER).toEqual([
      'pre-cut-0',
      'cut-0',
      'cut-1',
      'cut-2',
      'cut-3a',
      'cut-3b',
      'cut-3d',
      'cut-3e',
      'cut-4a',
      'cut-4b',
      'cut-5',
      'v1',
      'generation-2'
    ])
    const newRow: ChannelKey = 'panel:hide' // stands for a NEW row declared before its step
    for (const release of ['cut-5', 'v1'] as const) {
      const table: RouteTable = {
        ...withRoutes(routedBase, newRow),
        release,
        adapters: [],
        unrouted: { [newRow]: 'generation-2' }
      }
      expect(reasons(table), release).toEqual([])
    }
    expect(
      reasons({
        ...withRoutes(routedBase, newRow),
        release: 'generation-2',
        adapters: [],
        unrouted: { [newRow]: 'generation-2' }
      })
    ).toEqual([`unrouted-not-later ${newRow}`])
  })

  it('[ADR-001] a table with two routes for one (channel, qualifier) is rejected', () => {
    const twice = withRoutes(routedBase, 'agent:launch', legacyToday('agent:launch'), {
      ...legacyToday('agent:launch'),
      owner: 'ui-local'
    })
    expect(reasons(twice)).toEqual(['two-routes agent:launch'])

    const qualifiedTwice = withRoutes(
      routedBase,
      'agent:launch',
      legacyToday('agent:launch'),
      { ...legacyToday('agent:launch'), qualifier: { provider: 'codex' } },
      { ...legacyToday('agent:launch'), qualifier: { provider: 'codex' } }
    )
    expect(reasons(qualifiedTwice)).toEqual(['two-routes agent:launch'])

    // One route per (channel, qualifier) pair: a qualified route beside the unqualified one is valid, and an empty
    // qualifier is the unqualified pair.
    const qualified = withRoutes(routedBase, 'agent:launch', legacyToday('agent:launch'), {
      ...legacyToday('agent:launch'),
      qualifier: { provider: 'codex' }
    })
    expect(reasons(qualified)).toEqual([])
    expect(
      reasons(
        withRoutes(routedBase, 'agent:launch', legacyToday('agent:launch'), {
          ...legacyToday('agent:launch'),
          qualifier: {}
        })
      )
    ).toEqual(['two-routes agent:launch'])

    expect(reasons(withRoutes(routedBase, 'agent:launch'))).toEqual(['no-route agent:launch'])

    // The preload exposes one shape per member in a release (21 §1 item 2a): the routes of one channel agree on it.
    expect(
      reasons({
        ...withRoutes(routedBase, 'agent:launch', legacyToday('agent:launch'), {
          channel: 'agent:launch',
          owner: 'host',
          since: 'cut-3a',
          parity: 'passed',
          shape: 'target',
          qualifier: { provider: 'claude' }
        }),
        release: 'cut-3a'
      })
    ).toEqual(['two-shapes agent:launch'])
  })

  it('[ADR-001] a legacy route with shape target and no listed shape adapter is rejected', () => {
    const at = (route: Partial<ChannelRoute>): RouteTable => ({
      ...withRoutes(routedBase, 'agent:providers', { ...legacyToday('agent:providers'), ...route }),
      release: 'cut-3a',
      adapters: [{ name: 'CatalogMergeAdapter', cuts: ['cut-3a'], shapeAdapter: true }]
    })

    expect(reasons(at({ shape: 'target' }))).toEqual([
      'target-without-shape-adapter agent:providers'
    ])
    expect(reasons(at({ shape: 'target', shapeAdapter: 'UnlistedShapeAdapter' }))).toEqual([
      'adapter-not-listed UnlistedShapeAdapter'
    ])
    expect(reasons(at({ shape: 'target', shapeAdapter: 'CatalogMergeAdapter' }))).toEqual([])
  })

  it('[ADR-001] a host route with shape today is rejected', () => {
    const host: ChannelRoute = {
      channel: 'mines:get',
      owner: 'host',
      since: 'cut-1',
      parity: 'passed',
      shape: 'today'
    }
    expect(reasons({ ...withRoutes(routedBase, 'mines:get', host), release: 'cut-1' })).toEqual([
      'host-with-today-shape mines:get'
    ])
    expect(
      reasons({
        ...withRoutes(routedBase, 'mines:get', { ...host, shape: 'target' }),
        release: 'cut-1'
      })
    ).toEqual([])
  })

  it('[ADR-001] a host route with parity pending is rejected for a release build', () => {
    const pending: ChannelRoute = {
      channel: 'mine:history',
      owner: 'host',
      since: 'cut-1',
      parity: 'pending',
      shape: 'target'
    }
    const table = withRoutes(routedBase, 'mine:history', pending)
    expect(reasons({ ...table, release: 'cut-1' })).toEqual([
      'host-pending-in-release mine:history'
    ])
    // Pre-cut 0 is no release (21 §2): the check applies from the first release build on.
    expect(reasons({ ...table, release: 'pre-cut-0' })).toEqual([])
  })

  it('[ADR-001] every legacy-bridge adapter named by the table is listed with its cuts', () => {
    // 21 §3 and §3.1, with the cuts of their tables ("1–4" is cut 1 up to the end of cut 4, that is 4b).
    const cuts = Object.fromEntries(LEGACY_BRIDGE_ADAPTERS.map((a) => [a.name, a.cuts]))
    const span = (from: StepId, to: StepId): StepId[] =>
      STEP_ORDER.slice(STEP_ORDER.indexOf(from), STEP_ORDER.indexOf(to) + 1)
    expect(cuts).toEqual({
      LegacyRuntimeRoute: span('cut-0', 'cut-5'),
      BoardFacadeAdapter: span('cut-1', 'cut-4b'),
      LegacyDwarfIdBridge: span('cut-1', 'cut-4b'),
      LegacyLaunchObservation: span('cut-1', 'cut-4b'),
      SecretMigrationBridge: ['cut-3a', 'cut-4a'],
      LegacyAgentRegistryFeed: span('cut-1', 'cut-4b'),
      LegacyAskRelay: span('cut-1', 'cut-4b'),
      LegacyEndFirstAdapter: span('cut-0', 'cut-4b'),
      PerProviderShapeAdapter: span('cut-3a', 'cut-4b'),
      CatalogMergeAdapter: span('cut-3a', 'cut-4b'),
      LegacyAnswerShapeAdapter: span('cut-2', 'cut-4b')
    })
    // AMENDED for ISSUE-236, the 4a retirement (was: also `ResetFanout` and `SettingsMirrorBridge`, cuts 1–3e, and
    // `JevSettingsShapeAdapter`, 3a–4a): they left the tree with their 4a lifetime (`testing/adaptersAsShipped.ts`
    // keeps them for the earlier releases' tables).
    expect(
      LEGACY_BRIDGE_ADAPTERS.filter((a) => a.shapeAdapter)
        .map((a) => a.name)
        .sort()
    ).toEqual(['CatalogMergeAdapter', 'LegacyAnswerShapeAdapter', 'PerProviderShapeAdapter'])

    // A route's shape adapter must be listed as a shape adapter living in the table's release.
    const naming = (release: StepId, shapeAdapter: string): RouteTable => ({
      ...withRoutes(routedBase, 'metrics:reset', {
        ...legacyToday('metrics:reset'),
        shape: 'target',
        shapeAdapter
      }),
      release
    })
    // AMENDED for ISSUE-236 (was: `ResetFanout`, listed for cut 1 and not for 4a): a listed shape adapter outside its cuts.
    expect(reasons(naming('cut-2', 'LegacyAnswerShapeAdapter'))).toEqual([])
    expect(reasons(naming('cut-1', 'LegacyAnswerShapeAdapter'))).toEqual([
      'adapter-not-listed LegacyAnswerShapeAdapter'
    ])
    expect(reasons(naming('cut-1', 'ResetFanout'))).toEqual(['adapter-not-listed ResetFanout'])
    expect(reasons(naming('cut-1', 'LegacyDwarfIdBridge'))).toEqual([
      'adapter-not-listed LegacyDwarfIdBridge'
    ])

    // Absent after cut 5 (14 §6.5): no listed adapter lives past cut 5.
    expect(
      reasons({ ...routedBase, adapters: [{ name: 'Late', cuts: ['v1'], shapeAdapter: false }] })
    ).toEqual(['adapter-after-cut-5 Late'])
  })

  it('[ADR-001] LegacyEndFirstAdapter is listed for cuts 0 to 4 and composed on A-N26', async () => {
    // TC-054-03 (21 §3, 14 §5): listed from cut 0 to the end of cut 4 (4b), absent from cut 5 on.
    expect(LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'LegacyEndFirstAdapter')).toEqual({
      name: 'LegacyEndFirstAdapter',
      cuts: ['cut-0', 'cut-1', 'cut-2', 'cut-3a', 'cut-3b', 'cut-3d', 'cut-3e', 'cut-4a', 'cut-4b'],
      shapeAdapter: false
    })
    // A-N26 is a `host` row the cut-0 switch routes (ISSUE-056); its one handler relays through the root's relay.
    expect(CHANNELS[STOP_EVERYTHING_CONFIRM].placement).toBe('host')
    // AMENDED for ISSUE-056 (was: `UNROUTED[STOP_EVERYTHING_CONFIRM]` is 'cut-0'): the cut-0 switch routed it.
    expect(UNROUTED[STOP_EVERYTHING_CONFIRM]).toBeUndefined()
    expect(ROUTES.filter((r) => r.channel === STOP_EVERYTHING_CONFIRM).map((r) => r.owner)).toEqual(
      ['host']
    )

    // The root's A-N26 relay, over a legacy runtime holding one live launch whose end reports `verdict`, and a Host
    // recording what it is sent; A-N26 is served by its one handler over the Stop everything use case.
    const HOST_DWARF = '01890a5d-ac96-774b-bcce-b302099ad101' as DwarfId
    async function confirmThroughRoot(verdict: 'ended' | 'refused') {
      const events: string[] = []
      const relay = composeStopAllRelay({
        liveLaunches: async () => [{ launchId: 'launch:1' }],
        endLaunch: async (launchId) => {
          events.push(`legacy end ${launchId}`)
          return verdict
        }
      })
      const connection = {
        snapshot: async (): Promise<SnapshotPage> => ({
          snapshotId: 'snap-1',
          seq: 1,
          epoch: 'epoch-1' as SnapshotPage['epoch'],
          chunks: []
        }),
        call: async (method: string, params: unknown): Promise<HostResult['host.shutdown']> => {
          events.push(`${method} ${JSON.stringify(params)}`)
          return { mode: 'stop-all', outcome: { ended: [HOST_DWARF], failed: [] } }
        }
      }
      const stop = createStopEverything({
        host: {
          withUiConnection: (use) => use(connection as unknown as Parameters<typeof use>[0])
        },
        windows: { anyOpen: () => true, open: () => {}, push: () => {} },
        newConfirmationId: () => 'c-1',
        relay
      })
      await stop.request()
      const answer = await createStopEverythingRows(stop).serve(STOP_EVERYTHING_CONFIRM, {
        confirmationId: 'c-1',
        requestId: 'r-1'
      })
      return { events, answer }
    }
    const response = CHANNELS[STOP_EVERYTHING_CONFIRM].response

    // Every legacy launch ended: relayed after it, and the Host's outcome answered unchanged.
    const ended = await confirmThroughRoot('ended')
    expect(ended.events).toEqual([
      'legacy end launch:1',
      'host.shutdown {"mode":"stop-all","requestId":"r-1"}'
    ])
    expect(ended.answer).toEqual({ ok: true, value: { ended: [HOST_DWARF], failed: [] } })
    expect(response.safeParse(ended.answer).success).toBe(true)

    // TC-054-02: a legacy launch that could not be ended: nothing relayed, A-N26 answers INTERNAL (eB).
    const refused = await confirmThroughRoot('refused')
    expect(refused.events).toEqual(['legacy end launch:1'])
    expect(refused.answer).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', retryable: false }
    })
    expect(response.safeParse(refused.answer).success).toBe(true)
  })

  it('[ADR-001] BoardFacadeAdapter is listed for cuts 1 to 4', async () => {
    // TC-086-03 (21 §3, 14 §5): listed from cut 1 to the end of cut 4 (4b), absent from cut 5 on.
    expect(LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'BoardFacadeAdapter')).toEqual({
      name: 'BoardFacadeAdapter',
      cuts: ['cut-1', 'cut-2', 'cut-3a', 'cut-3b', 'cut-3d', 'cut-3e', 'cut-4a', 'cut-4b'],
      shapeAdapter: false
    })
    // A-12 and A-P2 are RETIRE rows of the Host (14 §2.1) that keep today's shape, served by today's runtime until the
    // cut-1 switch (ISSUE-123) routes them through the facade.
    // AMENDED for ISSUE-123 (was: `ROUTES`, the cut-0 release table): the cut-0 table is the fixture it shipped as.
    const BOARD_ROWS: ChannelKey[] = ['mines:get', 'mines:update']
    for (const key of BOARD_ROWS) {
      expect([CHANNELS[key].status, CHANNELS[key].placement], key).toEqual(['retired', 'host'])
      expect(
        CUT_0_ROUTES.filter((r) => r.channel === key).map((r) => r.owner),
        key
      ).toEqual(['legacy'])
    }

    // The root composes the facade only once the table routes A-12 to the Host: not in the cut-0 table.
    let handler: ((event: HostEvent) => void) | null = null
    const client = {
      subscribe: (h: (event: HostEvent) => void) => {
        handler = h
        return () => (handler = null)
      }
    }
    const sent: Array<[string, unknown]> = []
    const windows = () => [
      { webContentsId: 1, send: (push: string, p: unknown) => void sent.push([push, p]) }
    ]
    const macrotasks: Array<() => void> = []
    const defer = (run: () => void) => void macrotasks.push(run)
    expect(composeBoardFacade({ routes: CUT_0_ROUTES, client, windows, defer })).toBeUndefined()
    expect(handler).toBeNull()

    // In a table that routes A-12 and A-P2 to the Host (as the cut-1 switch will), the facade is A-12's `host` handler
    // and pushes A-P2 to the mode windows, both in today's shape.
    const hostRoute = (channel: ChannelKey): ChannelRoute => ({
      channel,
      owner: 'host',
      since: 'cut-1',
      parity: 'passed',
      shape: 'target'
    })
    const cut1Routes = [
      ...CUT_0_ROUTES.filter((r) => !BOARD_ROWS.includes(r.channel)),
      ...BOARD_ROWS.map(hostRoute)
    ]
    const facade = composeBoardFacade({ routes: cut1Routes, client, windows, defer })
    expect(facade?.part.channels).toEqual(['mines:get'])
    const MINE = '01920000-0000-7000-9000-0000000c0001'
    const ore = { tokens: 5 }
    ;(handler as ((event: HostEvent) => void) | null)?.({
      kind: 'snapshot',
      snapshot: {
        snapshotId: 's-1',
        seq: 1,
        epoch: 'epoch-1',
        chunks: [
          {
            section: 'mines',
            data: [
              {
                id: MINE as MineId,
                path: '/work/gamma' as FolderPath,
                name: 'gamma',
                state: 'active',
                tier: 'silver',
                hasBeenMeasured: true,
                lastUsedAt: 1,
                totals: {
                  coal: ore,
                  bronze: ore,
                  copper: ore,
                  silver: ore,
                  gold: ore,
                  uranium: ore
                }
              }
            ]
          }
        ]
      }
    })
    for (const run of macrotasks.splice(0)) run()
    const answer = await facade?.part.target.serve('mines:get', undefined)
    expect(CHANNELS['mines:get'].response.safeParse(answer).success).toBe(true)
    expect((answer as { mines: Array<{ id: string }> }).mines.map((m) => m.id)).toEqual([MINE])
    expect(sent.map(([push]) => push)).toEqual(['mines:update'])
    expect(CHANNELS['mines:update'].response.safeParse(sent[0]?.[1]).success).toBe(true)
    expect(sent[0]?.[1]).toEqual(answer)
    facade?.dispose()
    expect(handler).toBeNull()
  })
})

// AMENDED for ISSUE-123 (was: `CUT_0_UI_LOCAL_IDS` declared here): the cut-0 ids live with the cut-0 table fixture
// (`testing/cut0Routes.ts`), the table this describe proves now that the release table is cut 1's.

/** The registry keys of the given 14 ids (A-44's today wire is not a registry key, so no row matches twice). */
const keysOf = (ids: readonly string[]): ChannelKey[] =>
  KEYS.filter((key) => ids.includes(ROW_IDS[key] ?? ''))

// AMENDED for ISSUE-123 (was: the release table `ROUTES` / `ROUTES_RELEASE` / `UNROUTED`): from the cut-1 switch the
// release table is cut 1's, so these cases prove the cut-0 table as it shipped (`testing/cut0Routes.ts`).
describe('release cut-0 (21 §2 cut 0)', () => {
  const cut0: RouteTable = CUT_0_TABLE
  const uiLocal = keysOf(CUT_0_UI_LOCAL_IDS)
  const routeOf = (key: ChannelKey): ChannelRoute[] => CUT_0_ROUTES.filter((r) => r.channel === key)

  it('[ADR-001] in cut 0 the window family, A-N03 to A-N05, A-N30, A-N25 and A-N27 route ui-local', () => {
    expect(cut0.release).toBe('cut-0')
    expect(checkRouteTable(cut0, KEYS)).toEqual([])
    expect(uiLocal).toHaveLength(CUT_0_UI_LOCAL_IDS.length)
    for (const key of uiLocal) {
      // A row that replaces a legacy handler passed its L6 contract suite (TC-056-05); a NEW row has no legacy code.
      const parity = CHANNELS[key].status === 'new' ? 'n/a' : 'passed'
      expect(routeOf(key), key).toEqual([
        { channel: key, owner: 'ui-local', since: 'cut-0', parity, shape: 'target' }
      ])
    }
    // A-N33 stays unrouted: dormant until the first release that bumps `endpointGeneration` (AMENDMENT-11).
    // AMENDED for ISSUE-059 (was: only A-N33): a NEW row whose handler lands before the step that routes it is listed
    // with that step (22 §5): A-N17…A-N19, born `ui-local` in cut 1 and routed by the cut-1 switch (ISSUE-123).
    // AMENDED for ISSUE-060 (was: A-N33 and A-N17…A-N19): A-N20 and A-N21 join them, born `ui-local` in cut 1 and
    // routed by the same switch.
    // AMENDED for ISSUE-082 (was: A-N33 and A-N17…A-N21): A-N01 and A-N02, born `host` in cut 1, join them, routed by
    // the same cut-1 switch (ISSUE-123).
    expect(CUT_0_UNROUTED).toEqual({
      'host:connection:confirm-restart': 'generation-2',
      'ui:session:get': 'cut-1',
      'ui:session:patch': 'cut-1',
      'ui:session:changed': 'cut-1',
      'ui:preferences:get': 'cut-1',
      'ui:preferences:set': 'cut-1',
      // AMENDED for ISSUE-061: A-N12 joins them, born `ui-local` in cut 1 and routed by the same switch.
      'ui:preferences:reset': 'cut-1',
      'host:snapshot': 'cut-1',
      'host:event': 'cut-1',
      // AMENDED for ISSUE-114: A-N16 joins them, born `ui-local` in cut 1 and routed by the same switch (ISSUE-123).
      'mode:revealDwarfChat': 'cut-1',
      // AMENDED for ISSUE-221: A-N31 joins them, born `host` in cut 2 and routed by the cut-2 switch (ISSUE-141).
      'claude:hooks:set': 'cut-2',
      // AMENDED for ISSUE-129: A-N07 joins them, born `host` in cut 2 and routed by the cut-2 switch (ISSUE-141).
      'ask:step:set': 'cut-2',
      // AMENDED for ISSUE-223: A-N32 joins them, born `host` in cut 2 and routed by the cut-2 switch (ISSUE-141).
      'welcome:answer': 'cut-2',
      // AMENDED for ISSUE-171: A-N29 joins them, born `host` in 3a and routed by the step-3a switch (ISSUE-001).
      'dwarf:stop': 'cut-3a',
      // AMENDED for ISSUE-168: A-N06 joins them, born `host` in 3a and routed by the step-3a switch (ISSUE-001).
      'dwarf:message:retry': 'cut-3a',
      // AMENDED for ISSUE-172: A-N08 and A-N09 join them, born `host` in cut 2 (lead decision, 2026-10-17).
      'dwarf:rename': 'cut-2',
      'dwarf:name:reset': 'cut-2',
      // AMENDED for ISSUE-174: A-N10 and A-N11 join them, born `host` in 3a and routed by the same switch.
      'host:recovery:retry': 'cut-3a',
      'host:recovery:dismiss': 'cut-3a'
    })
  })

  it('[ADR-001] in cut 0 A-N26 routes host through LegacyEndFirstAdapter', () => {
    expect(routeOf(STOP_EVERYTHING_CONFIRM)).toEqual([
      {
        channel: STOP_EVERYTHING_CONFIRM,
        owner: 'host',
        since: 'cut-0',
        parity: 'passed',
        shape: 'target'
      }
    ])
    expect(CUT_0_ROUTES.filter((r) => r.owner === 'host').map((r) => r.channel)).toEqual([
      STOP_EVERYTHING_CONFIRM
    ])
    // The relay that ends the legacy-launched sessions first lives in this release (21 §3), and the root composes it
    // as A-N26's only path (`composeStopAllRelay`, the LegacyEndFirstAdapter case above; index.cut0.test.ts).
    expect(LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'LegacyEndFirstAdapter')?.cuts).toContain(
      cut0.release
    )
  })

  it('[ADR-001] in cut 0 every other row routes legacy with shape today, RETIRE rows included', () => {
    const moved = new Set<ChannelKey>([...uiLocal, STOP_EVERYTHING_CONFIRM])
    const others = KEYS.filter((key) => !moved.has(key) && CUT_0_UNROUTED[key] === undefined)
    for (const key of others) {
      expect(routeOf(key), key).toEqual([legacyToday(key)])
    }
    // The 13 RETIRE rows of 14 §2.1 and the two §8 I-21 rows are all still served by today's runtime.
    const retired = KEYS.filter((key) => CHANNELS[key].status === 'retired')
    expect(retired).toHaveLength(15)
    for (const key of retired)
      expect(
        routeOf(key).map((r) => r.owner),
        key
      ).toEqual(['legacy'])
    expect(others.length + moved.size + Object.keys(CUT_0_UNROUTED).length).toBe(KEYS.length)
  })

  it('[ADR-001] in cut 0 every host route uses only seam-B members born in cut 0 and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of CUT_0_ROUTES.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).not.toBe('pending')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at(cut0.release)
        )
      }
    }
    // 21 §2 "Seam B members: the cut in which each is born", row 0 (B-M02…B-M06; B-M01 `hello` is the handshake).
    // AMENDED for ISSUE-123 (was: the whole `SEAM_B_METHODS_BORN` and `HOST_ROUTE_MEMBERS`): from cut 1 they also hold
    // the cut-1 members and routes, so the cut-0 entries are read out of them.
    expect(
      Object.fromEntries(Object.entries(SEAM_B_METHODS_BORN).filter(([, step]) => step === 'cut-0'))
    ).toEqual({
      ping: 'cut-0',
      'events.subscribe': 'cut-0',
      'session.snapshot': 'cut-0',
      'host.shutdown': 'cut-0',
      'host.upgrade.request': 'cut-0'
    })
    expect(HOST_ROUTE_MEMBERS[STOP_EVERYTHING_CONFIRM]).toEqual(['host.shutdown'])
  })

  it('[ADR-001] in cut 0 LegacyRuntimeRoute and LegacyEndFirstAdapter are the only adapters composed', () => {
    expect(
      LEGACY_BRIDGE_ADAPTERS.filter((a) => a.cuts.includes(cut0.release)).map((a) => a.name)
    ).toEqual(['LegacyRuntimeRoute', 'LegacyEndFirstAdapter'])
    // No route of this release names a shape adapter (21 §3.1: the first is born in cut 1).
    expect(CUT_0_ROUTES.filter((r) => r.shapeAdapter !== undefined)).toEqual([])
  })

  it('[ADR-019] every ipcMain registration, preload member and push of the cut-0 build maps to exactly one CHANNELS entry and back', () => {
    // ipcMain: the router registers one listener per invoke and send row, under the wire its route speaks.
    const registered: string[] = []
    createRouter({
      routes: CUT_0_ROUTES,
      legacy: { serve: async () => undefined },
      uiLocal: { serve: async () => undefined },
      host: { serve: async () => undefined },
      senders: { appEntry: 'file:///app/index.html', isModeWindow: () => true }
    }).register({
      handle: (wire) => void registered.push(wire),
      on: (wire) => void registered.push(wire)
    })
    const helpers: readonly string[] = PRELOAD_HELPERS
    const callable = KEYS.filter((key) => CHANNELS[key].kind !== 'push' && !helpers.includes(key))
    expect(new Set(registered).size).toBe(registered.length)
    expect(registered.map((wire) => keyOfWire(wire)).sort()).toEqual([...callable].sort())

    // The preload: every `ipcRenderer` wire the generated preload speaks is one CHANNELS entry, and every non-helper
    // entry is spoken exactly once; its one helper is A-X1, the preload-only member. AMENDED for ISSUE-183 (was: every
    // non-helper entry): the preload is this tree's, generated for the release table, so a RETIRE row whose member left
    // with its route by then (`MEMBER_REMOVED`, A-26 in 3a) is not spoken.
    const preload = readFileSync(resolve(import.meta.dirname, '../../preload/index.ts'), 'utf8')
    const spoken = [...preload.matchAll(/ipcRenderer\.(?:invoke|send|on)\(\s*'([^']+)'/g)].map(
      (match) => match[1] ?? ''
    )
    const memberGone = (key: ChannelKey): boolean => {
      const step = MEMBER_REMOVED[key]
      return step !== undefined && STEP_ORDER.indexOf(step) <= STEP_ORDER.indexOf(ROUTES_RELEASE)
    }
    expect(spoken.map((wire) => keyOfWire(wire)).sort()).toEqual(
      KEYS.filter((key) => !helpers.includes(key) && !memberGone(key)).sort()
    )
    expect(PRELOAD_HELPERS).toEqual(['pathForDroppedFile'])

    // Pushes: each push row has exactly one owner in this release, and the pushes UI main sends are its `ui-local`
    // push rows.
    const pushes = KEYS.filter((key) => CHANNELS[key].kind === 'push')
    // AMENDED for ISSUE-059 (was: `expect(routeOf(key), key).toHaveLength(1)`): a push row declared ahead of the step
    // that routes it (A-N19, `UNROUTED` until cut 1, 22 §5) has no owner yet, and nothing pushes it in this release.
    for (const key of pushes) {
      expect(routeOf(key).length + (CUT_0_UNROUTED[key] ? 1 : 0), key).toBe(1)
    }
    const uiLocalPushes = pushes.filter((key) => routeOf(key)[0]?.owner === 'ui-local').sort()
    expect([...UI_MAIN_PUSHES].sort()).toEqual(uiLocalPushes)
  })
})

/**
 * The rollback table of each cut (21 §2.1 item 1; ISSUE-057; procedure: docs/strangler/rollback.md): a rollback build
 * is the cut's table with the cut's rows that replaced legacy code flipped back to `legacy` with today's shape. It
 * passes the same router test as a release table, and it never gives a row back to legacy code an earlier cut's
 * retirement already deleted (21 §2.1 item 4: after a retirement only forward fixes exist).
 */
// AMENDED for ISSUE-123 (was: the release table as the cut-0 table): the cut-0 table is the fixture it shipped as.
describe('rollback', () => {
  const cut0: RouteTable = CUT_0_TABLE
  /**
   * A cut-1 table as its switch would build it from the cut-0 table: the NEW rows unrouted until cut 1 born there, one
   * kept row moved to the Host. It stands for the first table whose rollback meets rows of an earlier, retired cut.
   */
  const cut1: RouteTable = {
    ...cut0,
    release: 'cut-1',
    routes: [
      ...CUT_0_ROUTES.filter((r) => r.channel !== 'mine:history'),
      { channel: 'mine:history', owner: 'host', since: 'cut-1', parity: 'passed', shape: 'target' },
      ...(Object.entries(CUT_0_UNROUTED) as [ChannelKey, StepId][])
        .filter(([, step]) => step === 'cut-1')
        .map(([channel]): ChannelRoute => ({
          channel,
          owner: 'ui-local',
          since: 'cut-1',
          parity: 'n/a',
          shape: 'target'
        }))
    ],
    unrouted: Object.fromEntries(
      Object.entries(CUT_0_UNROUTED).filter(([, step]) => step !== 'cut-1')
    ) as RouteTable['unrouted']
  }

  it('[ADR-001] the rollback table of cut 0 passes the router test with one owner per channel', () => {
    const rolledBack = rollbackOf(cut0, 'cut-0')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    for (const key of KEYS) {
      const routes = rolledBack.routes.filter((r) => r.channel === key)
      expect(routes.length + (CUT_0_UNROUTED[key] ? 1 : 0), key).toBe(1)
    }
    // The window family and A-28, A-29 go back to today's runtime; the NEW rows of cut 0 have no legacy code and keep
    // their owner, so the rollback build still reaches its Host and the tray's Stop everything and quit.
    const ownerOf = (key: ChannelKey) => rolledBack.routes.find((r) => r.channel === key)?.owner
    for (const key of keysOf(CUT_0_UI_LOCAL_IDS)) {
      expect(ownerOf(key), key).toBe(CHANNELS[key].status === 'new' ? 'ui-local' : 'legacy')
    }
    expect(ownerOf(STOP_EVERYTHING_CONFIRM)).toBe('host')

    // The router starts over the rollback table and registers each invoke and send row once, under the wire of its
    // route (today's wire for every row flipped back).
    const registered: string[] = []
    createRouter({
      routes: rolledBack.routes,
      legacy: { serve: async () => undefined },
      uiLocal: { serve: async () => undefined },
      host: { serve: async () => undefined },
      senders: { appEntry: 'file:///app/index.html', isModeWindow: () => true }
    }).register({
      handle: (wire) => void registered.push(wire),
      on: (wire) => void registered.push(wire)
    })
    const helpers: readonly string[] = PRELOAD_HELPERS
    expect(new Set(registered).size).toBe(registered.length)
    expect(registered.map((wire) => keyOfWire(wire)).sort()).toEqual(
      KEYS.filter((key) => CHANNELS[key].kind !== 'push' && !helpers.includes(key)).sort()
    )
  })

  it('[ADR-001] a rollback table never routes a row to legacy after that row’s retirement cut', () => {
    expect(checkRouteTable(cut1, KEYS)).toEqual([])
    // A route's `since` is a release name (ADR-001 item 3), a `STEP_ORDER` value in every table.
    const at = (step: string) => (STEP_ORDER as readonly string[]).indexOf(step)
    for (const table of [cut0, cut1]) {
      const rolledBack = rollbackOf(table, table.release)
      expect(checkRouteTable(rolledBack, KEYS), table.release).toEqual([])
      for (const route of table.routes) {
        const after = rolledBack.routes.filter((r) => r.channel === route.channel)
        // A row an earlier cut moved off legacy code: that cut's retirement deleted the code, so the row keeps its route.
        if (route.owner !== 'legacy' && at(route.since) < at(table.release)) {
          expect(after, `${table.release} ${route.channel}`).toEqual([route])
        }
      }
      // Every legacy route of the rollback is a legacy route of the table or one of the rolled-back cut's own rows.
      for (const route of rolledBack.routes.filter((r) => r.owner === 'legacy')) {
        const before = table.routes.find((r) => r.channel === route.channel)
        expect(
          before?.owner === 'legacy' || before?.since === table.release,
          `${table.release} ${route.channel}`
        ).toBe(true)
      }
    }
    // The cut-1 rollback gives A-19 back to today's runtime and keeps every cut-0 row where cut 0 put it.
    const rolledBack1 = rollbackOf(cut1, 'cut-1')
    expect(rolledBack1.routes.filter((r) => r.channel === 'mine:history')).toEqual([
      legacyToday('mine:history')
    ])
    expect(rolledBack1.routes.filter((r) => r.since === 'cut-0')).toEqual(
      CUT_0_ROUTES.filter((r) => r.since === 'cut-0')
    )
  })
})

describe('cut-1 legacy composition', () => {
  /** Today's runtime as `LegacyAgentRegistryFeed` is handed it: one discovery, every other part recording. */
  function legacySurface() {
    const reached: string[] = []
    const surface: LegacyRuntimeSurface = {
      pollIntervalMs: 2_000,
      discovery: [
        {
          kind: 'claude',
          scan: async () => {
            reached.push('discovery')
            return [
              {
                provider: 'claude',
                sessionId: 's1',
                cwd: '/work/moria',
                status: 'busy',
                dwarfs: [],
                updatedAt: 1
              }
            ]
          }
        }
      ],
      registry: { replace: () => void reached.push('registry') },
      board: { publish: () => void reached.push('board publish') },
      ledger: { credit: () => void reached.push('crediting') },
      projects: { record: () => void reached.push('projects-store write') },
      notifier: { update: () => void reached.push('notifier') }
    }
    return { surface, reached }
  }
  const launches = {
    liveLaunches: async () => [{ launchId: 'launch:1' }],
    endLaunch: async () => 'ended' as const
  }
  const span = (from: StepId, to: StepId): StepId[] =>
    STEP_ORDER.slice(STEP_ORDER.indexOf(from), STEP_ORDER.indexOf(to) + 1)

  it('[ADR-001] in cut 1 LegacyAgentRegistryFeed and LegacyLaunchObservation are composed and listed with their cuts', () => {
    // TC-087-01 (21 §3): both are listed from cut 1 to the end of cut 4 (4b), absent from cut 5 on.
    for (const name of ['LegacyAgentRegistryFeed', 'LegacyLaunchObservation']) {
      expect(
        LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === name),
        name
      ).toEqual({
        name,
        cuts: span('cut-1', 'cut-4b'),
        shapeAdapter: false
      })
    }
    // The root composes each exactly in the releases it is listed for: in cut 1 (and its rollback build, whose table
    // is cut 1's), not in this release's cut-0 table, and no longer once it is deleted.
    const { surface } = legacySurface()
    const timers = { every: () => () => {} }
    for (const release of span('cut-1', 'cut-4b')) {
      expect(
        composeLegacyAgentRegistryFeed({ release, legacy: surface, timers }),
        release
      ).toBeDefined()
      expect(composeLegacyLaunchObservation({ release, launches }), release).toBeDefined()
    }
    // AMENDED for ISSUE-123 (was: `[ROUTES_RELEASE, 'cut-0', 'cut-5', 'v1']`): the release is cut 1 from the switch.
    for (const release of ['cut-0', 'cut-5', 'v1'] as StepId[]) {
      expect(
        composeLegacyAgentRegistryFeed({ release, legacy: surface, timers }),
        release
      ).toBeUndefined()
      expect(composeLegacyLaunchObservation({ release, launches }), release).toBeUndefined()
    }
  })

  it('[ADR-001] composing LegacyAgentRegistryFeed adds no legacy board publish, crediting, projects-store write or notifier path', async () => {
    // TC-087-01 (21 §1 item 4; ADR-001 Consequences, IR-21-07): the feed reaches only the discovery and the registry.
    const { surface, reached } = legacySurface()
    let cycle: (() => void) | null = null
    const feed = composeLegacyAgentRegistryFeed({
      release: 'cut-1',
      legacy: surface,
      timers: {
        every: (_ms, run) => {
          cycle = run
          return () => (cycle = null)
        }
      }
    })
    feed?.start()
    await feed?.whenIdle()
    ;(cycle as (() => void) | null)?.()
    await feed?.whenIdle()
    expect(reached).toEqual(['discovery', 'registry', 'discovery', 'registry'])
    feed?.stop()
    expect(cycle).toBeNull()

    // LegacyLaunchObservation composes only the legacy runtime's own launch channel: no observation path of its own.
    const observation = composeLegacyLaunchObservation({ release: 'cut-1', launches })
    expect(Object.keys(observation ?? {})).toEqual(['channel'])
    expect(await observation?.channel.liveLaunches()).toEqual([{ launchId: 'launch:1' }])
  })

  it('[ADR-001] LegacyDwarfIdBridge is listed for cuts 1 to 4 and composed on A-13, A-23, A-26, A-27, A-P3, A-P4', async () => {
    // TC-088-03 (21 §3; 14 §5; AMENDMENT-8): listed from cut 1 to the end of cut 4 (4b), absent from cut 5 on.
    expect(LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'LegacyDwarfIdBridge')).toEqual({
      name: 'LegacyDwarfIdBridge',
      cuts: span('cut-1', 'cut-4b'),
      shapeAdapter: false
    })
    const HOST_DWARF = '01920000-0000-7000-9000-0000000e0001'
    const SESSION = 's-1'
    const reads: string[] = []
    const client = {
      call: (method: string) => {
        reads.push(method)
        return Promise.resolve([
          {
            dwarfId: HOST_DWARF,
            providerId: 'claude',
            identity: { providerId: 'claude', providerSessionId: SESSION }
          }
        ])
      },
      subscribe: () => () => {}
    } as unknown as Parameters<typeof composeLegacyDwarfIdBridge>[0]['client']
    const served: Array<[string, unknown]> = []
    const legacy = {
      serve: (channel: string, payload: unknown) => {
        served.push([channel, payload])
        return Promise.resolve(undefined)
      }
    }
    const { surface } = legacySurface()
    const compose = (release: StepId) =>
      composeLegacyDwarfIdBridge({ release, client, legacy, registry: surface })
    // Composed exactly in the releases it is listed for: not in this release's cut-0 table, and no longer once deleted.
    for (const release of span('cut-1', 'cut-4b')) {
      const composed = compose(release)
      expect(composed, release).toBeDefined()
      composed?.dispose()
    }
    // AMENDED for ISSUE-123 (was: `[ROUTES_RELEASE, 'cut-0', 'cut-5', 'v1']`): the release is cut 1 from the switch.
    for (const release of ['cut-0', 'cut-5', 'v1'] as StepId[]) {
      expect(compose(release), release).toBeUndefined()
    }
    expect(reads).toEqual([])

    // In cut 1 it is composed on the six legacy rows that carry a dwarf id, and on no other row.
    const composed = compose('cut-1')
    expect(composed?.channels.map((channel) => ROW_IDS[channel]).sort()).toEqual(
      ['A-13', 'A-23', 'A-26', 'A-27', 'A-P3', 'A-P4'].sort()
    )
    // The legacy side is what the registry feed writes through it; a bridged row reaches today's runtime with the
    // legacy id, and every other row passes unchanged.
    composed?.registry.registry.replace([
      {
        provider: 'claude',
        sessionId: SESSION,
        cwd: '/work/moria',
        status: 'busy',
        dwarfs: [
          {
            id: `claude:${SESSION}`,
            provider: 'claude',
            role: 'foreman',
            name: 'Thorin',
            status: 'working',
            sessionId: SESSION
          }
        ],
        updatedAt: 1
      }
    ])
    await composed?.legacy.serve('dwarf:activate', HOST_DWARF)
    await composed?.legacy.serve('mine:history', 'mine-1')
    expect(served).toEqual([
      ['dwarf:activate', `claude:${SESSION}`],
      ['mine:history', 'mine-1']
    ])
    // It reads only B-M41 from the Host.
    expect(new Set(reads)).toEqual(new Set(['strangler.dwarfIdentities']))
    composed?.dispose()
  })

  it('[ADR-001] LegacyAskRelay is listed for cuts 1 to 4', async () => {
    // TC-089 (21 §3; 14 §8 I-11): listed from cut 1 to the end of cut 4 (4b), absent from cut 5 on.
    expect(LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'LegacyAskRelay')).toEqual({
      name: 'LegacyAskRelay',
      cuts: span('cut-1', 'cut-4b'),
      shapeAdapter: false
    })
    // A-40 and A-41 stay `legacy` with today's shape in this release (21 §2 cut 1 "Legacy still serves").
    // AMENDED for ISSUE-141 (was: `ROUTES`, the cut-1 release table): from the cut-2 switch the release table is cut
    // 2's, so this pins the cut-1 table as it shipped (`testing/cut1Routes.ts`); cut 2 is pinned below.
    for (const key of ['agent:answerQuestion', 'agent:answerPermission'] as ChannelKey[]) {
      expect(
        CUT_1_ROUTES.filter((r) => r.channel === key).map((r) => [r.owner, r.shape]),
        key
      ).toEqual([['legacy', 'today']])
    }
    const HOST_DWARF = '01920000-0000-7000-9000-0000000e0001'
    const SESSION = 's-1'
    const LEGACY_DWARF = `claude:${SESSION}`
    const reads: string[] = []
    const client = {
      call: (method: string) => {
        reads.push(method)
        return Promise.resolve([
          {
            dwarfId: HOST_DWARF,
            providerId: 'claude',
            identity: { providerId: 'claude', providerSessionId: SESSION }
          }
        ])
      },
      subscribe: () => () => {}
    } as unknown as Parameters<typeof composeLegacyDwarfIdBridge>[0]['client']
    const served: Array<[string, unknown]> = []
    const legacy = {
      serve: (channel: string, payload: unknown) => {
        served.push([channel, payload])
        return Promise.resolve({ answered: true })
      }
    }
    const { surface } = legacySurface()
    const dwarfIds = composeLegacyDwarfIdBridge({
      release: 'cut-1',
      client,
      legacy,
      registry: surface
    })
    // Composed exactly in the releases it is listed for: not in this release's cut-0 table, and no longer once deleted.
    for (const release of span('cut-1', 'cut-4b')) {
      const relay = composeLegacyAskRelay({ release, dwarfIds })
      expect(relay, release).toBeDefined()
      relay?.dispose()
    }
    // AMENDED for ISSUE-123 (was: `[ROUTES_RELEASE, 'cut-0', 'cut-5', 'v1']`): the release is cut 1 from the switch.
    for (const release of ['cut-0', 'cut-5', 'v1'] as StepId[]) {
      expect(composeLegacyAskRelay({ release, dwarfIds }), release).toBeUndefined()
    }
    expect(composeLegacyAskRelay({ release: 'cut-1', dwarfIds: undefined })).toBeUndefined()

    // In cut 1 it is composed on A-40 and A-41, and on no other row.
    const relay = composeLegacyAskRelay({ release: 'cut-1', dwarfIds })
    expect(relay?.channels.map((channel) => ROW_IDS[channel]).sort()).toEqual(['A-40', 'A-41'])
    let changes = 0
    relay?.onChanged(() => (changes += 1))
    // The feed writes today's registry through it: the open ask is read after the write and shown on the Host dwarf.
    relay?.registry.registry.replace([
      {
        provider: 'claude',
        sessionId: SESSION,
        cwd: '/work/moria',
        status: 'busy',
        dwarfs: [
          {
            id: LEGACY_DWARF,
            provider: 'claude',
            role: 'foreman',
            name: 'Thorin',
            status: 'waiting',
            sessionId: SESSION,
            pendingPermission: {
              toolUseId: 'toolu_1',
              toolName: 'Bash',
              input: 'ls',
              channel: 'held',
              askedAt: '2026-10-05T10:00:00.000Z'
            }
          }
        ],
        updatedAt: 1
      }
    ])
    await relay?.whenIdle()
    expect(changes).toBe(1)
    expect(relay?.askFields(HOST_DWARF as DwarfId).pendingPermission?.toolUseId).toBe(
      'legacy:toolu_1'
    )
    // An answer to the relayed card reaches today's runtime with the legacy ids; every other row passes unchanged.
    await relay?.legacy.serve('agent:answerPermission', {
      dwarfId: HOST_DWARF,
      toolUseId: 'legacy:toolu_1',
      decision: 'allow'
    })
    await relay?.legacy.serve('mine:history', 'mine-1')
    expect(served).toEqual([
      [
        'agent:answerPermission',
        { dwarfId: LEGACY_DWARF, toolUseId: 'toolu_1', decision: 'allow' }
      ],
      ['mine:history', 'mine-1']
    ])
    // It reads only B-M41 from the Host (through the bridge).
    expect(new Set(reads)).toEqual(new Set(['strangler.dwarfIdentities']))

    // The facade shows the relay's ask fields on the Host dwarf (in a table that routes A-12 to the Host, as cut 1 will).
    let handler: ((event: HostEvent) => void) | null = null
    const board = composeBoardFacade({
      routes: [
        ...ROUTES.filter((r) => r.channel !== 'mines:get'),
        { channel: 'mines:get', owner: 'host', since: 'cut-1', parity: 'passed', shape: 'target' }
      ],
      client: {
        subscribe: (h: (event: HostEvent) => void) => {
          handler = h
          return () => (handler = null)
        }
      },
      windows: () => [],
      defer: (run) => run(),
      ...(relay === undefined ? {} : { askFields: relay.askFields })
    })
    const MINE = '01920000-0000-7000-9000-0000000c0001'
    const ore = { tokens: 0 }
    ;(handler as ((event: HostEvent) => void) | null)?.({
      kind: 'snapshot',
      snapshot: {
        snapshotId: 's-1',
        seq: 1,
        epoch: 'epoch-1',
        chunks: [
          {
            section: 'mines',
            data: [
              {
                id: MINE as MineId,
                path: '/work/moria' as FolderPath,
                name: 'moria',
                state: 'active',
                tier: 'silver',
                hasBeenMeasured: true,
                lastUsedAt: 1,
                totals: {
                  coal: ore,
                  bronze: ore,
                  copper: ore,
                  silver: ore,
                  gold: ore,
                  uranium: ore
                }
              }
            ]
          },
          {
            section: 'dwarfs',
            data: [
              {
                id: HOST_DWARF as DwarfId,
                mineId: MINE as MineId,
                providerId: 'claude',
                baseName: 'Thorin',
                customName: null,
                rank: 'foreman',
                parentDwarfId: null,
                delegated: false,
                sessionProfile: { providerId: 'claude' },
                presence: 'present',
                processState: 'running',
                status: 'asking',
                needsYou: true,
                canReceiveMessages: true,
                stopInFlight: false,
                stopUnavailableReason: null,
                owned: false,
                arrivedAt: 1
              }
            ]
          }
        ]
      }
    })
    const shown = (await board?.part.target.serve('mines:get', undefined)) as {
      mines: Array<{ dwarfs: Array<{ id: string; pendingPermission?: { toolUseId: string } }> }>
    }
    expect(CHANNELS['mines:get'].response.safeParse(shown).success).toBe(true)
    expect(shown.mines[0]?.dwarfs[0]?.pendingPermission?.toolUseId).toBe('legacy:toolu_1')
    board?.dispose()
    relay?.dispose()
    dwarfIds?.dispose()
  })
})

// AMENDED for ISSUE-091 (appended): the mines admin rows' future `host` routes.
describe('cut-1 mines admin rows (ISSUE-091)', () => {
  const ADMIN_ROWS: ChannelKey[] = [
    'mine:openPath',
    'mine:declare',
    'mine:declare-main',
    'mine:undeclare',
    'projects:query'
  ]
  const MINE = '01890a5d-ac96-774b-bcce-b302099a0001'
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  /** A KEEP row routed `host` keeps today's shape: its target shape is today's (14 §2.1 KEEP). */
  const hostKept = (channel: ChannelKey): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-1',
    parity: 'passed',
    shape: 'target'
  })
  const cut1Table = (): RouteTable => {
    let table: RouteTable = { ...routedBase, release: 'cut-1' }
    for (const channel of ADMIN_ROWS) table = withRoutes(table, channel, hostKept(channel))
    return table
  }
  /** A connected HostClient that records each call and answers each mines method. */
  function recordingClient() {
    const sent: string[] = []
    const answers: Record<string, unknown> = {
      'mines.resolveFile': { ok: true, value: { path: '/work/moria/src/a.ts' } },
      'mines.declare': { ok: true, value: { mineId: MINE } },
      'mines.adoptMainProject': { ok: true, value: { mineId: MINE } },
      'mines.remove': { ok: true, value: {} },
      'mines.list': { mines: [], total: 0 }
    }
    const client = {
      call: async (method: string) => {
        sent.push(method)
        return answers[method]
      },
      state: () => ({ state: 'connected', hostVersion: '0.0.0-test', compat: false }),
      subscribe: () => () => {}
    } as unknown as Parameters<typeof composeMinesAdmin>[0]['client']
    return { client, sent }
  }
  const native = {
    chooseFolder: async () => '/work/moria',
    openPath: async () => ({ opened: true as const })
  }
  const legacy = {
    liveLaunches: async () => [],
    endLaunch: async () => 'ended' as const,
    launchIdOfDwarf: () => undefined
  }
  const bridge = { toLegacy: async () => null }

  // AMENDED for ISSUE-123 (was: "in this release …" over `ROUTES` / `ROUTES_RELEASE`): the cut-1 switch routed them,
  // so the case proves the cut-0 table as it shipped; the cut-1 routes are pinned in `describe('release cut 1')`.
  it('[ADR-001] in the cut-0 table A-20, A-30, A-31, A-32 and A-34 stay legacy with today’s shape and the root composes no mines admin part', () => {
    for (const key of ADMIN_ROWS) {
      expect(CHANNELS[key].status, key).toBe('kept')
      expect(
        CUT_0_ROUTES.filter((r) => r.channel === key).map((r) => [r.owner, r.shape]),
        key
      ).toEqual([['legacy', 'today']])
    }
    expect(
      composeMinesAdmin({
        routes: CUT_0_ROUTES,
        release: 'cut-0',
        client: recordingClient().client,
        native,
        legacy,
        bridge
      })
    ).toBeUndefined()
  })

  it('[ADR-001] a cut-1 table routing A-20, A-30, A-31, A-32 and A-34 host with today’s shape passes the router test, and each row reaches its handler', async () => {
    const table = cut1Table()
    expect(reasons(table)).toEqual([])

    const { client, sent } = recordingClient()
    const composed = composeMinesAdmin({
      routes: table.routes,
      release: 'cut-1',
      client,
      native,
      legacy,
      bridge,
      newRequestId: () => '01890a5d-ac96-774b-bcce-b302099a8001'
    })
    expect(composed?.part.channels).toEqual(ADMIN_ROWS)
    const router = createRouter({
      routes: table.routes.filter((r) => ADMIN_ROWS.includes(r.channel)),
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(composed === undefined ? {} : { host: composed.part.target }),
      senders: { appEntry: APP_ENTRY, isModeWindow: (id) => id === 7 }
    })
    // Today's member names are registered unchanged: the renderer calls each row as it does today.
    const registered: string[] = []
    router.register({
      handle: (channel) => void registered.push(channel),
      on: (channel) => void registered.push(channel)
    })
    expect(registered.filter((wire) => ADMIN_ROWS.includes(wire as ChannelKey))).toEqual(ADMIN_ROWS)

    const payloads: Partial<Record<ChannelKey, unknown>> = {
      'mine:openPath': { mineId: MINE, target: 'src/a.ts' },
      'mine:undeclare': MINE,
      'projects:query': { sortBy: 'lastOpenedAt', direction: 'desc' }
    }
    for (const key of ADMIN_ROWS) {
      const answer = await router.dispatch(key, FROM_PANEL, payloads[key])
      expect(CHANNELS[key].response.safeParse(answer).success, key).toBe(true)
    }
    // Each row went to its Host method; A-31 had no worktree waiting, so it sent nothing.
    expect(sent).toEqual(['mines.resolveFile', 'mines.declare', 'mines.remove', 'mines.list'])
    composed?.dispose()
  })

  it('[ADR-001] the mines admin rows are composed with LegacyEndFirstAdapter only over LegacyDwarfIdBridge through cut 4, and with a pass-through after it', async () => {
    const routes = cut1Table().routes
    const { client } = recordingClient()
    // Through cut 4 (21 §3): no bridge, or no launched register to join, composes no removal that skips the legacy end.
    expect(
      composeMinesAdmin({ routes, release: 'cut-1', client, native, legacy, bridge: undefined })
    ).toBeUndefined()
    expect(
      composeMinesAdmin({
        routes,
        release: 'cut-4b',
        client,
        native,
        legacy: { liveLaunches: legacy.liveLaunches, endLaunch: legacy.endLaunch },
        bridge
      })
    ).toBeUndefined()
    // From cut 5 the adapter is gone: A-32 relays mines.remove directly.
    const late = composeMinesAdmin({
      routes,
      release: 'cut-5',
      client,
      native,
      legacy: { liveLaunches: legacy.liveLaunches, endLaunch: legacy.endLaunch },
      bridge: undefined,
      newRequestId: () => '01890a5d-ac96-774b-bcce-b302099a8001'
    })
    expect(await late?.part.target.serve('mine:undeclare', MINE, FROM_PANEL)).toEqual({
      outcome: 'removed'
    })
  })
})

/**
 * The table of a cut-1 rollback build (21 §2 cut 1 row "Rollback", §2.1 item 1): a cut-1 release whose rows the cut-1
 * switch moved off legacy code route `legacy` again (`rollbackOf`), so the legacy observer, ledger and notifier are
 * composed again. Only then must the Host's observer writes and level-3 notifications be off (21 §1 item 4). The
 * legacy writers' composition gated by this table was the cut-1 route switch's (ISSUE-123); the cut-1 retirement
 * (ISSUE-124, ISSUE-125) removed it, so a rollback table composes none of them any more ("cut-1 retirement" below).
 */
const cut1RowsRouteLegacy = (table: RouteTable): boolean =>
  table.release === 'cut-1' &&
  !table.routes.some(
    (r) => r.since === 'cut-1' && r.owner !== 'legacy' && CHANNELS[r.channel].status !== 'new'
  )

describe('cut-1 rollback (21 §2 cut 1)', () => {
  // AMENDED for ISSUE-123 (was: `cut1RowsRouteLegacy` declared here): it moved to module scope, unchanged, so the
  // cut-1 release cases read the same rule.

  /** A cut-1 table as its switch would build it from this table: the cut-1 NEW rows born, A-19 moved to the Host. */
  // AMENDED for ISSUE-141 (was: built from `preCut`, `ROUTES` and `UNROUTED`, the release table): from the cut-2 switch
  // the release table is cut 2's, so the cut-1 table is built from the cut-1 table as it shipped (`testing/cut1Routes.ts`).
  const cut1: RouteTable = {
    ...CUT_1_TABLE,
    routes: [
      ...CUT_1_ROUTES.filter((r) => r.channel !== 'mine:history'),
      { channel: 'mine:history', owner: 'host', since: 'cut-1', parity: 'passed', shape: 'target' },
      ...(Object.entries(CUT_1_UNROUTED) as [ChannelKey, StepId][])
        .filter(([, step]) => step === 'cut-1')
        .map(([channel]): ChannelRoute => ({
          channel,
          owner: CHANNELS[channel].placement === 'host' ? 'host' : 'ui-local',
          since: 'cut-1',
          parity: CHANNELS[channel].placement === 'host' ? 'passed' : 'n/a',
          shape: 'target'
        }))
    ],
    unrouted: Object.fromEntries(
      Object.entries(CUT_1_UNROUTED).filter(([, step]) => step !== 'cut-1')
    ) as RouteTable['unrouted']
  }

  it('[ADR-001] the cut-1 rollback setting is on if and only if the cut-1 rows route legacy with the legacy observer, ledger and notifier composed', () => {
    // TC-122-02: this build's setting against this build's table (the setting is false in every normal build).
    expect(CUT_1_ROLLBACK).toBe(cut1RowsRouteLegacy(preCut))
    // The rule tells the two cut-1 builds apart: the release build keeps the Host observer, the rollback build does
    // not; an earlier or later release never carries the setting (a later one is past cut 1's retirement, 21 §2.1).
    expect(checkRouteTable(cut1, KEYS)).toEqual([])
    expect(cut1RowsRouteLegacy(cut1)).toBe(false)
    const rolledBack = rollbackOf(cut1, 'cut-1')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    expect(cut1RowsRouteLegacy(rolledBack)).toBe(true)
    expect(rolledBack.routes.find((r) => r.channel === 'mine:history')?.owner).toBe('legacy')
    expect(cut1RowsRouteLegacy({ ...preCut, release: 'cut-0' })).toBe(false)
    expect(cut1RowsRouteLegacy({ ...rolledBack, release: 'cut-2' })).toBe(false)
  })

  it('[ADR-001] no renderer, preload or Settings code references the rollback setting', () => {
    // TC-122-03 (21 §2 cut 1 row "Rollback": never a person-facing option): the renderer and preload trees whole, and
    // every Settings file of the UI main process, the legacy bridges and the Host's preferences module.
    const SRC = resolve(import.meta.dirname, '../..')
    const files = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(folder, entry.name)
        if (entry.isDirectory()) return files(path)
        return /\.(ts|mts|cts|vue|js|mjs)$/.test(entry.name) ? [path] : []
      })
    const relativeOf = (path: string) =>
      path
        .slice(SRC.length + 1)
        .split('\\')
        .join('/')
    const scanned = [
      ...files(resolve(SRC, 'renderer')),
      ...files(resolve(SRC, 'preload')),
      ...files(resolve(SRC, 'host/modules/preferences')),
      ...[resolve(SRC, 'ui-main'), resolve(SRC, 'legacy-bridge')]
        .flatMap((folder) => files(folder))
        .filter((path) => /settings|preferences/i.test(relativeOf(path)))
    ]
    expect(scanned.length).toBeGreaterThan(0)
    const readers = scanned
      .filter((path) => /CUT_1_ROLLBACK\b|contracts\/strangler/.test(readFileSync(path, 'utf8')))
      .map(relativeOf)
    expect(readers).toEqual([])
  })
})

// AMENDED for ISSUE-123 (appended): the cut-1 route switch (21 §2 cut 1; TC-123-01, TC-123-06).
// AMENDED for ISSUE-141 (was: the release table `ROUTES` / `ROUTES_RELEASE` / `UNROUTED` / `HOST_ROUTE_MEMBERS`): from
// the cut-2 switch the release table is cut 2's, so these cases prove the cut-1 table as it shipped
// (`testing/cut1Routes.ts`), as ISSUE-123 did for cut 0; `describe('release cut 2')` pins the release table.
describe('release cut 1 (21 §2 cut 1)', () => {
  const cut1: RouteTable = {
    release: 'cut-1',
    routes: CUT_1_ROUTES,
    unrouted: CUT_1_UNROUTED,
    retired: CUT_1_TABLE.retired ?? {},
    adapters: ADAPTERS_AS_SHIPPED
  }
  /** The one registry key of a 14 id. */
  const keyOf = (id: string): ChannelKey => {
    const keys = KEYS.filter((key) => ROW_IDS[key] === id)
    expect(keys, id).toHaveLength(1)
    return keys[0] as ChannelKey
  }
  const routeOf = (key: ChannelKey): ChannelRoute[] => CUT_1_ROUTES.filter((r) => r.channel === key)
  const bornIn1 = (
    channel: ChannelKey,
    owner: ChannelRoute['owner'],
    parity: ChannelRoute['parity']
  ): ChannelRoute => ({ channel, owner, since: 'cut-1', parity, shape: 'target' })
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const MINE = '01890a5d-ac96-774b-bcce-b302099a0001'
  const DWARF = '01890a5d-ac96-774b-bcce-b302099ad001'

  /** A connected HostClient recording every method it is asked and answering each with a valid result. */
  function recordingHost() {
    const sent: string[] = []
    const answers: Record<string, unknown> = {
      'conversation.feed': { dwarfId: DWARF, messages: [], reachedStart: true },
      'conversation.mineHistory': { mineId: MINE, speakers: [] },
      'mines.resolveFile': { ok: true, value: { path: '/work/moria/src/a.ts' } },
      'mines.declare': { ok: true, value: { mineId: MINE } },
      'mines.adoptMainProject': { ok: true, value: { mineId: MINE } },
      'mines.remove': { ok: true, value: {} },
      'mines.list': { mines: [], total: 0 },
      'preferences.resetMetrics': { outcome: 'reset', epoch: 2 }
    }
    let handler: ((event: HostEvent) => void) | null = null
    const call = async (method: string): Promise<unknown> => {
      sent.push(method)
      return answers[method]
    }
    const client = {
      call,
      snapshot: async (): Promise<SnapshotPage> => {
        sent.push('session.snapshot')
        return {
          snapshotId: 'snap-1',
          seq: 1,
          epoch: 'epoch-1' as SnapshotPage['epoch'],
          chunks: []
        }
      },
      subscribe: (h: (event: HostEvent) => void) => {
        handler = h
        return () => (handler = null)
      },
      state: () => ({ state: 'connected', hostVersion: '0.0.0-test', compat: false }),
      withUiConnection: <T>(use: (ui: { call: typeof call }) => Promise<T>) => use({ call }),
      reportPresence: (presence: unknown) => void sent.push(`presence ${JSON.stringify(presence)}`)
    }
    return { client, sent, emit: (event: HostEvent) => handler?.(event) }
  }

  it('[ADR-001] in cut 1 A-N01, A-N02, A-15, A-19, A-31 and A-34 route host with shape target', async () => {
    expect(cut1.release).toBe('cut-1')
    expect(checkRouteTable(cut1, KEYS)).toEqual([])
    for (const id of ['A-N01', 'A-N02', 'A-15', 'A-19', 'A-31', 'A-34']) {
      const key = keyOf(id)
      expect(routeOf(key), id).toEqual([bornIn1(key, 'host', 'passed')])
    }
    // The root composes their handlers: A-N01 relays `session.snapshot`, A-15 and A-19 relay `conversation.feed` and
    // `conversation.mineHistory`, each answering its target shape, and A-N02 forwards every Host frame to the mode
    // windows as one batch per macrotask.
    const { client, sent, emit } = recordingHost()
    const pushed: Array<[string, unknown]> = []
    const macrotasks: Array<() => void> = []
    const reads = composeHostReads({
      routes: CUT_1_ROUTES,
      client: client as unknown as Parameters<typeof composeHostReads>[0]['client'],
      windows: () => [
        {
          webContentsId: 7,
          send: (push: string, batch: unknown) => void pushed.push([push, batch])
        }
      ],
      defer: (run) => void macrotasks.push(run)
    })
    expect(reads?.part.channels).toEqual(['host:snapshot', 'dwarf:feed:page', 'mine:history'])
    const router = createRouter({
      routes: CUT_1_ROUTES.filter((r) => (reads?.part.channels ?? []).includes(r.channel)),
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(reads === undefined ? {} : { host: reads.part.target }),
      senders
    })
    const payloads: Partial<Record<ChannelKey, unknown>> = {
      'host:snapshot': {},
      'dwarf:feed:page': { dwarfId: DWARF },
      'mine:history': MINE
    }
    for (const key of ['host:snapshot', 'dwarf:feed:page', 'mine:history'] as ChannelKey[]) {
      const answer = await router.dispatch(key, FROM_PANEL, payloads[key])
      expect(CHANNELS[key].response.safeParse(answer).success, key).toBe(true)
      expect((answer as { ok: boolean }).ok, key).toBe(true)
    }
    expect(sent).toEqual(['session.snapshot', 'conversation.feed', 'conversation.mineHistory'])
    const frame = { kind: 'evt', seq: 2, event: 'dwarf.departed' }
    emit({ kind: 'frame', frame } as unknown as HostEvent)
    emit({ kind: 'frame', frame } as unknown as HostEvent)
    for (const run of macrotasks.splice(0)) run()
    expect(pushed).toEqual([['host:event', [frame, frame]]])
    reads?.dispose()
    emit({ kind: 'frame', frame } as unknown as HostEvent)
    for (const run of macrotasks.splice(0)) run()
    expect(pushed).toHaveLength(1)

    // A-31 and A-34 are mines admin rows of the `host` target (A-20, A-30 and A-32 are pinned below).
    const admin = composeMinesAdmin({
      routes: CUT_1_ROUTES,
      release: 'cut-1',
      client: client as unknown as Parameters<typeof composeMinesAdmin>[0]['client'],
      native: {
        chooseFolder: async () => '/work/moria',
        openPath: async () => ({ opened: true as const })
      },
      legacy: {
        liveLaunches: async () => [],
        endLaunch: async () => 'ended' as const,
        launchIdOfDwarf: () => undefined
      },
      bridge: { toLegacy: async () => null }
    })
    expect(admin?.part.channels).toEqual(
      expect.arrayContaining(['mine:declare-main', 'projects:query'])
    )
    admin?.dispose()
  })

  it('[ADR-001] in cut 1 A-20 and A-30 are split between host and ui-local, and A-32 composes LegacyEndFirstAdapter', async () => {
    for (const id of ['A-20', 'A-30', 'A-32']) {
      const key = keyOf(id)
      expect(routeOf(key), id).toEqual([bornIn1(key, 'host', 'passed')])
    }
    // Each row has one `host` route; its handler runs the UI-main half (the folder picker, the file opener) around the
    // Host half (`mines.declare`, `mines.resolveFile`): the Host never opens a dialog or a file (14 §2.1 A-20, A-30).
    const events: string[] = []
    const { client, sent } = recordingHost()
    const native = {
      chooseFolder: async () => {
        events.push('ui-local chooseFolder')
        return '/work/moria'
      },
      openPath: async (path: string) => {
        events.push(`ui-local openPath ${path}`)
        return { opened: true as const }
      }
    }
    const recorded = {
      ...client,
      call: async (method: string) => {
        events.push(`host ${method}`)
        return client.call(method)
      }
    } as unknown as Parameters<typeof composeMinesAdmin>[0]['client']
    const legacy = {
      liveLaunches: async () => [],
      endLaunch: async () => 'ended' as const,
      launchIdOfDwarf: () => undefined
    }
    const bridge = { toLegacy: async () => null }
    const admin = composeMinesAdmin({
      routes: CUT_1_ROUTES,
      release: 'cut-1',
      client: recorded,
      native,
      legacy,
      bridge,
      newRequestId: () => '01890a5d-ac96-774b-bcce-b302099a8001'
    })
    const router = createRouter({
      routes: CUT_1_ROUTES.filter((r) => (admin?.part.channels ?? []).includes(r.channel)),
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(admin === undefined ? {} : { host: admin.part.target }),
      senders
    })
    await router.dispatch('mine:openPath', FROM_PANEL, { mineId: MINE, target: 'src/a.ts' })
    await router.dispatch('mine:declare', FROM_PANEL, undefined)
    expect(events).toEqual([
      'host mines.resolveFile',
      'ui-local openPath /work/moria/src/a.ts',
      'ui-local chooseFolder',
      'host mines.declare'
    ])
    expect(sent).toEqual(['mines.resolveFile', 'mines.declare'])
    admin?.dispose()

    // A-32 is composed only with LegacyEndFirstAdapter in cut 1: without the dwarf id bridge or today's launched
    // register to join, the root composes no removal at all (21 §3; ISSUE-090).
    expect(LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'LegacyEndFirstAdapter')?.cuts).toContain(
      'cut-1'
    )
    const composedWith = (deps: Partial<Parameters<typeof composeMinesAdmin>[0]>) =>
      composeMinesAdmin({
        routes: CUT_1_ROUTES,
        release: 'cut-1',
        client: recorded,
        native,
        legacy,
        bridge,
        ...deps
      })
    expect(composedWith({ bridge: undefined })).toBeUndefined()
    expect(
      composedWith({ legacy: { liveLaunches: legacy.liveLaunches, endLaunch: legacy.endLaunch } })
    ).toBeUndefined()
  })

  it('[ADR-001] in cut 1 A-12 and A-P2 go through BoardFacadeAdapter and A-33 through ResetFanout', async () => {
    // Lead resolution H3: A-12 and A-P2 are RETIRE rows routed `host` with the target shape, and a RETIRE row's
    // registry entry is today's shape (14 §2.1), so the generated preload keeps today's `MinesSnapshot` for both.
    for (const id of ['A-12', 'A-P2']) {
      const key = keyOf(id)
      expect(routeOf(key), id).toEqual([bornIn1(key, 'host', 'passed')])
      expect(CHANNELS[key].status, id).toBe('retired')
      expect(CHANNELS[key].response, id).toBe(TODAY_SHAPES[key]?.response)
    }
    const preload = readFileSync(resolve(import.meta.dirname, '../../preload/index.ts'), 'utf8')
    expect(preload).toContain('/** A-12 · `mines:get` · invoke · RETIRE · target shape */')
    expect(preload).toContain('/** A-P2 · `mines:update` · push · RETIRE · target shape */')

    // The root composes the facade as A-12's `host` handler, and it pushes A-P2.
    const { client } = recordingHost()
    const facade = composeBoardFacade({
      routes: CUT_1_ROUTES,
      client,
      windows: () => [],
      defer: (run) => run()
    })
    expect(facade?.part.channels).toEqual(['mines:get'])
    facade?.dispose()

    // A-33 is `legacy` + `target` through its shape adapter ResetFanout: the legacy reset first, then the Host saga.
    const a33 = keyOf('A-33')
    expect(routeOf(a33)).toEqual([
      {
        channel: a33,
        owner: 'legacy',
        since: 'cut-1',
        parity: 'n/a',
        shape: 'target',
        shapeAdapter: 'ResetFanout'
      }
    ])
    // AMENDED for ISSUE-236, the 4a retirement (was: `composeResetFanout` over the cut-1 table, the router refusing to
    // start without it, and A-33 running today's reset before the Host saga): `ResetFanout` left the tree.
  })

  it('[ADR-001] in cut 1 A-14, A-16, A-17, A-18 and A-P5 have no route and no handler, and A-N16 exists', async () => {
    const retired = ['A-14', 'A-16', 'A-17', 'A-18', 'A-P5'].map(keyOf)
    // AMENDED for ISSUE-001 (was: `RETIRED`, the release's list): from 3a the release lists A-26, A-37 and A-38 too, so
    // the cut-1 table's own list is read.
    expect(cut1.retired).toEqual(Object.fromEntries(retired.map((key) => [key, 'cut-1'])))
    const reached: string[] = []
    const router = createRouter({
      routes: CUT_1_ROUTES,
      legacy: { serve: async (channel) => void reached.push(`legacy ${channel}`) },
      uiLocal: { serve: async (channel) => void reached.push(`ui-local ${channel}`) },
      host: { serve: async (channel) => void reached.push(`host ${channel}`) },
      shapeAdapters: { ResetFanout: { serve: async () => undefined } },
      senders
    })
    for (const key of retired) {
      // The registry row stays until the legacy code it spoke to is deleted (21 §2 cut 1 "Retired rows").
      expect(CHANNELS[key], key).toBeDefined()
      expect(routeOf(key), key).toEqual([])
      if (CHANNELS[key].kind === 'push') continue
      const answer = await router.dispatch(key, FROM_PANEL, undefined)
      expect(answer, key).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_FOUND' } })
    }
    expect(reached).toEqual([])
    // A-N16 replaces A-P5: born `ui-local` in cut 1 and pushed by UI main (ISSUE-114).
    const an16 = keyOf('A-N16')
    expect(CHANNELS[an16].kind).toBe('push')
    expect(routeOf(an16)).toEqual([bornIn1(an16, 'ui-local', 'n/a')])
    expect(CUT_1_UNROUTED[an16]).toBeUndefined()
  })

  it('[ADR-001] in cut 1 A-44, A-N17 to A-N21 and A-N12 route ui-local with shape target, and A-44 feeds presence', async () => {
    const a44 = keyOf('A-44')
    expect(routeOf(a44)).toEqual([bornIn1(a44, 'ui-local', 'passed')])
    for (const id of ['A-N17', 'A-N18', 'A-N19', 'A-N20', 'A-N21', 'A-N12']) {
      const key = keyOf(id)
      expect(routeOf(key), id).toEqual([bornIn1(key, 'ui-local', 'n/a')])
    }
    // Only A-N33 is still unrouted (AMENDMENT-11).
    // AMENDED for ISSUE-221 (was: A-N33 only): A-N31, born `host` in cut 2, waits for the cut-2 switch (ISSUE-141).
    // AMENDED for ISSUE-129: A-N07, born `host` in cut 2, waits for the same switch.
    // AMENDED for ISSUE-223: A-N32, born `host` in cut 2, waits for the same switch.
    // AMENDED for ISSUE-171: A-N29, born `host` in 3a, waits for the step-3a switch (ISSUE-001).
    // AMENDED for ISSUE-172: A-N08 and A-N09, born `host` in cut 2 (lead decision, 2026-10-17).
    expect(CUT_1_UNROUTED).toEqual({
      'host:connection:confirm-restart': 'generation-2',
      'claude:hooks:set': 'cut-2',
      'ask:step:set': 'cut-2',
      'welcome:answer': 'cut-2',
      'dwarf:stop': 'cut-3a',
      'dwarf:message:retry': 'cut-3a',
      'dwarf:rename': 'cut-2',
      'dwarf:name:reset': 'cut-2',
      // AMENDED for ISSUE-174: A-N10 and A-N11, born `host` in 3a, wait for the same switch.
      'host:recovery:retry': 'cut-3a',
      'host:recovery:dismiss': 'cut-3a'
    })
    // A-44 on its 14 wire feeds UI main's PresenceTracker, which tells the Host (B-M07) once the report settled.
    const host = recordingHost()
    const timers: Array<() => void> = []
    const presence = composePresence({
      routes: CUT_1_ROUTES,
      client: host.client,
      timers: {
        after: (_ms, run) => {
          timers.push(run)
          return () => {}
        }
      },
      visibleWindows: () => [7]
    })
    expect(presence?.part.channels).toEqual([a44])
    const router = createRouter({
      routes: routeOf(a44),
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(presence === undefined ? {} : { uiLocal: presence.part.target }),
      senders
    })
    const registered: string[] = []
    router.register({
      handle: (wire) => void registered.push(wire),
      on: (wire) => void registered.push(wire)
    })
    expect(registered).toContain('presence:visibleMines')
    expect(registered).not.toContain('panel:openMine')
    await router.dispatch(a44, FROM_PANEL, { mineIds: [MINE] })
    for (const run of timers.splice(0)) run()
    expect(host.sent).toEqual([
      `presence ${JSON.stringify({ onScreenMineIds: [MINE], anyWindowVisible: true, seq: 1 })}`
    ])
  })

  // AMENDED for ISSUE-125 (was, after ISSUE-124: "[ADR-001] in cut 1 no legacy notifier is composed", and "… the legacy
  // notifier is composed again, never together with the Host observer's writes, and the retired rows are served by
  // today's runtime"): after the cut-1 retirement no route table composes today's notifier ("cut-1 retirement" below),
  // so what stays of the rollback case is the router half (lead resolution H1).
  it("[ADR-001] with the cut-1 rows flipped back to legacy the rows cut 1 retired are served by today's runtime again and the earlier cuts' rows keep their routes", async () => {
    const rolledBack = rollbackOf(cut1, 'cut-1')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    expect(cut1RowsRouteLegacy(rolledBack)).toBe(true)
    // Lead resolution H1: the rows cut 1 retired route `legacy` with today's shape again, and the router serves them
    // through today's runtime; the rows of earlier cuts keep their routes.
    expect(rolledBack.retired).toEqual({})
    const served: string[] = []
    const router = createRouter({
      routes: rolledBack.routes,
      legacy: { serve: async (channel) => void served.push(channel) },
      uiLocal: { serve: async () => undefined },
      host: { serve: async () => undefined },
      senders
    })
    // AMENDED for ISSUE-001 (was: `Object.keys(RETIRED)`, the release's list): the rows cut 1 retired, as its table
    // lists them.
    const retired = Object.keys(cut1.retired ?? {}) as ChannelKey[]
    expect(retired.length).toBeGreaterThan(0)
    // Each in today's request shape (TODAY_SHAPES).
    const todayPayloads: Partial<Record<ChannelKey, unknown>> = {
      'dwarf:feed': 'claude:s1',
      'panel:watchDwarfFeed': 'claude:s1',
      'dwarf:refreshTelemetry': 'claude:s1',
      'dwarf:setTuning': { dwarfId: 'claude:s1', change: { kind: 'model', model: 'opus' } }
    }
    for (const key of retired) {
      expect(
        rolledBack.routes.filter((r) => r.channel === key),
        key
      ).toEqual([legacyToday(key)])
      if (CHANNELS[key].kind !== 'push') await router.dispatch(key, FROM_PANEL, todayPayloads[key])
    }
    expect(served.sort()).toEqual(retired.filter((key) => CHANNELS[key].kind !== 'push').sort())
    expect(rolledBack.routes.filter((r) => r.since === 'cut-0')).toEqual(
      CUT_1_ROUTES.filter((r) => r.since === 'cut-0')
    )
  })

  it('[ADR-001] in cut 1 every host route uses only seam-B members born by cut 1 and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of CUT_1_ROUTES.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = CUT_1_HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at('cut-1')
        )
      }
    }
    // 21 §2 "Seam B members: the cut in which each is born", row 1 (`21-migration-plan.md:352-362`).
    expect(
      Object.fromEntries(Object.entries(SEAM_B_METHODS_BORN).filter(([, step]) => step === 'cut-1'))
    ).toEqual({
      presence: 'cut-1', // B-M07
      'attention.clicked': 'cut-1', // B-M08
      'ui.resetPreferences.ack': 'cut-1', // B-M09
      'preferences.get': 'cut-1', // B-M12
      'preferences.set': 'cut-1', // B-M13
      'preferences.resetMetrics': 'cut-1', // B-M15
      'mines.declare': 'cut-1', // B-M16
      'mines.adoptMainProject': 'cut-1', // B-M17
      'mines.remove': 'cut-1', // B-M18
      'mines.list': 'cut-1', // B-M19
      'mines.resolveFile': 'cut-1', // B-M20
      'conversation.feed': 'cut-1', // B-M26
      'conversation.mineHistory': 'cut-1', // B-M27
      'strangler.dwarfIdentities': 'cut-1' // B-M41
    })
    expect(CUT_1_HOST_ROUTE_MEMBERS).toEqual({
      'tray:stopEverything:confirm': ['host.shutdown'],
      'host:snapshot': ['session.snapshot'],
      'host:event': ['events.subscribe'],
      'mines:get': ['session.snapshot', 'events.subscribe'],
      'mines:update': ['session.snapshot', 'events.subscribe'],
      'dwarf:feed:page': ['conversation.feed'],
      'mine:history': ['conversation.mineHistory'],
      'mine:openPath': ['mines.resolveFile'],
      'mine:declare': ['mines.declare'],
      'mine:declare-main': ['mines.adoptMainProject'],
      'mine:undeclare': ['mines.remove'],
      'projects:query': ['mines.list']
    })
  })
  it('[ADR-001] in cut 1 the bridges composed over today’s runtime read its poll interval only once the feed starts', async () => {
    // Today's runtime answers its poll interval only once it is composed (`LegacyRuntimeRoute.surface`), which the
    // root does after the bridges are composed: composing them must not read it, or the start fails.
    let composed = false
    const reads: string[] = []
    const surface: LegacyRuntimeSurface = {
      get pollIntervalMs() {
        if (!composed)
          throw new Error('the poll interval is read before today’s runtime is composed')
        return 2_000
      },
      discovery: [],
      registry: { replace: () => {} },
      board: { publish: () => {} },
      ledger: { credit: () => {} },
      projects: { record: () => {} },
      notifier: { update: () => {} }
    }
    const client = {
      call: () => Promise.resolve([]),
      subscribe: () => () => {}
    } as unknown as Parameters<typeof composeLegacyDwarfIdBridge>[0]['client']
    const dwarfIds = composeLegacyDwarfIdBridge({
      release: 'cut-1',
      client,
      legacy: { serve: () => Promise.resolve(undefined) },
      registry: surface
    })
    const relay = composeLegacyAskRelay({ release: 'cut-1', dwarfIds })
    const feed = composeLegacyAgentRegistryFeed({
      release: 'cut-1',
      legacy: relay?.registry,
      timers: {
        every: (ms) => {
          reads.push(`every ${ms}`)
          return () => {}
        }
      }
    })
    expect(feed).toBeDefined()
    composed = true
    feed?.start()
    expect(reads).toEqual(['every 2000'])
    feed?.stop()
    relay?.dispose()
    dwarfIds?.dispose()
  })
})

describe('cut-0 retirement', () => {
  // ISSUE-058 (21 §2 cut 0 "Retired at the end"; 21 §1 items 3, 6, 7): after the cut-0 soak (OQ-71) today's window,
  // tray and window-family handlers leave the tree. The rows they served keep exactly one owner, `ui-local`
  // (ADR-001 item 3).
  const WINDOW_FAMILY_WIRES: readonly string[] = [
    'panel:hide',
    'panel:raise',
    'panel:getAlwaysOnTop',
    'panel:setAlwaysOnTop',
    'panel:visible:get',
    'panel:layout:get',
    'panel:layout:set',
    'shortcut:get',
    'shortcut:set',
    // A-24 opened its picker on today's window: it left with it.
    'dwarf:attachments:choose'
  ]
  const SRC = resolve(import.meta.dirname, '../..')
  const read = (relative: string): string => readFileSync(resolve(SRC, relative), 'utf8')

  /** `IPC_CHANNELS` member names by wire, read from the shared constants' own text (a test may not import src/shared). */
  function memberOfWire(wire: string): string {
    const block = read('shared/contracts.ts').split('export const IPC_CHANNELS = {')[1] ?? ''
    const match = new RegExp(`^ {2}([A-Za-z]+): '${wire}'`, 'm').exec(block)
    if (match?.[1] === undefined) throw new Error(`no IPC_CHANNELS member for ${wire}`)
    return match[1]
  }

  it('[ADR-001] after the cut-0 retirement no legacy handler is registered for a window-family row', () => {
    for (const wire of WINDOW_FAMILY_WIRES) {
      const key = keyOfWire(wire) as ChannelKey
      const routes = ROUTES.filter((route) => route.channel === key)
      expect(
        routes.map((route) => route.owner),
        wire
      ).toEqual(['ui-local'])
    }
    // No composition of today's runtime names a window-family wire: neither the bridge nor the legacy root.
    const composers = ['legacy-bridge/LegacyRuntimeRoute.ts', 'main/index.ts']
    for (const file of composers) {
      const source = read(file)
      for (const wire of WINDOW_FAMILY_WIRES) {
        expect(source, `${file} ${wire}`).not.toMatch(
          new RegExp(String.raw`IPC_CHANNELS\.${memberOfWire(wire)}\b`)
        )
      }
      // And none of them reaches today's window, tray or shortcut modules.
      expect(source, file).not.toMatch(/shell\/(window|tray)'/)
    }
    expect(existsSync(resolve(SRC, 'main/shell/window.ts'))).toBe(false)
    expect(existsSync(resolve(SRC, 'main/shell/tray.ts'))).toBe(false)
  })
})

describe('cut-1 retirement (21 §2 cut 1)', () => {
  // ISSUE-124 (21 §2 cut 1 "Retired at the end"; 21 §1 items 3, 6, 7; 21 §2.1 item 4): after the cut-1 soak (OQ-71)
  // today's observer composition leaves LegacyRuntimeRoute whatever the route table, so a table that routes the cut-1
  // rows `legacy` again composes none of it either: from here cut 1 rolls forward only. Only the registry-only
  // discovery of LegacyAgentRegistryFeed stays (21 §3, until the end of cut 4).
  // AMENDED for ISSUE-141 (was: the release table `ROUTES`, then cut 1's): the cut-1 table as it shipped.
  const cut1: RouteTable = CUT_1_TABLE
  const SRC = resolve(import.meta.dirname, '../..')
  const legacyRoute = (): string =>
    readFileSync(resolve(SRC, 'legacy-bridge/LegacyRuntimeRoute.ts'), 'utf8')

  it('[ADR-001] after the cut-1 retirement LegacyRuntimeRoute composes no poller, scan wiring, publish gate, ledger crediting or projects-store board path, whatever the route table', () => {
    // AMENDED for ISSUE-125 (was: each table's `legacyObserverComposition` had none of the four retired sinks): the
    // composition left with the notifier, so nothing of today's observer is derived from a route table any more.
    for (const table of [cut1, rollbackOf(cut1, 'cut-1')]) {
      expect(checkRouteTable(table, KEYS)).toEqual([])
    }
    const source = legacyRoute()
    // No poll timer: today's runtime ticks only through LegacyAgentRegistryFeed's cycles (the scan wiring it keeps).
    expect(source).not.toMatch(/\bruntime\??\.start\(/)
    // No publish gate → board path: A-P2 is BoardFacadeAdapter's push from the Host board.
    expect(source).not.toMatch(/IPC_CHANNELS\.minesUpdated\b/)
    // No ledger crediting: no vault store and no coal backfill; today's ledger is a vault that remembers nothing.
    expect(source).not.toMatch(/openLedgerStore|runCoalBackfill/)
    expect(source).toMatch(/store: nullLedgerStore\(\)/)
    // No projects-store board path: what a tick observes is written nowhere, every read and person's act stays.
    expect(source).toMatch(/withoutObserverWrites\(openedProjects\.store/)
    expect(source).not.toMatch(
      /observer\.(pollTimer|boardPublish|ledgerCrediting|projectsObserverWrites)\b/
    )
  })

  it('[ADR-001] after the cut-1 retirement LegacyAgentRegistryFeed is still composed and writes only the legacy in-memory registry', async () => {
    const reached: string[] = []
    const surface: LegacyRuntimeSurface = {
      pollIntervalMs: 2_000,
      discovery: [
        {
          kind: 'claude',
          scan: async () => {
            reached.push('discovery')
            return []
          }
        }
      ],
      registry: { replace: () => void reached.push('registry') },
      board: { publish: () => void reached.push('board publish') },
      ledger: { credit: () => void reached.push('crediting') },
      projects: { record: () => void reached.push('projects-store write') },
      notifier: { update: () => void reached.push('notifier') }
    }
    const feed = composeLegacyAgentRegistryFeed({
      release: ROUTES_RELEASE,
      legacy: surface,
      timers: { every: () => () => {} }
    })
    expect(feed).toBeDefined()
    feed?.start()
    await feed?.whenIdle()
    expect(reached).toEqual(['discovery', 'registry'])
    feed?.stop()
  })
})

describe('cut-1 notifier retirement (21 §2 cut 1)', () => {
  // ISSUE-125 (21 §2 cut 1 "Retired at the end"; 21 §1 item 4; ADR-018 items 1, 7): after the cut-1 soak (OQ-71)
  // today's notifier (`notifyDecision` → Electron `Notification`) leaves LegacyRuntimeRoute whatever the route table, so
  // the Host's attention policy, drawn by the UI's `ElectronNotificationDisplay`, is the only way to an OS notification.
  const SRC = resolve(import.meta.dirname, '../..')
  const read = (relative: string): string => readFileSync(resolve(SRC, relative), 'utf8')
  const productionFiles = (folder: string): string[] =>
    readdirSync(resolve(SRC, folder), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${folder}/${entry.name}`
      if (entry.isDirectory()) return productionFiles(relative)
      return /\.ts$/.test(entry.name) && !/\.(test|contract)\.ts$/.test(entry.name)
        ? [relative]
        : []
    })

  it('[ADR-018] after the cut-1 retirement no legacy notifier is composed, whatever the route table, and only the Host attention policy reaches an OS notification', () => {
    const route = read('legacy-bridge/LegacyRuntimeRoute.ts')
    expect(route).not.toMatch(
      /createNotifier|createElectronNotifications|notifyDecision|main\/notifications\/(notifier|notifyDecision|electronNotifications|appUserModelId)'/
    )
    // Whatever the route table: the root derives nothing of today's observer from it any more.
    const root = read('ui-main/index.ts')
    expect(root).not.toMatch(/legacyObserver(Owner|Composition)\b/)
    expect(route).not.toMatch(/observer\.notifier\b/)
    // The only Electron `Notification` of the UI process is the one handed to the Host policy's display adapter.
    const notificationImporters = [
      ...productionFiles('ui-main'),
      ...productionFiles('legacy-bridge')
    ].filter((file) =>
      /import\s*\{[^}]*\bNotification\b[^}]*\}\s*from\s*'electron'/.test(read(file))
    )
    expect(notificationImporters).toEqual(['ui-main/index.ts'])
    expect(root).toMatch(/new ElectronNotificationDisplay\(\{\s*notification: Notification,/)
  })
})

// AMENDED for ISSUE-141 (appended): the cut-2 route switch (21 §2 cut 2; TC-141-01, TC-141-06).
// AMENDED for ISSUE-001 (was: the release table `ROUTES` / `ROUTES_RELEASE` / `UNROUTED` / `RETIRED`): from the step-3a
// switch the release table is 3a's, so these cases prove the cut-2 table as it shipped (`testing/cut2Routes.ts`), as
// ISSUE-141 did for cut 1; `describe('release 3a')` pins the release table.
describe('release cut 2 (21 §2 cut 2)', () => {
  const cut2: RouteTable = {
    release: 'cut-2',
    routes: CUT_2_ROUTES,
    unrouted: CUT_2_UNROUTED,
    retired: CUT_2_RETIRED,
    adapters: ADAPTERS_AS_SHIPPED
  }
  const routeOf = (key: ChannelKey): ChannelRoute[] => CUT_2_ROUTES.filter((r) => r.channel === key)
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const QUESTION = 'agent:answerQuestion' as const // A-40
  const PERMISSION = 'agent:answerPermission' as const // A-41
  const HOST_ASK = '01920000-0000-7000-9000-0000000000a5'
  const REQUEST = '01920000-0000-7000-a000-000000000141'
  const FOREMAN = '01920000-0000-7000-9000-0000000e0001'
  const CODEX = '01920000-0000-7000-9000-0000000e0002'
  const SESSION = 's-1'
  const THREAD = 't-1'

  /** Today's sessions: a held Claude permission (legacy-launch) and an observed Codex question (legacy-ask-channel). */
  const LEGACY_SESSIONS = [
    {
      provider: 'claude',
      sessionId: SESSION,
      cwd: '/work/moria',
      status: 'busy',
      dwarfs: [
        {
          id: `claude:${SESSION}`,
          provider: 'claude',
          role: 'foreman',
          name: 'Thorin',
          status: 'waiting',
          sessionId: SESSION,
          pendingPermission: {
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            input: 'ls',
            channel: 'held',
            askedAt: '2026-10-14T10:00:00.000Z'
          }
        }
      ],
      updatedAt: 1
    },
    {
      provider: 'codex',
      sessionId: THREAD,
      cwd: '/work/moria',
      status: 'idle',
      dwarfs: [
        {
          id: `codex:${THREAD}`,
          provider: 'codex',
          role: 'foreman',
          name: 'Balin',
          status: 'waiting',
          sessionId: THREAD,
          pendingQuestion: {
            toolUseId: 'call_1',
            channel: 'terminal',
            questions: [
              {
                question: 'Which branch should I use?',
                multiSelect: false,
                options: [{ label: 'main' }, { label: 'develop' }]
              }
            ],
            askedAt: '2026-10-14T10:00:01.000Z'
          }
        }
      ],
      updatedAt: 1
    }
  ]

  /**
   * The cut-2 answer path as the root composes it: today's runtime (recording, answering today's success) behind
   * `LegacyDwarfIdBridge` and `LegacyAskRelay`, the A-40/A-41 `host` handlers over a recording HostClient, and the
   * router registered over the release table with the answer qualifiers. `invoke` is the renderer's call on a row's
   * wire.
   */
  // AMENDED for ISSUE-141 (verifier, 2026-10-14; was: no parameter, the release table's routes): the routes to compose
  // and route over, so the rollback build's table can be driven with the renderer's own payloads too.
  async function answerWorld(table: readonly ChannelRoute[] = CUT_2_ROUTES) {
    const legacyServed: Array<[string, unknown]> = []
    const hostCalls: Array<[string, unknown]> = []
    const client = {
      call: (method: string, params: unknown) => {
        if (method === 'strangler.dwarfIdentities') {
          return Promise.resolve([
            {
              dwarfId: FOREMAN,
              providerId: 'claude',
              identity: { providerId: 'claude', providerSessionId: SESSION }
            },
            {
              dwarfId: CODEX,
              providerId: 'codex',
              identity: { providerId: 'codex', providerSessionId: THREAD }
            }
          ])
        }
        hostCalls.push([method, params])
        return Promise.resolve({ kind: 'accepted' })
      },
      subscribe: () => () => {}
    }
    const legacy = {
      serve: (channel: string, payload: unknown) => {
        legacyServed.push([channel, payload])
        return Promise.resolve({ answered: true })
      }
    }
    const surface: LegacyRuntimeSurface = {
      pollIntervalMs: 2_000,
      discovery: [],
      registry: { replace: () => {} },
      board: { publish: () => {} },
      ledger: { credit: () => {} },
      projects: { record: () => {} },
      notifier: { update: () => {} }
    }
    const dwarfIds = composeLegacyDwarfIdBridge({
      release: 'cut-2',
      client: client as unknown as Parameters<typeof composeLegacyDwarfIdBridge>[0]['client'],
      legacy,
      registry: surface
    })
    const relay = composeLegacyAskRelay({ release: 'cut-2', dwarfIds })
    relay?.registry.registry.replace(
      LEGACY_SESSIONS as unknown as Parameters<LegacyRegistryReplace>[0]
    )
    await relay?.whenIdle()
    const answers = composeAskAnswers({
      routes: table,
      release: 'cut-2',
      client: client as unknown as Parameters<typeof composeAskAnswers>[0]['client'],
      relay,
      log: { record: () => {} }
    })
    const handlers = new Map<string, (event: typeof FROM_PANEL, payload: unknown) => unknown>()
    createRouter({
      routes: table.filter((r) => r.channel === QUESTION || r.channel === PERMISSION),
      legacy: relay?.legacy ?? legacy,
      ...(answers?.part === undefined ? {} : { host: answers.part.target }),
      ...(answers === undefined ? {} : { shapeAdapters: answers.shapeAdapters }),
      ...(answers === undefined ? {} : { qualifiers: answers.qualifiers }),
      senders
    }).register({
      handle: (wire, listener) => void handlers.set(wire, listener),
      on: () => {}
    })
    const invoke = (wire: string, payload: unknown) => {
      const listener = handlers.get(wire)
      if (listener === undefined) throw new Error(`no listener for ${wire}`)
      return listener(FROM_PANEL, payload)
    }
    const dispose = () => {
      relay?.dispose()
      dwarfIds?.dispose()
    }
    return { answers, invoke, legacyServed, hostCalls, dispose }
  }

  it('[ADR-001] in cut 2 A-40 and A-41 route host with shape target for Host AskIds and legacy through LegacyAnswerShapeAdapter for legacy: AskIds, one owner per qualifier', async () => {
    expect('cut-2').toBe('cut-2')
    expect(checkRouteTable(cut2, KEYS)).toEqual([])
    for (const key of [QUESTION, PERMISSION]) {
      // One owner per (channel, qualifier) (21 §1 item 2): the Host for its own AskIds, today's runtime through the
      // shape adapter for each origin of the relay's `legacy:` namespace (21 §2 cut 2 "Qualified routes").
      expect(routeOf(key), key).toEqual([
        { channel: key, owner: 'host', since: 'cut-2', parity: 'passed', shape: 'target' },
        {
          channel: key,
          owner: 'legacy',
          since: 'cut-2',
          parity: 'n/a',
          qualifier: { origin: 'legacy-launch' },
          shape: 'target',
          shapeAdapter: 'LegacyAnswerShapeAdapter'
        },
        {
          channel: key,
          owner: 'legacy',
          since: 'cut-2',
          parity: 'n/a',
          qualifier: { origin: 'legacy-ask-channel' },
          shape: 'target',
          shapeAdapter: 'LegacyAnswerShapeAdapter'
        }
      ])
      expect(resolveRoute(CUT_2_ROUTES, key)?.owner, key).toBe('host')
      for (const origin of ['legacy-launch', 'legacy-ask-channel'] as const) {
        expect(resolveRoute(CUT_2_ROUTES, key, { origin })?.shapeAdapter, `${key} ${origin}`).toBe(
          'LegacyAnswerShapeAdapter'
        )
      }
    }

    // Through the root's composition: the qualifier is the relay's AskId namespace and origin, never a guess.
    const world = await answerWorld()
    expect(world.answers?.part?.channels).toEqual([QUESTION, PERMISSION])
    expect(Object.keys(world.answers?.shapeAdapters ?? {})).toEqual(['LegacyAnswerShapeAdapter'])
    const accepted = { ok: true, value: { kind: 'accepted' } }
    // A legacy-launched session's permission (origin legacy-launch) reaches today's runtime with today's ids.
    expect(
      await world.invoke(PERMISSION, {
        askId: 'legacy:toolu_1',
        decision: 'allow',
        requestId: REQUEST
      })
    ).toEqual(accepted)
    // An observed Codex question (origin legacy-ask-channel) reaches today's runtime too.
    expect(
      await world.invoke(QUESTION, {
        askId: 'legacy:call_1',
        answers: [{ step: 0, option: 'develop' }],
        requestId: REQUEST
      })
    ).toEqual(accepted)
    expect(world.legacyServed).toEqual([
      [PERMISSION, { dwarfId: `claude:${SESSION}`, toolUseId: 'toolu_1', decision: 'allow' }],
      [
        QUESTION,
        {
          dwarfId: `codex:${THREAD}`,
          toolUseId: 'call_1',
          answers: { 'Which branch should I use?': 'develop' }
        }
      ]
    ])
    // A Host AskId goes to the broker with the renderer's payload unchanged, and never to today's runtime.
    const hostPermission = { askId: HOST_ASK, decision: 'deny', requestId: REQUEST }
    expect(await world.invoke(PERMISSION, hostPermission)).toEqual(accepted)
    expect(world.hostCalls).toEqual([['asking.answerPermission', hostPermission]])
    // A `legacy:` id the relay does not hold now is stale: not-open, and it reaches neither side.
    expect(
      await world.invoke(PERMISSION, {
        askId: 'legacy:toolu_gone',
        decision: 'allow',
        requestId: REQUEST
      })
    ).toEqual({ ok: true, value: { kind: 'not-open' } })
    expect(world.legacyServed).toHaveLength(2)
    expect(world.hostCalls).toHaveLength(1)
    world.dispose()
  })

  // ADDED for ISSUE-141 (verifier finding, 2026-10-14): the rollback build keeps this tree's preload and renderer, which
  // send A-40/A-41 in the 14 target shape; its table must still reach today's runtime with exactly those payloads.
  it("[ADR-001, US-ASK-003.AC07] in a cut-2 rollback build the renderer's own A-40/A-41 payloads reach today's runtime through LegacyAnswerShapeAdapter", async () => {
    const rolledBack = rollbackOf(cut2, 'cut-2')
    const world = await answerWorld(rolledBack.routes)
    const accepted = { ok: true, value: { kind: 'accepted' } }
    expect(
      await world.invoke(PERMISSION, {
        askId: 'legacy:toolu_1',
        decision: 'allow',
        requestId: REQUEST
      })
    ).toEqual(accepted)
    expect(
      await world.invoke(QUESTION, {
        askId: 'legacy:call_1',
        answers: [{ step: 0, option: 'develop' }],
        requestId: REQUEST
      })
    ).toEqual(accepted)
    expect(world.legacyServed).toEqual([
      [PERMISSION, { dwarfId: `claude:${SESSION}`, toolUseId: 'toolu_1', decision: 'allow' }],
      [
        QUESTION,
        {
          dwarfId: `codex:${THREAD}`,
          toolUseId: 'call_1',
          answers: { 'Which branch should I use?': 'develop' }
        }
      ]
    ])
    // Nothing reaches the Host: the rollback build routes no answer there.
    expect(world.hostCalls).toEqual([])
    world.dispose()
  })

  // ADDED for ISSUE-141 (verifier finding, 2026-10-14): wherever the table names `LegacyAnswerShapeAdapter` the root binds
  // it, even with no `LegacyAskRelay` composed, so the router never refuses to start (`router: no shape adapter`).
  it('[ADR-001] with no relay composed the router still starts over the cut-2 table and its rollback, and a legacy: answer is not-open', async () => {
    const client = { call: () => Promise.resolve({ kind: 'accepted' }) }
    for (const table of [cut2, rollbackOf(cut2, 'cut-2')]) {
      const answers = composeAskAnswers({
        routes: table.routes,
        release: 'cut-2',
        client: client as unknown as Parameters<typeof composeAskAnswers>[0]['client'],
        relay: undefined,
        log: { record: () => {} }
      })
      const reached: string[] = []
      const router = createRouter({
        routes: table.routes.filter((r) => r.channel === QUESTION || r.channel === PERMISSION),
        legacy: { serve: async (channel) => void reached.push(`legacy ${channel}`) },
        ...(answers?.part === undefined ? {} : { host: answers.part.target }),
        shapeAdapters: answers?.shapeAdapters ?? {},
        qualifiers: answers?.qualifiers ?? {},
        senders
      })
      // As `register` does: the root's qualifier of the payload picks the route.
      const payload = { askId: 'legacy:toolu_1', decision: 'allow', requestId: REQUEST }
      const qualifier = answers?.qualifiers[PERMISSION]?.(payload) ?? {}
      expect(
        await router.dispatch(PERMISSION, FROM_PANEL, payload, qualifier),
        table.release
      ).toEqual({ ok: true, value: { kind: 'not-open' } })
      expect(reached).toEqual([])
    }
  })

  it('[ADR-001] in cut 2 A-N07, A-N31 and A-N32 exist and route host', async () => {
    const born: ChannelKey[] = ['ask:step:set', 'claude:hooks:set', 'welcome:answer']
    for (const key of born) {
      expect(CHANNELS[key].status, key).toBe('new')
      expect(routeOf(key), key).toEqual([
        { channel: key, owner: 'host', since: 'cut-2', parity: 'passed', shape: 'target' }
      ])
    }
    // Only A-N33 is still unrouted (AMENDMENT-11): the cut-2 entries are routed by this switch (ISSUE-043 rule).
    // AMENDED for ISSUE-171 (was: A-N33 only): A-N29, born `host` in 3a, waits for the step-3a switch (ISSUE-001).
    // AMENDED for ISSUE-168: so does A-N06.
    expect(CUT_2_UNROUTED).toEqual({
      'host:connection:confirm-restart': 'generation-2',
      'dwarf:stop': 'cut-3a',
      'dwarf:message:retry': 'cut-3a',
      // AMENDED for ISSUE-174: A-N10 and A-N11, born `host` in 3a, wait for the same switch.
      'host:recovery:retry': 'cut-3a',
      'host:recovery:dismiss': 'cut-3a'
    })
    // The root composes their `host` handlers, each relaying its one seam-B member.
    const sent: Array<[string, unknown]> = []
    const replies: Record<string, unknown> = {
      'asking.setStep': {},
      'preferences.setClaudeHooks': { ok: true, value: { state: 'on-verified' } },
      'preferences.answerWelcome': {
        integrations: {
          'claude-hooks': { state: 'on-verified' },
          'opencode-permissions': { state: 'off' }
        },
        welcome: { due: false, legacyFound: [], offered: ['claude-hooks'] }
      }
    }
    const client = {
      call: (method: string, params: unknown) => {
        sent.push([method, params])
        return Promise.resolve(replies[method])
      }
    } as unknown as Parameters<typeof composeAskStepAndIntegrationRows>[0]['client']
    const rows = composeAskStepAndIntegrationRows({ routes: CUT_2_ROUTES, client })
    expect(rows?.channels).toEqual(born)
    const router = createRouter({
      routes: CUT_2_ROUTES.filter((r) => born.includes(r.channel)),
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(rows === undefined ? {} : { host: rows.target }),
      senders
    })
    const payloads: Record<string, unknown> = {
      'ask:step:set': { askId: HOST_ASK, step: 1 },
      'claude:hooks:set': { on: true, requestId: REQUEST },
      'welcome:answer': { claudeHooks: true, openCodePermissions: false, requestId: REQUEST }
    }
    for (const key of born) {
      const answer = await router.dispatch(key, FROM_PANEL, payloads[key])
      expect(CHANNELS[key].response.safeParse(answer).success, key).toBe(true)
      expect((answer as { ok: boolean }).ok, key).toBe(true)
    }
    expect(sent.map(([method]) => method)).toEqual([
      'asking.setStep',
      'preferences.setClaudeHooks',
      'preferences.answerWelcome'
    ])
    // Before the switch the root composes none of them (the cut-1 table leaves them unrouted).
    expect(composeAskStepAndIntegrationRows({ routes: CUT_1_ROUTES, client })).toBeUndefined()
  })

  // ADDED for ISSUE-172 (lead decision, 2026-10-17): A-N08 and A-N09 are NEW rows with no legacy owner; the renderer's
  // board is the Host's once its first snapshot is read (useMines, one writer), so every dwarf it can rename is a Host
  // dwarf and the rows are born `host` in cut 2 rather than waiting for the step-3a switch.
  it('[ADR-001, US-MSG-005.AC02, US-MSG-006.AC03] in cut 2 A-N08 and A-N09 exist and route host, relaying crew.rename and crew.resetName', async () => {
    const born: ChannelKey[] = ['dwarf:rename', 'dwarf:name:reset']
    for (const key of born) {
      expect(CHANNELS[key].status, key).toBe('new')
      expect(routeOf(key), key).toEqual([
        { channel: key, owner: 'host', since: 'cut-2', parity: 'passed', shape: 'target' }
      ])
    }
    expect(HOST_ROUTE_MEMBERS['dwarf:rename']).toEqual(['crew.rename'])
    expect(HOST_ROUTE_MEMBERS['dwarf:name:reset']).toEqual(['crew.resetName'])
    // The legacy rows of 14 §8 I-21 keep today's runtime for a board still fed by today's feed (a build that refuses
    // A-N01); their RETIRE is cut 5's.
    expect(routeOf('dwarf:setName')).toEqual([
      {
        channel: 'dwarf:setName',
        owner: 'legacy',
        since: 'pre-cut-0',
        parity: 'n/a',
        shape: 'today'
      }
    ])
    expect(routeOf('dwarf:resetName')).toEqual([
      {
        channel: 'dwarf:resetName',
        owner: 'legacy',
        since: 'pre-cut-0',
        parity: 'n/a',
        shape: 'today'
      }
    ])
    const sent: Array<[string, unknown]> = []
    const replies: Record<string, unknown> = {
      'crew.rename': { ok: true, value: { customName: 'Watcher of seals' } },
      'crew.resetName': {}
    }
    const client = {
      call: (method: string, params: unknown) => {
        sent.push([method, params])
        return Promise.resolve(replies[method])
      }
    } as unknown as Parameters<typeof composeDwarfNameRows>[0]['client']
    const rows = composeDwarfNameRows({ routes: CUT_2_ROUTES, client })
    expect(rows?.channels).toEqual(born)
    const router = createRouter({
      routes: CUT_2_ROUTES.filter((r) => born.includes(r.channel)),
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(rows === undefined ? {} : { host: rows.target }),
      senders
    })
    const DWARF = '01920000-0000-7000-a000-000000000172'
    expect(
      await router.dispatch('dwarf:rename', FROM_PANEL, {
        dwarfId: DWARF,
        name: 'Watcher of seals',
        requestId: REQUEST
      })
    ).toEqual({ ok: true, value: { ok: true, value: { customName: 'Watcher of seals' } } })
    expect(
      await router.dispatch('dwarf:name:reset', FROM_PANEL, { dwarfId: DWARF, requestId: REQUEST })
    ).toEqual({ ok: true, value: undefined })
    expect(sent).toEqual([
      ['crew.rename', { dwarfId: DWARF, name: 'Watcher of seals', requestId: REQUEST }],
      ['crew.resetName', { dwarfId: DWARF, requestId: REQUEST }]
    ])
    // A table that leaves them unrouted (the cut-1 table) composes neither.
    expect(composeDwarfNameRows({ routes: CUT_1_ROUTES, client })).toBeUndefined()
  })

  it('[ADR-001] in cut 2 every host route uses only seam-B members born by cut 2 and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of CUT_2_ROUTES.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at('cut-2')
        )
      }
    }
    // 21 §2 "Seam B members: the cut in which each is born", row 2: B-M30…B-M32, B-M39, B-M40.
    // AMENDED for ISSUE-172 (lead decision, 2026-10-17): B-M22 and B-M23 join them, served from cut 2 for A-N08 / A-N09.
    expect(
      Object.fromEntries(Object.entries(SEAM_B_METHODS_BORN).filter(([, step]) => step === 'cut-2'))
    ).toEqual({
      'asking.answerQuestion': 'cut-2', // B-M30
      'asking.answerPermission': 'cut-2', // B-M31
      'asking.setStep': 'cut-2', // B-M32
      'preferences.setClaudeHooks': 'cut-2', // B-M39
      'preferences.answerWelcome': 'cut-2', // B-M40
      'crew.rename': 'cut-2', // B-M22
      'crew.resetName': 'cut-2' // B-M23
    })
    expect(
      Object.fromEntries(
        Object.entries(CUT_2_HOST_ROUTE_MEMBERS).filter(
          ([key]) => !(key in CUT_1_HOST_ROUTE_MEMBERS)
        )
      )
    ).toEqual({
      'agent:answerQuestion': ['asking.answerQuestion'], // A-40 → B-M30
      'agent:answerPermission': ['asking.answerPermission'], // A-41 → B-M31
      'ask:step:set': ['asking.setStep'], // A-N07 → B-M32
      'claude:hooks:set': ['preferences.setClaudeHooks'], // A-N31 → B-M39
      'welcome:answer': ['preferences.answerWelcome'], // A-N32 → B-M40
      // AMENDED for ISSUE-172 (lead decision, 2026-10-17): A-N08 and A-N09 are born `host` in cut 2.
      'dwarf:rename': ['crew.rename'], // A-N08 → B-M22
      'dwarf:name:reset': ['crew.resetName'] // A-N09 → B-M23
    })
  })

  it('[ADR-016] with A-40 and A-41 flipped back to their cut-1 routes the build withdraws the rows that write the Claude hook entry, and the router refuses them', async () => {
    // AMENDED for ISSUE-142 (was: "…the legacy hook installer and the Claude hook route are composed again, and never
    // while the Host writes the Claude hook entry"): after the cut-2 retirement today's Claude hook half is composed in
    // no table, the rollback one included ("cut-2 retirement" below), so this case keeps the rollback rows only.
    // AMENDED for ISSUE-141 (verifier finding, 2026-10-14; was: `legacy` with today's shape, `legacyToday(key)`): the
    // folded row keeps the renderer's target shape through `LegacyAnswerShapeAdapter`, or no answer would be delivered.
    // TC-141-06 (21 §2 cut 2 row "Rollback"; §2.1 item 1; §1 items 4, 8): the rollback build of cut 2 routes A-40 and
    // A-41 `legacy` again, one unqualified row each (the qualified rows fold back into it), so today's Claude
    // hook composition comes back; the cut's NEW rows that turn the Host's Claude hook entry on (A-N31, A-N32) are
    // withdrawn in that build (hidden until built), so the Host never writes that entry while today's installer does.
    const rolledBack = rollbackOf(cut2, 'cut-2')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    for (const key of [QUESTION, PERMISSION]) {
      expect(
        rolledBack.routes.filter((r) => r.channel === key),
        key
      ).toEqual([
        {
          channel: key,
          owner: 'legacy',
          since: 'cut-2',
          parity: 'n/a',
          shape: 'target',
          shapeAdapter: 'LegacyAnswerShapeAdapter'
        }
      ])
    }
    expect(rolledBack.withdrawn).toEqual({ 'claude:hooks:set': 'cut-2', 'welcome:answer': 'cut-2' })
    expect(rolledBack.routes.filter((r) => r.channel === 'ask:step:set')).toEqual(
      routeOf('ask:step:set')
    )
    /** Whether a table's `host` routes reach a seam-B member that writes the Claude hook entry (21 §4). */
    const hostWritesClaudeEntry = (table: RouteTable): boolean =>
      table.routes.some(
        (r) =>
          r.owner === 'host' &&
          (HOST_ROUTE_MEMBERS[r.channel] ?? []).some((member) =>
            ['preferences.setClaudeHooks', 'preferences.answerWelcome'].includes(member)
          )
      )
    expect(hostWritesClaudeEntry(rolledBack)).toBe(false)
    expect(hostWritesClaudeEntry(cut2)).toBe(true)
    // The rollback build's router refuses the withdrawn rows like a row with no route. (AMENDED for ISSUE-141: its
    // A-40/A-41 rows name `LegacyAnswerShapeAdapter`, so the router is handed one, as the root binds it.)
    const reached: string[] = []
    const router = createRouter({
      routes: rolledBack.routes,
      legacy: { serve: async (channel) => void reached.push(`legacy ${channel}`) },
      uiLocal: { serve: async (channel) => void reached.push(`ui-local ${channel}`) },
      host: { serve: async (channel) => void reached.push(`host ${channel}`) },
      shapeAdapters: {
        ResetFanout: { serve: async () => undefined },
        LegacyAnswerShapeAdapter: { serve: async () => undefined }
      },
      senders
    })
    expect(
      await router.dispatch('claude:hooks:set', FROM_PANEL, { on: true, requestId: REQUEST })
    ).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_FOUND' } })
    expect(reached).toEqual([])
  })

  // ADDED for ISSUE-141 (lead decision 2026-10-14): the Host side of the same rollback. With A-N32 withdrawn the
  // first-run step could not be answered, so the Host must not offer it, and the Host must write no Claude hook entry;
  // its setting (`CUT_2_ROLLBACK`, read by host/wiring/cut2Rollback.ts) is pinned to the build's table here, as
  // `CUT_1_ROLLBACK` is, so the route rows and the Host setting cannot disagree in one build.
  it('[ADR-016, US-SET-012.AC08] the cut-2 rollback setting is on if and only if the build withdrew the rows that write the Claude hook entry', () => {
    /** Whether a cut-2 table is a rollback build's: A-N31 and A-N32 withdrawn, A-40 and A-41 legacy again. */
    const cut2RolledBack = (table: RouteTable): boolean =>
      table.release === 'cut-2' &&
      table.withdrawn?.['claude:hooks:set'] === 'cut-2' &&
      table.withdrawn?.['welcome:answer'] === 'cut-2'
    // This build's setting against this build's table (false in every normal build).
    expect(CUT_2_ROLLBACK).toBe(cut2RolledBack(cut2))
    expect(cut2RolledBack(cut2)).toBe(false)
    expect(cut2RolledBack(rollbackOf(cut2, 'cut-2'))).toBe(true)
  })
})

describe('cut-2 retirement (21 §2 cut 2)', () => {
  // ISSUE-142 (21 §2 cut 2 "Retired at the end"; 21 §1 items 3, 4, 7; §4 row "Claude hook entry"): after the cut-2 soak
  // (OQ-71) today's Claude ask composition leaves LegacyRuntimeRoute whatever the route table, so a table that routes
  // A-40 and A-41 `legacy` again composes none of it either: from here cut 2 rolls forward only. The Host's evaluated
  // copies in `asking` and its ingress are the only path; the shared loopback listener stays for the OpenCode plugin
  // route until 4a. The legacy files leave with the legacy tree in cut 5 (src/legacy-bridge/retiredClaudeAsks.test.ts).
  // The cut-2 table as it shipped (the release table has moved on since ISSUE-001).
  const cut2: RouteTable = {
    release: 'cut-2',
    routes: CUT_2_ROUTES,
    unrouted: CUT_2_UNROUTED,
    retired: CUT_2_RETIRED,
    adapters: ADAPTERS_AS_SHIPPED
  }
  const SRC = resolve(import.meta.dirname, '../..')
  const read = (relative: string): string => readFileSync(resolve(SRC, relative), 'utf8')

  it('[ADR-012] after the cut-2 retirement no legacy Claude hook installer, hook route, prompt registry or keystroke path is composed, whatever the route table', () => {
    for (const table of [cut2, rollbackOf(cut2, 'cut-2')]) {
      expect(checkRouteTable(table, KEYS)).toEqual([])
    }
    const route = read('legacy-bridge/LegacyRuntimeRoute.ts')
    // No hook installer: today's `HookChannel` (installer and restore) is neither imported nor built.
    expect(route).not.toMatch(/\bHookChannel\b|main\/hooks\/(hookChannel|hookInstaller)'/)
    // No Claude hook route and no prompt registry: nothing hands a Claude hook event to today's runtime.
    expect(route).not.toMatch(/noteHookEvent|main\/hooks\/permissionPrompts'/)
    // No keystroke path: today's permission keystrokes are not composed.
    expect(route).not.toMatch(/main\/textDelivery\/permissionKeys'|permissionKeystroke/)
    // Whatever the route table: the root derives nothing of today's Claude hook half from it any more.
    expect(route).not.toMatch(/options\.claudeHooks|legacyClaudeHookComposition/)
    expect(read('ui-main/index.ts')).not.toMatch(/legacyClaudeHooks(Composed|Composition)\b/)
  })

  it('[ADR-016] after the cut-2 retirement the legacy loopback listener serves only the OpenCode plugin route', () => {
    const route = read('legacy-bridge/LegacyRuntimeRoute.ts')
    // One listener, whose Claude sink reaches nothing: only today's hook channel (the installer's) opened its Claude route.
    expect(route.match(/new HookListener\(/g)).toHaveLength(1)
    expect(route).toMatch(/new HookListener\(\{[^}]*onEvent: \(\) => \{\},\s*onOpenCodePush,/s)
    // The OpenCode plugin channel still opens its own route on that listener (until 4a).
    expect(route).toMatch(/new OpenCodePluginChannel\(\{[^}]*listener: hookListener/s)
    // AMENDED for ISSUE-236 (was: `openCodePluginError = (await openCodePlugin.restore())?.error`): the error fed only
    // today's A-52/A-53 handlers, which the 4a retirement deleted.
    expect(route).toMatch(/await openCodePlugin\.restore\(\)/)
  })
})

/** Today's registry write, as `LegacyAskRelay`'s composition is handed it. */
type LegacyRegistryReplace = LegacyAskRelayComposition['registry']['registry']['replace']

// ADDED for ISSUE-001: the step-3a switch (21 §2 cut 3a; 14 §5; 21 §1 items 1, 2, 2a, 3). The release table moves
// Claude's launch, send, console and stop rows to the Host (provider-qualified), A-25 and the Jev rows to the Host for
// every provider, retires A-26, A-37 and A-38, and serves every provider not yet moved through the shape adapters of
// 21 §3.1. Each case drives the release table (`ROUTES`) through the root's own compositions.
// AMENDED for ISSUE-002 (was: the release table `ROUTES` / `ROUTES_RELEASE`): from the step-3b switch the 3a table as it
// shipped is `testing/cut3aRoutes.ts`, as ISSUE-001 did for cut 2; `describe('release 3b')` pins the release table.
describe('release 3a (21 §2 cut 3a)', () => {
  const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
  /** The providers whose launcher has not moved to the Host by 3a (21 §2 cut 3 rows 3b…4b). */
  const NOT_MOVED = [CODEX, ANTIGRAVITY, OPENCODE]
  const cut3a: RouteTable = {
    release: CUT_3A_RELEASE,
    routes: CUT_3A_ROUTES,
    unrouted: UNROUTED,
    retired: CUT_4A_RETIRED,
    adapters: ADAPTERS_AS_SHIPPED
  }
  const routeOf = (key: ChannelKey): ChannelRoute[] =>
    CUT_3A_ROUTES.filter((r) => r.channel === key)
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const MINE = '01920000-0000-7000-8000-000000000301'
  const REQUEST = '01920000-0000-7000-a000-000000000301'
  const MINTED = '01920000-0000-7000-8000-0000000003a1'
  const MESSAGE = '01920000-0000-7000-8000-0000000003b1'
  const LAUNCH = '01920000-0000-7000-8000-0000000003c1'
  const CLAUDE_DWARF = '01920000-0000-7000-9000-000000000311'
  const CODEX_DWARF = '01920000-0000-7000-9000-000000000312'
  const PER_PROVIDER = 'PerProviderShapeAdapter'
  const CATALOG_MERGE = 'CatalogMergeAdapter'
  const ACTIVATE: ChannelKey = 'dwarf:activate' // A-13
  const SEND: ChannelKey = 'dwarf:sendText' // A-23
  const DESCRIBE: ChannelKey = 'dwarf:attachments:describe' // A-25
  const LAUNCH_ROW: ChannelKey = 'agent:launch' // A-35
  const PROVIDERS: ChannelKey = 'agent:providers' // A-36
  const STOP: ChannelKey = 'dwarf:stop' // A-N29
  const RETRY: ChannelKey = 'dwarf:message:retry' // A-N06
  const RECOVERY_RETRY: ChannelKey = 'host:recovery:retry' // A-N10
  const RECOVERY_DISMISS: ChannelKey = 'host:recovery:dismiss' // A-N11
  const PROVIDER_ROWS: ChannelKey[] = [LAUNCH_ROW, PROVIDERS, SEND, ACTIVATE]

  const hostFor = (channel: ChannelKey, provider: string): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-3a',
    parity: 'passed',
    qualifier: { provider },
    shape: 'target'
  })
  const hostAll = (channel: ChannelKey): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-3a',
    parity: 'passed',
    shape: 'target'
  })
  const legacyThrough = (channel: ChannelKey, adapter: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: adapter
  })
  const legacyFor = (channel: ChannelKey, provider: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    qualifier: { provider },
    shape: 'today'
  })

  /** A present Host dwarf of `providerId` (14 §3.6 `DwarfWire`), observed. */
  const dwarfWire = (id: string, providerId: string) => ({
    id,
    mineId: MINE,
    providerId,
    baseName: 'Thorin',
    customName: null,
    rank: 'foreman',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId },
    presence: 'present',
    processState: 'running',
    status: 'working',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: false,
    arrivedAt: 1_700_000_000_500
  })

  const HOST_CLAUDE = {
    providerId: CLAUDE,
    label: 'Claude Code',
    models: [{ value: 'opus', efforts: ['high'] }],
    permissionModes: ['default'],
    offeredModes: ['default'],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available'
  }

  /** The Host's answer to each method the 3a rows relay. */
  const HOST_REPLIES: Record<string, unknown> = {
    'launching.launch': { launchId: LAUNCH },
    'conversation.send': { ok: true, value: { messageId: MESSAGE } },
    'conversation.retry': { ok: true, value: {} },
    'conversation.describeAttachments': [],
    'conversation.resolveConsole': {
      mode: 'log',
      command: { program: 'tail', args: [], cwd: '/w' }
    },
    'suppliers.launchable': [HOST_CLAUDE],
    'crew.stop': { ok: true, value: {} },
    'crew.rename': { ok: true, value: { customName: 'Watcher of seals' } },
    'crew.resetName': {},
    'launching.retryRecovery': { ok: false, error: 'no-report' },
    'launching.dismissRecovery': { ok: false, error: 'no-report' },
    'jev.suggest': { ok: false, error: 'not-configured' },
    'strangler.dwarfIdentities': []
  }

  /**
   * The 3a rows as the root composes them over the release table: the Host's handlers over a recording HostClient
   * whose board holds one Claude and one Codex dwarf, the shape adapters over a recording today's runtime, the
   * provider qualifiers, and the router registered on an `ipcMain` stand-in, so `invoke` is the renderer's call.
   */
  function step3aWorld(table: readonly ChannelRoute[] = CUT_3A_ROUTES) {
    const hostCalls: Array<[string, unknown]> = []
    const legacyServed: Array<[string, unknown]> = []
    const raised: unknown[] = []
    const client = {
      call: (method: string, params: unknown) => {
        if (method !== 'strangler.dwarfIdentities') hostCalls.push([method, params])
        return Promise.resolve(HOST_REPLIES[method])
      },
      subscribe: (handler: (event: HostEvent) => void) => {
        handler({
          kind: 'snapshot',
          snapshot: {
            seq: 1,
            chunks: [
              {
                section: 'dwarfs',
                data: [dwarfWire(CLAUDE_DWARF, CLAUDE), dwarfWire(CODEX_DWARF, CODEX)]
              }
            ]
          } as unknown as SnapshotPage
        })
        return () => {}
      }
    }
    const today: Record<string, unknown> = {
      'agent:launch': { launched: true, provider: CODEX, launchId: 'receipt:1' },
      'agent:providers': {
        providers: [
          { provider: CLAUDE, installed: true, launchable: true },
          { provider: CODEX, installed: true, launchable: true }
        ]
      },
      'dwarf:sendText': { delivered: true, via: 'terminal' },
      'dwarf:activate': { focused: true, openedTerminal: false }
    }
    const legacy = {
      serve: (channel: string, payload: unknown) => {
        legacyServed.push([channel, payload])
        return Promise.resolve(today[channel])
      }
    }
    const typedClient = client as unknown as Parameters<
      typeof composeConversationAndLaunchRows
    >[0]['client']
    const rows = composeConversationAndLaunchRows({
      routes: table,
      client: typedClient,
      consoles: {
        raiseConsole: (target) => {
          raised.push(target)
          return Promise.resolve('raised')
        }
      }
    })
    const stop = composeStopDwarf({
      routes: table,
      release: CUT_3A_RELEASE,
      client: client as unknown as Parameters<typeof composeStopDwarf>[0]['client'],
      legacy: {
        liveLaunches: () => Promise.resolve([]),
        endLaunch: () => Promise.resolve('ended'),
        launchIdOfDwarf: () => undefined
      },
      bridge: { toLegacy: () => Promise.resolve(null) }
    })
    const routing = composeProviderRouting({
      routes: table,
      client: client as unknown as Parameters<typeof composeProviderRouting>[0]['client']
    })
    const adapters = composeProviderShapeAdapters({
      routes: table,
      release: CUT_3A_RELEASE,
      legacy,
      models: { read: () => Promise.resolve({ catalogs: [] }) },
      client: typedClient,
      mintId: () => MINTED
    })
    const parts = [rows, stop?.part].filter(
      (part): part is NonNullable<typeof part> => part !== undefined
    )
    const handlers = new Map<string, (event: typeof FROM_PANEL, payload: unknown) => unknown>()
    // The rows under test: every route but those through a shape adapter of another family (A-33, A-40, A-41, A-47).
    const underTest = table.filter(
      (r) => r.shapeAdapter === undefined || [PER_PROVIDER, CATALOG_MERGE].includes(r.shapeAdapter)
    )
    createRouter({
      routes: underTest,
      legacy,
      host: composeRouteTargets(parts),
      uiLocal: { serve: () => Promise.reject(new Error('no ui-local row under test')) },
      ...(adapters === undefined ? {} : { shapeAdapters: adapters }),
      qualifiers: routing.qualifiers,
      senders
    }).register({
      handle: (wire, listener) => void handlers.set(wire, listener),
      on: (wire, listener) => void handlers.set(wire, listener)
    })
    const invoke = (wire: string, payload: unknown) => {
      const listener = handlers.get(wire)
      if (listener === undefined) throw new Error(`no listener for ${wire}`)
      return listener(FROM_PANEL, payload)
    }
    const dispose = () => {
      stop?.dispose()
      routing.dispose()
    }
    return { rows, stop, routing, adapters, invoke, hostCalls, legacyServed, raised, dispose }
  }

  const launchParams = (providerId: string) => ({
    mineId: MINE,
    way: { kind: 'supplier', providerId },
    prompt: 'Map the build',
    jevOn: false,
    jevAutoAccept: false,
    requestId: REQUEST
  })
  const sendParams = (dwarfId: string) => ({
    dwarfId,
    text: 'go on',
    attachments: [],
    requestId: REQUEST
  })

  it('[ADR-001] in 3a A-35, A-36, A-23, A-13 and A-N29 route host with shape target for the Claude qualifier', async () => {
    expect(CUT_3A_RELEASE).toBe('cut-3a')
    expect(checkRouteTable(cut3a, KEYS)).toEqual([])
    for (const key of PROVIDER_ROWS) {
      // One owner per (channel, qualifier) (21 §1 item 2): the Host for Claude (21 §2 cut 3a).
      expect(routeOf(key), key).toContainEqual(hostFor(key, CLAUDE))
      expect(resolveRoute(CUT_3A_ROUTES, key, { provider: CLAUDE }), key).toEqual(
        hostFor(key, CLAUDE)
      )
    }
    // A-N29 is born `host` for every dwarf (a legacy-launched one is ended first, 21 §3 `LegacyEndFirstAdapter`).
    expect(routeOf(STOP)).toEqual([hostAll(STOP)])
    expect(resolveRoute(CUT_3A_ROUTES, STOP, { provider: CLAUDE })?.owner).toBe('host')

    // Through the root's composition: the qualifier is the provider of the call's way or of its dwarf on the Host
    // board, and Claude's calls reach the Host with the renderer's payload unchanged.
    const world = step3aWorld()
    expect(world.rows?.channels).toEqual(
      expect.arrayContaining([LAUNCH_ROW, SEND, ACTIVATE, DESCRIBE, RETRY])
    )
    expect(Object.keys(world.routing.qualifiers).sort()).toEqual([LAUNCH_ROW, ACTIVATE, SEND])
    expect(await world.invoke(LAUNCH_ROW, launchParams(CLAUDE))).toEqual({
      ok: true,
      value: { launchId: LAUNCH }
    })
    expect(await world.invoke(SEND, sendParams(CLAUDE_DWARF))).toEqual({
      ok: true,
      value: { ok: true, value: { messageId: MESSAGE } }
    })
    expect(
      await world.invoke(ACTIVATE, { dwarfId: CLAUDE_DWARF, purpose: 'open-console' })
    ).toEqual({ ok: true, value: { outcome: 'opened', mode: 'log' } })
    expect(await world.invoke(STOP, { dwarfId: CLAUDE_DWARF, requestId: REQUEST })).toEqual({
      ok: true,
      value: { ok: true, value: {} }
    })
    expect(world.hostCalls.map(([method]) => method)).toEqual([
      'launching.launch',
      'conversation.send',
      'conversation.resolveConsole',
      'crew.stop'
    ])
    expect(world.hostCalls[0]?.[1]).toEqual(launchParams(CLAUDE))
    expect(world.legacyServed).toEqual([])
    world.dispose()
  })

  it('[ADR-001] in 3a every other provider reaches A-13, A-23, A-35 through PerProviderShapeAdapter and A-36 through CatalogMergeAdapter, with shape target', async () => {
    for (const key of [ACTIVATE, SEND, LAUNCH_ROW]) {
      expect(routeOf(key), key).toEqual([hostFor(key, CLAUDE), legacyThrough(key, PER_PROVIDER)])
      for (const provider of NOT_MOVED) {
        expect(resolveRoute(CUT_3A_ROUTES, key, { provider }), `${key} ${provider}`).toEqual(
          legacyThrough(key, PER_PROVIDER)
        )
      }
    }
    // Catalog merge (21 §3.1): the renderer's A-36 call carries no qualifier, so the merge answers it, with the
    // Claude entry from the Host (its `host` route names the moved provider) and the others from today's catalog.
    expect(routeOf(PROVIDERS)).toEqual([
      hostFor(PROVIDERS, CLAUDE),
      legacyThrough(PROVIDERS, CATALOG_MERGE)
    ])
    expect(resolveRoute(CUT_3A_ROUTES, PROVIDERS)).toEqual(legacyThrough(PROVIDERS, CATALOG_MERGE))

    const world = step3aWorld()
    expect(Object.keys(world.adapters ?? {}).sort()).toEqual([CATALOG_MERGE, PER_PROVIDER])
    const catalog = (await world.invoke(PROVIDERS, {})) as {
      ok: boolean
      value: Array<{ providerId: string }>
    }
    expect(catalog.ok).toBe(true)
    expect(catalog.value.map((entry) => entry.providerId)).toEqual([CLAUDE, CODEX])
    expect(catalog.value[0]).toEqual(HOST_CLAUDE)
    // A Codex launch in the target shape reaches today's launch and answers a minted LaunchId.
    expect(await world.invoke(LAUNCH_ROW, launchParams(CODEX))).toEqual({
      ok: true,
      value: { launchId: MINTED }
    })
    // A Codex dwarf's message reaches today's send, never the Host's.
    const sent = (await world.invoke(SEND, sendParams(CODEX_DWARF))) as { ok: boolean }
    expect(sent.ok).toBe(true)
    expect(world.legacyServed.map(([channel]) => channel)).toEqual([
      'agent:providers',
      'agent:launch',
      'dwarf:sendText'
    ])
    expect(world.hostCalls.map(([method]) => method)).toEqual(['suppliers.launchable'])
    world.dispose()
  })

  it('[ADR-001] in 3a the settlement of a launch or a send of a provider not yet moved names the id the renderer was answered', async () => {
    // 21 §3.1 `PerProviderShapeAdapter`: its settlement stays on A-P3/A-P4 until 4b; the root shares one join between
    // the adapter and the push tap (legacySettlementJoin.ts), so A-P3 leaves with the minted LaunchId.
    const join = composeSettlementJoin({ routes: CUT_3A_ROUTES, release: CUT_3A_RELEASE })
    expect(join).toBeDefined()
    expect(composeSettlementJoin({ routes: CUT_2_ROUTES, release: 'cut-2' })).toBeUndefined()
    const legacy = {
      serve: (channel: string) =>
        Promise.resolve(
          channel === 'agent:launch'
            ? { launched: true, provider: CODEX, launchId: 'receipt:7' }
            : undefined
        )
    }
    const adapters = composeProviderShapeAdapters({
      routes: CUT_3A_ROUTES,
      release: CUT_3A_RELEASE,
      legacy,
      models: { read: () => Promise.resolve({ catalogs: [] }) },
      client: undefined,
      mintId: () => MINTED,
      settlements: join
    })
    expect(
      await adapters?.[PER_PROVIDER]?.serve(LAUNCH_ROW, launchParams(CODEX), undefined)
    ).toEqual({ ok: true, value: { launchId: MINTED } })
    let installed: { push(channel: string, payload: unknown): Promise<unknown> } | undefined
    const tap = {
      send: () => {},
      install: (map: NonNullable<typeof installed>) => {
        installed = map
        return () => {}
      }
    } as unknown as Parameters<typeof composeLegacyDwarfIdBridge>[0]['pushes']
    const dwarfIds = composeLegacyDwarfIdBridge({
      release: CUT_3A_RELEASE,
      client: {
        call: () => Promise.resolve([]),
        subscribe: () => () => {}
      } as unknown as Parameters<typeof composeLegacyDwarfIdBridge>[0]['client'],
      legacy,
      registry: {
        pollIntervalMs: 2_000,
        discovery: [],
        registry: { replace: () => {} },
        board: { publish: () => {} },
        ledger: { credit: () => {} },
        projects: { record: () => {} },
        notifier: { update: () => {} }
      },
      pushes: tap,
      settlements: join
    })
    expect(
      await installed?.push('agent:launchFailed', { launchId: 'receipt:7', cause: 'not-installed' })
    ).toEqual({ launchId: MINTED, cause: 'not-installed' })
    // Settled once: a second push naming the same receipt leaves as today's runtime sent it.
    expect(
      await installed?.push('agent:launchFailed', { launchId: 'receipt:7', cause: 'not-installed' })
    ).toEqual({ launchId: 'receipt:7', cause: 'not-installed' })
    dwarfIds?.dispose()
  })

  it('[ADR-001] in 3a A-25, A-50, A-48 and A-49 route host for every provider and A-47 goes through JevSettingsShapeAdapter', async () => {
    for (const key of [DESCRIBE, 'jev:route', 'jev:apiKey:set', 'jev:apiKey:clear'] as const) {
      expect(routeOf(key), key).toEqual([hostAll(key)])
    }
    expect(routeOf('jev:settings:get')).toEqual([
      legacyThrough('jev:settings:get', 'JevSettingsShapeAdapter')
    ])
    // The root composes the A-48/A-49 handlers with the one-time key migration, A-47's adapter and A-50's relay.
    const client = {
      call: (method: string) => Promise.resolve(HOST_REPLIES[method])
    }
    // AMENDED for ISSUE-236 (was: also A-47's `JevSettingsShapeAdapter` composed over today's runtime): the adapter
    // left the tree with the 4a retirement.
    const jev = composeJevKeyRows({
      routes: CUT_3A_ROUTES,
      release: CUT_3A_RELEASE,
      client: client as unknown as Parameters<typeof composeJevKeyRows>[0]['client'],
      migration: undefined,
      log: { record: () => {} },
      mintId: () => MINTED
    })
    expect(jev?.part?.channels).toEqual(['jev:apiKey:set', 'jev:apiKey:clear'])
    expect(
      composeJevRouteRow({
        routes: CUT_3A_ROUTES,
        client: client as unknown as Parameters<typeof composeJevRouteRow>[0]['client']
      })?.channels
    ).toEqual(['jev:route'])
    // A-25 relays B-M28 for any dwarf: the Host re-validates every path (21 §2 cut 3 common rules).
    const world = step3aWorld()
    expect(await world.invoke(DESCRIBE, ['/w/notes.md'])).toEqual([])
    expect(world.hostCalls).toEqual([
      ['conversation.describeAttachments', { paths: ['/w/notes.md'] }]
    ])
    expect(world.legacyServed).toEqual([])
    world.dispose()
  })

  it('[ADR-001] in 3a A-37, A-38 and A-26 have no route and no handler', async () => {
    const retired: ChannelKey[] = ['agent:models', 'agent:launchHeld', 'dwarf:kick']
    const world = step3aWorld()
    for (const key of retired) {
      expect(CHANNELS[key].status, key).toBe('retired')
      expect(RETIRED[key], key).toBe('cut-3a')
      expect(routeOf(key), key).toEqual([])
      expect(await world.invoke(key, undefined), key).toMatchObject({
        ok: false,
        error: { code: 'METHOD_NOT_FOUND' }
      })
    }
    expect(world.legacyServed).toEqual([])
    expect(world.hostCalls).toEqual([])
    world.dispose()
  })

  it('[ADR-001] in 3a A-N06, A-N08, A-N09, A-N10, A-N11 and A-N29 exist and route host', async () => {
    const born: ChannelKey[] = [RETRY, RECOVERY_RETRY, RECOVERY_DISMISS, STOP]
    for (const key of born) {
      expect(CHANNELS[key].status, key).toBe('new')
      expect(routeOf(key), key).toEqual([hostAll(key)])
    }
    // A-N08 and A-N09 were born `host` in cut 2 (ISSUE-172 lead decision) and keep their route.
    for (const key of ['dwarf:rename', 'dwarf:name:reset'] as const) {
      expect(routeOf(key), key).toEqual([
        { channel: key, owner: 'host', since: 'cut-2', parity: 'passed', shape: 'target' }
      ])
    }
    // Only A-N33 is still unrouted (AMENDMENT-11): every entry of 3a is routed by this switch (ISSUE-043 rule).
    expect(UNROUTED).toEqual({ 'host:connection:confirm-restart': 'generation-2' })
    const world = step3aWorld()
    expect(await world.invoke(RETRY, { messageId: MESSAGE, requestId: REQUEST })).toEqual({
      ok: true,
      value: { ok: true, value: {} }
    })
    for (const key of [RECOVERY_RETRY, RECOVERY_DISMISS]) {
      expect(await world.invoke(key, { hostEpoch: 'epoch-1', requestId: REQUEST }), key).toEqual({
        ok: true,
        value: { ok: false, error: 'no-report' }
      })
    }
    expect(world.hostCalls.map(([method]) => method)).toEqual([
      'conversation.retry',
      'launching.retryRecovery',
      'launching.dismissRecovery'
    ])
    world.dispose()
  })

  it('[ADR-001] in 3a A-27, A-P3 and A-P4 route legacy only for providers not yet moved', () => {
    for (const key of ['dwarf:retire', 'agent:launchFailed', 'dwarf:sendText:settled'] as const) {
      expect(routeOf(key), key).toEqual(NOT_MOVED.map((provider) => legacyFor(key, provider)))
      expect(resolveRoute(CUT_3A_ROUTES, key, { provider: CLAUDE }), key).toBeUndefined()
      for (const provider of NOT_MOVED) {
        expect(resolveRoute(CUT_3A_ROUTES, key, { provider })?.owner, `${key} ${provider}`).toBe(
          'legacy'
        )
      }
    }
  })

  it('[ADR-001] in 3a every host route uses only seam-B members born by 3a and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of CUT_3A_ROUTES.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at(CUT_3A_RELEASE)
        )
      }
    }
    // 21 §2 "Seam B members: the cut in which each is born", row 3a (B-M22 and B-M23 at cut 2, ISSUE-172).
    expect(
      Object.fromEntries(
        Object.entries(SEAM_B_METHODS_BORN).filter(([, step]) => step === 'cut-3a')
      )
    ).toEqual({
      'settings.secret.set': 'cut-3a', // B-M10
      'settings.secret.clear': 'cut-3a', // B-M11
      'crew.stop': 'cut-3a', // B-M21
      'conversation.send': 'cut-3a', // B-M24
      'conversation.retry': 'cut-3a', // B-M25
      'conversation.describeAttachments': 'cut-3a', // B-M28
      'conversation.resolveConsole': 'cut-3a', // B-M29
      'launching.launch': 'cut-3a', // B-M33
      'launching.retryRecovery': 'cut-3a', // B-M35
      'launching.dismissRecovery': 'cut-3a', // B-M36
      'suppliers.launchable': 'cut-3a', // B-M37
      'jev.suggest': 'cut-3a' // B-M38
    })
    // AMENDED for ISSUE-186 (was: every release member not in cut 2's): only the rows the 3a table routes `host`, since
    // the step-3d switch adds A-39's member to the release map.
    const hostIn3a = (key: string) =>
      CUT_3A_ROUTES.some((route) => route.channel === key && route.owner === 'host')
    expect(
      Object.fromEntries(
        Object.entries(HOST_ROUTE_MEMBERS).filter(
          ([key]) => !(key in CUT_2_HOST_ROUTE_MEMBERS) && hostIn3a(key)
        )
      )
    ).toEqual({
      'dwarf:activate': ['conversation.resolveConsole'], // A-13 → B-M29, Claude
      'dwarf:sendText': ['conversation.send'], // A-23 → B-M24, Claude
      'dwarf:attachments:describe': ['conversation.describeAttachments'], // A-25 → B-M28
      'agent:launch': ['launching.launch'], // A-35 → B-M33, Claude
      'agent:providers': ['suppliers.launchable'], // A-36 → B-M37, Claude (and the catalog merge)
      'jev:apiKey:set': ['settings.secret.set', 'preferences.get'], // A-48 → B-M10, B-M12
      'jev:apiKey:clear': ['settings.secret.clear', 'preferences.get'], // A-49 → B-M11, B-M12
      'jev:route': ['jev.suggest'], // A-50 → B-M38
      'dwarf:stop': ['crew.stop'], // A-N29 → B-M21
      'dwarf:message:retry': ['conversation.retry'], // A-N06 → B-M25
      'host:recovery:retry': ['launching.retryRecovery'], // A-N10 → B-M35
      'host:recovery:dismiss': ['launching.dismissRecovery'] // A-N11 → B-M36
    })
  })

  it('[ADR-001] in 3a A-N29 and A-N26 compose LegacyEndFirstAdapter for legacy-launched sessions', async () => {
    // A-N29 (21 §2 cut 3 common rules; §3 `LegacyEndFirstAdapter`): a dwarf today's runtime launched is ended by
    // today's identity-checked kill before `crew.stop` is relayed; any other dwarf is relayed at once.
    const events: string[] = []
    const client = {
      call: (method: string, params: unknown) => {
        events.push(`${method} ${(params as { dwarfId?: string }).dwarfId ?? ''}`.trim())
        return Promise.resolve({ ok: true, value: {} })
      },
      subscribe: () => () => {}
    }
    const stop = composeStopDwarf({
      routes: CUT_3A_ROUTES,
      release: CUT_3A_RELEASE,
      client: client as unknown as Parameters<typeof composeStopDwarf>[0]['client'],
      legacy: {
        liveLaunches: () => Promise.resolve([{ launchId: 'launch-1' }]),
        endLaunch: (launchId) => {
          events.push(`end ${launchId}`)
          return Promise.resolve('ended')
        },
        launchIdOfDwarf: (legacyId) => (legacyId === `codex:s-1` ? 'launch-1' : undefined)
      },
      bridge: {
        toLegacy: (dwarfId) => Promise.resolve(dwarfId === CODEX_DWARF ? 'codex:s-1' : null)
      }
    })
    expect(stop?.part.channels).toEqual([STOP])
    const router = createRouter({
      routes: CUT_3A_ROUTES.filter((r) => r.channel === STOP),
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(stop === undefined ? {} : { host: stop.part.target }),
      senders
    })
    for (const dwarfId of [CODEX_DWARF, CLAUDE_DWARF]) {
      expect(await router.dispatch(STOP, FROM_PANEL, { dwarfId, requestId: REQUEST })).toEqual({
        ok: true,
        value: { ok: true, value: {} }
      })
    }
    expect(events).toEqual([
      'end launch-1',
      `crew.stop ${CODEX_DWARF}`,
      `crew.stop ${CLAUDE_DWARF}`
    ])
    stop?.dispose()
    // Without the join the root composes no A-N29 relay that could skip the legacy end.
    expect(
      composeStopDwarf({
        routes: CUT_3A_ROUTES,
        release: CUT_3A_RELEASE,
        client: client as unknown as Parameters<typeof composeStopDwarf>[0]['client'],
        legacy: {
          liveLaunches: () => Promise.resolve([]),
          endLaunch: () => Promise.resolve('ended')
        },
        bridge: undefined
      })
    ).toBeUndefined()
    // A-N26 keeps its cut-0 relay: every legacy launch ends before `host.shutdown {mode:'stop-all'}`.
    const SRC = resolve(import.meta.dirname, '../..')
    const root = readFileSync(resolve(SRC, 'ui-main/index.ts'), 'utf8')
    expect(root).toMatch(
      /relay: composeStopAllRelay\(launchObservation\?\.channel \?\? legacyRuntime\)/
    )
    expect(root).toMatch(/: composeStopDwarf\(\{\s*routes,\s*release,/)
  })

  it('[ADR-001] in 3a the legacy feed keeps only the legacy-launched sessions of a moved provider, and the Jev preferences are mirrored', () => {
    // 21 §3 `LegacyAgentRegistryFeed`: it shrinks per provider step; Claude's rows left today's runtime in 3a, but
    // `LegacyEndFirstAdapter` ends a session Claude's legacy path launched before the step through the same join, so
    // those sessions stay listed (the root binds today's launched register). A rollback build (no provider moved)
    // composes every discovery again.
    expect(legacyFeedModesOf(CUT_3A_ROUTES)).toEqual({
      [CLAUDE]: 'legacy-launched',
      [CODEX]: 'discover',
      [ANTIGRAVITY]: 'discover',
      [OPENCODE]: 'discover'
    })
    for (const mode of Object.values(legacyFeedModesOf(CUT_2_ROUTES))) {
      expect(mode).toBe('discover')
    }
    // AMENDED for ISSUE-236 (was: also the root composing `SettingsMirrorBridge`'s halves and its write hub, ISSUE-194):
    // the mirror left the tree with the 4a retirement.
    const SRC = resolve(import.meta.dirname, '../..')
    const root = readFileSync(resolve(SRC, 'ui-main/index.ts'), 'utf8')
    expect(root).toMatch(
      /launched: \(legacyDwarfId\) => legacyRuntime\.launchIdOfDwarf\?\.\(legacyDwarfId\) !== undefined/
    )
  })
})

// ADDED for ISSUE-002: the step-3b switch (21 §2 cut 3b; 14 §5; 21 §1 items 1, 2, 2a, 3). The release table moves
// Codex's launch, send, console and stop rows to the Host, qualified by provider exactly as 3a did for Claude; the
// shape adapters of 21 §3.1 keep serving the providers still not moved (OpenCode, "Other…", Antigravity), and A-27,
// A-P3 and A-P4 shrink to them. Each case drives the 3b table through the root's own compositions.
// AMENDED for ISSUE-186 (was: the release table `ROUTES` / `ROUTES_RELEASE`): from the step-3d switch the 3b table as it
// shipped is `testing/cut3bRoutes.ts`; `describe('release 3d')` pins the release table.
describe('release 3b (21 §2 cut 3b)', () => {
  const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
  /** The providers whose launcher has not moved to the Host by 3b (21 §2 cut 3 rows 3e, 4b). */
  const NOT_MOVED = [ANTIGRAVITY, OPENCODE]
  /** A provider id no catalog entry names ("Other…" reaches the shape adapters by having no qualified route). */
  const OTHER = 'other-command'
  const cut3b: RouteTable = {
    release: CUT_3B_RELEASE,
    routes: CUT_3B_ROUTES,
    unrouted: UNROUTED,
    retired: CUT_4A_RETIRED,
    adapters: ADAPTERS_AS_SHIPPED
  }
  const routeOf = (key: ChannelKey): ChannelRoute[] =>
    CUT_3B_ROUTES.filter((r) => r.channel === key)
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const MINE = '01920000-0000-7000-8000-000000000401'
  const REQUEST = '01920000-0000-7000-a000-000000000401'
  const MINTED = '01920000-0000-7000-8000-0000000004a1'
  const MESSAGE = '01920000-0000-7000-8000-0000000004b1'
  const LAUNCH = '01920000-0000-7000-8000-0000000004c1'
  const CODEX_DWARF = '01920000-0000-7000-9000-000000000412'
  const OPENCODE_DWARF = '01920000-0000-7000-9000-000000000414'
  const PER_PROVIDER = 'PerProviderShapeAdapter'
  const CATALOG_MERGE = 'CatalogMergeAdapter'
  const ACTIVATE: ChannelKey = 'dwarf:activate' // A-13
  const SEND: ChannelKey = 'dwarf:sendText' // A-23
  const LAUNCH_ROW: ChannelKey = 'agent:launch' // A-35
  const PROVIDERS: ChannelKey = 'agent:providers' // A-36
  const STOP: ChannelKey = 'dwarf:stop' // A-N29
  const PROVIDER_ROWS: ChannelKey[] = [LAUNCH_ROW, PROVIDERS, SEND, ACTIVATE]
  const NOT_MOVED_ROWS = ['dwarf:retire', 'agent:launchFailed', 'dwarf:sendText:settled'] as const

  const hostFor = (channel: ChannelKey, provider: string, since: StepId): ChannelRoute => ({
    channel,
    owner: 'host',
    since,
    parity: 'passed',
    qualifier: { provider },
    shape: 'target'
  })
  const legacyThrough = (channel: ChannelKey, adapter: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: adapter
  })
  const legacyFor = (channel: ChannelKey, provider: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    qualifier: { provider },
    shape: 'today'
  })

  /** A present Host dwarf of `providerId` (14 §3.6 `DwarfWire`), observed. */
  const dwarfWire = (id: string, providerId: string) => ({
    id,
    mineId: MINE,
    providerId,
    baseName: 'Balin',
    customName: null,
    rank: 'foreman',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId },
    presence: 'present',
    processState: 'running',
    status: 'working',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: false,
    arrivedAt: 1_700_000_000_500
  })
  const hostEntry = (providerId: string) => ({
    providerId,
    label: providerId,
    models: [{ value: 'default', efforts: ['high'] }],
    permissionModes: ['default'],
    offeredModes: ['default'],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available'
  })

  /** The Host's answer to each method the 3b rows relay. */
  const HOST_REPLIES: Record<string, unknown> = {
    'launching.launch': { launchId: LAUNCH },
    'conversation.send': { ok: true, value: { messageId: MESSAGE } },
    'conversation.resolveConsole': {
      mode: 'log',
      command: { program: 'tail', args: [], cwd: '/w' }
    },
    'suppliers.launchable': [hostEntry(CLAUDE), hostEntry(CODEX)],
    'crew.stop': { ok: true, value: {} },
    'strangler.dwarfIdentities': []
  }

  /**
   * The 3b rows as the root composes them over the release table (the 3a world of `describe('release 3a')` with one
   * Codex and one OpenCode dwarf on the Host board): the Host's handlers over a recording HostClient, the shape
   * adapters over a recording today's runtime, the provider qualifiers, and the router on an `ipcMain` stand-in.
   */
  function step3bWorld(
    table: readonly ChannelRoute[] = CUT_3B_ROUTES,
    release: StepId = CUT_3B_RELEASE
  ) {
    const hostCalls: Array<[string, unknown]> = []
    const legacyServed: Array<[string, unknown]> = []
    const client = {
      call: (method: string, params: unknown) => {
        if (method !== 'strangler.dwarfIdentities') hostCalls.push([method, params])
        return Promise.resolve(HOST_REPLIES[method])
      },
      subscribe: (handler: (event: HostEvent) => void) => {
        handler({
          kind: 'snapshot',
          snapshot: {
            seq: 1,
            chunks: [
              {
                section: 'dwarfs',
                data: [dwarfWire(CODEX_DWARF, CODEX), dwarfWire(OPENCODE_DWARF, OPENCODE)]
              }
            ]
          } as unknown as SnapshotPage
        })
        return () => {}
      }
    }
    const today: Record<string, unknown> = {
      'agent:launch': { launched: true, provider: OPENCODE, launchId: 'receipt:1' },
      'agent:providers': {
        providers: [
          { provider: CLAUDE, installed: true, launchable: true },
          { provider: CODEX, installed: true, launchable: true },
          { provider: OPENCODE, installed: true, launchable: true }
        ]
      },
      'dwarf:sendText': { delivered: true, via: 'terminal' },
      'dwarf:activate': { focused: true, openedTerminal: false }
    }
    const legacy = {
      serve: (channel: string, payload: unknown) => {
        legacyServed.push([channel, payload])
        return Promise.resolve(today[channel])
      }
    }
    const typedClient = client as unknown as Parameters<
      typeof composeConversationAndLaunchRows
    >[0]['client']
    const rows = composeConversationAndLaunchRows({
      routes: table,
      client: typedClient,
      consoles: { raiseConsole: () => Promise.resolve('raised') }
    })
    const stop = composeStopDwarf({
      routes: table,
      release,
      client: client as unknown as Parameters<typeof composeStopDwarf>[0]['client'],
      legacy: {
        liveLaunches: () => Promise.resolve([]),
        endLaunch: () => Promise.resolve('ended'),
        launchIdOfDwarf: () => undefined
      },
      bridge: { toLegacy: () => Promise.resolve(null) }
    })
    const routing = composeProviderRouting({
      routes: table,
      client: client as unknown as Parameters<typeof composeProviderRouting>[0]['client']
    })
    const adapters = composeProviderShapeAdapters({
      routes: table,
      release,
      legacy,
      models: { read: () => Promise.resolve({ catalogs: [] }) },
      client: typedClient,
      mintId: () => MINTED
    })
    const parts = [rows, stop?.part].filter(
      (part): part is NonNullable<typeof part> => part !== undefined
    )
    const handlers = new Map<string, (event: typeof FROM_PANEL, payload: unknown) => unknown>()
    const underTest = table.filter(
      (r) => r.shapeAdapter === undefined || [PER_PROVIDER, CATALOG_MERGE].includes(r.shapeAdapter)
    )
    createRouter({
      routes: underTest,
      legacy,
      host: composeRouteTargets(parts),
      uiLocal: { serve: () => Promise.reject(new Error('no ui-local row under test')) },
      ...(adapters === undefined ? {} : { shapeAdapters: adapters }),
      qualifiers: routing.qualifiers,
      senders
    }).register({
      handle: (wire, listener) => void handlers.set(wire, listener),
      on: (wire, listener) => void handlers.set(wire, listener)
    })
    const invoke = (wire: string, payload: unknown) => {
      const listener = handlers.get(wire)
      if (listener === undefined) throw new Error(`no listener for ${wire}`)
      return listener(FROM_PANEL, payload)
    }
    const dispose = () => {
      stop?.dispose()
      routing.dispose()
    }
    return { invoke, hostCalls, legacyServed, dispose }
  }

  const launchParams = (providerId: string) => ({
    mineId: MINE,
    way: { kind: 'supplier', providerId },
    prompt: 'Map the build',
    jevOn: false,
    jevAutoAccept: false,
    requestId: REQUEST
  })
  const sendParams = (dwarfId: string) => ({
    dwarfId,
    text: 'go on',
    attachments: [],
    requestId: REQUEST
  })

  it('[ADR-001] in 3b A-35, A-36, A-23, A-13 and A-N29 route host with shape target for the Claude and Codex qualifiers', async () => {
    expect(CUT_3B_RELEASE).toBe('cut-3b')
    expect(checkRouteTable(cut3b, KEYS)).toEqual([])
    for (const key of PROVIDER_ROWS) {
      // One owner per (channel, qualifier) (21 §1 item 2): the Host for Claude (3a) and for Codex (3b).
      expect(routeOf(key), key).toContainEqual(hostFor(key, CLAUDE, 'cut-3a'))
      expect(routeOf(key), key).toContainEqual(hostFor(key, CODEX, 'cut-3b'))
      expect(resolveRoute(CUT_3B_ROUTES, key, { provider: CODEX }), key).toEqual(
        hostFor(key, CODEX, 'cut-3b')
      )
    }
    // A-N29 is one `host` route for every dwarf since 3a (21 §3 `LegacyEndFirstAdapter` ends a legacy-launched one).
    for (const provider of [CLAUDE, CODEX]) {
      expect(resolveRoute(CUT_3B_ROUTES, STOP, { provider })?.owner, provider).toBe('host')
    }

    // Through the root's composition: a Codex call reaches the Host with the renderer's payload unchanged.
    const world = step3bWorld()
    expect(await world.invoke(LAUNCH_ROW, launchParams(CODEX))).toEqual({
      ok: true,
      value: { launchId: LAUNCH }
    })
    expect(await world.invoke(SEND, sendParams(CODEX_DWARF))).toEqual({
      ok: true,
      value: { ok: true, value: { messageId: MESSAGE } }
    })
    expect(await world.invoke(ACTIVATE, { dwarfId: CODEX_DWARF, purpose: 'open-console' })).toEqual(
      { ok: true, value: { outcome: 'opened', mode: 'log' } }
    )
    expect(await world.invoke(STOP, { dwarfId: CODEX_DWARF, requestId: REQUEST })).toEqual({
      ok: true,
      value: { ok: true, value: {} }
    })
    expect(world.hostCalls.map(([method]) => method)).toEqual([
      'launching.launch',
      'conversation.send',
      'conversation.resolveConsole',
      'crew.stop'
    ])
    expect(world.hostCalls[0]?.[1]).toEqual(launchParams(CODEX))
    expect(world.legacyServed).toEqual([])
    world.dispose()
  })

  it('[ADR-001] in 3b only OpenCode, Other… and Antigravity reach A-13, A-23, A-35, A-36 through the shape adapters', async () => {
    for (const key of [ACTIVATE, SEND, LAUNCH_ROW]) {
      expect(routeOf(key), key).toEqual([
        hostFor(key, CLAUDE, 'cut-3a'),
        legacyThrough(key, PER_PROVIDER),
        hostFor(key, CODEX, 'cut-3b')
      ])
      for (const provider of [...NOT_MOVED, OTHER]) {
        expect(resolveRoute(CUT_3B_ROUTES, key, { provider }), `${key} ${provider}`).toEqual(
          legacyThrough(key, PER_PROVIDER)
        )
      }
    }
    // Catalog merge (21 §3.1): the Claude and Codex entries from the Host, the others from today's catalog.
    expect(routeOf(PROVIDERS)).toEqual([
      hostFor(PROVIDERS, CLAUDE, 'cut-3a'),
      legacyThrough(PROVIDERS, CATALOG_MERGE),
      hostFor(PROVIDERS, CODEX, 'cut-3b')
    ])
    expect(resolveRoute(CUT_3B_ROUTES, PROVIDERS)).toEqual(legacyThrough(PROVIDERS, CATALOG_MERGE))

    const world = step3bWorld()
    const catalog = (await world.invoke(PROVIDERS, {})) as {
      ok: boolean
      value: Array<{ providerId: string }>
    }
    expect(catalog.ok).toBe(true)
    expect(catalog.value.map((entry) => entry.providerId)).toEqual([CLAUDE, CODEX, OPENCODE])
    expect(catalog.value[1]).toEqual(hostEntry(CODEX))
    // An OpenCode launch in the target shape reaches today's launch and answers a minted LaunchId.
    expect(await world.invoke(LAUNCH_ROW, launchParams(OPENCODE))).toEqual({
      ok: true,
      value: { launchId: MINTED }
    })
    const sent = (await world.invoke(SEND, sendParams(OPENCODE_DWARF))) as { ok: boolean }
    expect(sent.ok).toBe(true)
    expect(world.legacyServed.map(([channel]) => channel)).toEqual([
      'agent:providers',
      'agent:launch',
      'dwarf:sendText'
    ])
    expect(world.hostCalls.map(([method]) => method)).toEqual(['suppliers.launchable'])
    world.dispose()
  })

  it('[ADR-001] in 3b A-27, A-P3 and A-P4 route legacy only for OpenCode, Other… and Antigravity', () => {
    for (const key of NOT_MOVED_ROWS) {
      expect(routeOf(key), key).toEqual(NOT_MOVED.map((provider) => legacyFor(key, provider)))
      // A moved provider has no route: its successors are B-F10, B-F19 and B-F12 (21 §2 cut 3 common rules).
      for (const provider of [CLAUDE, CODEX]) {
        expect(resolveRoute(CUT_3B_ROUTES, key, { provider }), `${key} ${provider}`).toBeUndefined()
      }
      for (const provider of NOT_MOVED) {
        expect(resolveRoute(CUT_3B_ROUTES, key, { provider })?.owner, `${key} ${provider}`).toBe(
          'legacy'
        )
      }
    }
  })

  it('[ADR-001] in 3b every host route uses only seam-B members born by 3b and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of CUT_3B_ROUTES.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at(CUT_3B_RELEASE)
        )
      }
    }
    // The routes 3b moved are Codex's four, each relaying the member Claude's route relays since 3a.
    const moved = CUT_3B_ROUTES.filter((r) => r.owner === 'host' && r.since === 'cut-3b')
    expect(moved.map((r) => `${r.channel} ${r.qualifier?.provider}`).sort()).toEqual(
      [ACTIVATE, PROVIDERS, LAUNCH_ROW, SEND].map((key) => `${key} ${CODEX}`).sort()
    )
    // 3b moves a provider onto members 3a already bore: no seam B member is born in 3b (21 §2 "Seam B members").
    expect(Object.values(SEAM_B_METHODS_BORN)).not.toContain('cut-3b')
    // No NEW row is routed by 3b, so the unrouted list is 3a's (ISSUE-043 rule).
    expect(UNROUTED).toEqual({ 'host:connection:confirm-restart': 'generation-2' })
  })

  it('[ADR-001] in 3b the legacy feed keeps the legacy-launched Codex sessions and their pending questions', () => {
    // 21 §3 `LegacyAgentRegistryFeed` shrinks per provider step: Codex's rows left today's runtime in 3b, but
    // `LegacyEndFirstAdapter` ends a session Codex's legacy path launched before the step through the same join, and
    // `LegacyAskRelay` still answers the questions of person-launched Codex sessions until the end of cut 4 (21 §2
    // cut 2 "Qualified routes"), so both stay listed. A 3b rollback build composes Codex's whole discovery again.
    expect(legacyFeedModesOf(CUT_3B_ROUTES)).toEqual({
      [CLAUDE]: 'legacy-launched',
      [CODEX]: 'legacy-launched-or-pending-questions',
      [ANTIGRAVITY]: 'discover',
      [OPENCODE]: 'discover'
    })
    expect(legacyFeedModesOf(rollbackOf(cut3b, 'cut-3b').routes)).toEqual(
      legacyFeedModesOf(CUT_3A_ROUTES)
    )
  })

  it('[ADR-001] a 3b rollback build routes every Codex row as the 3a table did', async () => {
    // 21 §2.1 item 1, §2 cut 3 "Rollback (each step)": the provider-qualified rows flip back to `legacy` before the
    // step's deletion commit; Codex reaches the shape adapters again and A-27, A-P3, A-P4 name it again.
    const rolledBack = rollbackOf(cut3b, 'cut-3b')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    const order = (routes: readonly ChannelRoute[]) =>
      routes.map((route) => JSON.stringify(route)).sort()
    expect(order(rolledBack.routes)).toEqual(order(CUT_3A_ROUTES))
    const world = step3bWorld(rolledBack.routes, 'cut-3b')
    expect(await world.invoke(LAUNCH_ROW, launchParams(CODEX))).toEqual({
      ok: true,
      value: { launchId: MINTED }
    })
    expect(world.hostCalls).toEqual([])
    world.dispose()
  })
})

// ADDED for ISSUE-186: the step-3d switch (21 §2 cut 3d; 14 §2.1 A-39, §5; 21 §1 items 1, 2, 2a, 3; §3.1). The release
// table moves A-39 `launchHostedProcess` to the Host (`launching.launchCustom`, B-M34) with its target shape, and the
// "Other…" dwarfs' send, console and launch rows (A-23, A-13, A-35 with its Retry path) to the Host, qualified by the
// "Other…" driver's provider id; A-N29's one `host` route already serves every dwarf. Each case drives the release table
// (`ROUTES`) through the root's own compositions.
// AMENDED for ISSUE-188 (was: the release table `ROUTES` / `ROUTES_RELEASE`): from the step-3e switch the 3d table as it
// shipped is `testing/cut3dRoutes.ts`; `describe('release 3e')` pins the release table.
describe('release 3d (21 §2 cut 3d)', () => {
  const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
  /** The providers whose launcher has not moved to the Host by 3d (21 §2 cut 3 rows 3e, 4b). */
  const NOT_MOVED = [ANTIGRAVITY, OPENCODE]
  /** The "Other…" driver's provider id (15 §3 H1 `HostedCommandDriver`), outside the catalog (INV-43). */
  const OTHER = 'other'
  const cut3d: RouteTable = {
    release: CUT_3D_RELEASE,
    routes: CUT_3D_ROUTES,
    unrouted: UNROUTED,
    retired: CUT_4A_RETIRED,
    adapters: ADAPTERS_AS_SHIPPED
  }
  const routeOf = (key: ChannelKey): ChannelRoute[] =>
    CUT_3D_ROUTES.filter((r) => r.channel === key)
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const MINE = '01920000-0000-7000-8000-000000000501'
  const REQUEST = '01920000-0000-7000-a000-000000000501'
  const MINTED = '01920000-0000-7000-8000-0000000005a1'
  const MESSAGE = '01920000-0000-7000-8000-0000000005b1'
  const LAUNCH = '01920000-0000-7000-8000-0000000005c1'
  const FAILED_LAUNCH = '01920000-0000-7000-8000-0000000005c2'
  const OTHER_DWARF = '01920000-0000-7000-9000-000000000515'
  const OPENCODE_DWARF = '01920000-0000-7000-9000-000000000514'
  const PER_PROVIDER = 'PerProviderShapeAdapter'
  const CATALOG_MERGE = 'CatalogMergeAdapter'
  const ACTIVATE: ChannelKey = 'dwarf:activate' // A-13
  const SEND: ChannelKey = 'dwarf:sendText' // A-23
  const LAUNCH_ROW: ChannelKey = 'agent:launch' // A-35
  const LAUNCH_HOSTED: ChannelKey = 'agent:launchHosted' // A-39
  const STOP: ChannelKey = 'dwarf:stop' // A-N29
  const OTHER_ROWS: ChannelKey[] = [LAUNCH_ROW, SEND, ACTIVATE]
  const NOT_MOVED_ROWS = ['dwarf:retire', 'agent:launchFailed', 'dwarf:sendText:settled'] as const

  const hostFor = (channel: ChannelKey, provider: string, since: StepId): ChannelRoute => ({
    channel,
    owner: 'host',
    since,
    parity: 'passed',
    qualifier: { provider },
    shape: 'target'
  })
  const legacyThrough = (channel: ChannelKey, adapter: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: adapter
  })
  const legacyFor = (channel: ChannelKey, provider: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    qualifier: { provider },
    shape: 'today'
  })

  /** A present Host dwarf of `providerId` (14 §3.6 `DwarfWire`), owned. */
  const dwarfWire = (id: string, providerId: string) => ({
    id,
    mineId: MINE,
    providerId,
    baseName: 'Dori',
    customName: null,
    rank: 'foreman',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId },
    presence: 'present',
    processState: 'running',
    status: 'working',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: true,
    arrivedAt: 1_700_000_000_500
  })

  /** The Host's answer to each method the 3d rows relay. */
  const HOST_REPLIES: Record<string, unknown> = {
    'launching.launch': { launchId: LAUNCH },
    'launching.launchCustom': { launchId: LAUNCH },
    'conversation.send': { ok: true, value: { messageId: MESSAGE } },
    'conversation.resolveConsole': {
      mode: 'log',
      command: { program: 'tail', args: [], cwd: '/w' }
    },
    'crew.stop': { ok: true, value: {} },
    'strangler.dwarfIdentities': []
  }

  /**
   * The 3d rows as the root composes them over a table (the 3b world of `describe('release 3b')` with one "Other…"
   * dwarf and one OpenCode dwarf on the Host board): the Host's handlers over a recording HostClient, the shape
   * adapters over a recording today's runtime, the provider qualifiers, and the router on an `ipcMain` stand-in.
   */
  function step3dWorld(
    table: readonly ChannelRoute[] = CUT_3D_ROUTES,
    release: StepId = CUT_3D_RELEASE
  ) {
    const hostCalls: Array<[string, unknown]> = []
    const legacyServed: Array<[string, unknown]> = []
    const client = {
      call: (method: string, params: unknown) => {
        if (method !== 'strangler.dwarfIdentities') hostCalls.push([method, params])
        return Promise.resolve(HOST_REPLIES[method])
      },
      subscribe: (handler: (event: HostEvent) => void) => {
        handler({
          kind: 'snapshot',
          snapshot: {
            seq: 1,
            chunks: [
              {
                section: 'dwarfs',
                data: [dwarfWire(OTHER_DWARF, OTHER), dwarfWire(OPENCODE_DWARF, OPENCODE)]
              }
            ]
          } as unknown as SnapshotPage
        })
        return () => {}
      }
    }
    const today: Record<string, unknown> = {
      'agent:launch': { launched: true, provider: OPENCODE, launchId: 'receipt:1' },
      'agent:launchHosted': { launched: true },
      'dwarf:sendText': { delivered: true, via: 'terminal' },
      'dwarf:activate': { focused: true, openedTerminal: false }
    }
    const legacy = {
      serve: (channel: string, payload: unknown) => {
        legacyServed.push([channel, payload])
        return Promise.resolve(today[channel])
      }
    }
    const typedClient = client as unknown as Parameters<
      typeof composeConversationAndLaunchRows
    >[0]['client']
    const rows = composeConversationAndLaunchRows({
      routes: table,
      client: typedClient,
      consoles: { raiseConsole: () => Promise.resolve('raised') }
    })
    const stop = composeStopDwarf({
      routes: table,
      release,
      client: client as unknown as Parameters<typeof composeStopDwarf>[0]['client'],
      legacy: {
        liveLaunches: () => Promise.resolve([]),
        endLaunch: () => Promise.resolve('ended'),
        launchIdOfDwarf: () => undefined
      },
      bridge: { toLegacy: () => Promise.resolve(null) }
    })
    const routing = composeProviderRouting({
      routes: table,
      client: client as unknown as Parameters<typeof composeProviderRouting>[0]['client']
    })
    const adapters = composeProviderShapeAdapters({
      routes: table,
      release,
      legacy,
      models: { read: () => Promise.resolve({ catalogs: [] }) },
      client: typedClient,
      mintId: () => MINTED
    })
    const parts = [rows, stop?.part].filter(
      (part): part is NonNullable<typeof part> => part !== undefined
    )
    const handlers = new Map<string, (event: typeof FROM_PANEL, payload: unknown) => unknown>()
    const underTest = table.filter(
      (r) => r.shapeAdapter === undefined || [PER_PROVIDER, CATALOG_MERGE].includes(r.shapeAdapter)
    )
    createRouter({
      routes: underTest,
      legacy,
      host: composeRouteTargets(parts),
      uiLocal: { serve: () => Promise.reject(new Error('no ui-local row under test')) },
      ...(adapters === undefined ? {} : { shapeAdapters: adapters }),
      qualifiers: routing.qualifiers,
      senders
    }).register({
      handle: (wire, listener) => void handlers.set(wire, listener),
      on: (wire, listener) => void handlers.set(wire, listener)
    })
    const invoke = (wire: string, payload: unknown) => {
      const listener = handlers.get(wire)
      if (listener === undefined) throw new Error(`no listener for ${wire}`)
      return listener(FROM_PANEL, payload)
    }
    const dispose = () => {
      stop?.dispose()
      routing.dispose()
    }
    return { invoke, hostCalls, legacyServed, dispose }
  }

  /** A-39's request (14 §3.4 `LaunchCustomParams`), the same object as B-M34's params (14 §1.2). */
  const customParams = (extra: Record<string, unknown> = {}) => ({
    mineId: MINE,
    command: 'my-agent --once',
    prompt: 'Map the build',
    requestId: REQUEST,
    ...extra
  })
  const sendParams = (dwarfId: string) => ({
    dwarfId,
    text: 'go on',
    attachments: [],
    requestId: REQUEST
  })

  it('[ADR-001] in 3d A-39 routes host to launching.launchCustom with shape target', async () => {
    expect(CUT_3D_RELEASE).toBe('cut-3d')
    expect(checkRouteTable(cut3d, KEYS)).toEqual([])
    // One unqualified route: "Other…" is a channel of its own, no provider to qualify (21 §3.1: no shape adapter).
    expect(routeOf(LAUNCH_HOSTED)).toEqual([
      { channel: LAUNCH_HOSTED, owner: 'host', since: 'cut-3d', parity: 'passed', shape: 'target' }
    ])
    expect(HOST_ROUTE_MEMBERS[LAUNCH_HOSTED]).toEqual(['launching.launchCustom'])

    // Through the root's composition: the renderer's payload reaches B-M34 unchanged, the Retry of a failed "Other…"
    // launch included, and the Host's acceptance comes back as the result's value (14 §1.7).
    const world = step3dWorld()
    expect(await world.invoke(LAUNCH_HOSTED, customParams())).toEqual({
      ok: true,
      value: { launchId: LAUNCH }
    })
    expect(await world.invoke(LAUNCH_HOSTED, customParams({ retryOf: FAILED_LAUNCH }))).toEqual({
      ok: true,
      value: { launchId: LAUNCH }
    })
    // A payload in today's shape (no requestId) is refused in main and never reaches the Host (ADR-019).
    expect(
      await world.invoke(LAUNCH_HOSTED, { mineId: MINE, command: 'my-agent', prompt: 'go' })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(world.hostCalls).toEqual([
      ['launching.launchCustom', customParams()],
      ['launching.launchCustom', customParams({ retryOf: FAILED_LAUNCH })]
    ])
    expect(world.legacyServed).toEqual([])
    world.dispose()
  })

  it('[ADR-001] in 3d A-35, A-23, A-13 and A-N29 route host for Other dwarfs', async () => {
    for (const key of OTHER_ROWS) {
      // One owner per (channel, qualifier) (21 §1 item 2): the Host for Claude (3a), Codex (3b) and "Other…" (3d).
      expect(routeOf(key), key).toEqual([
        hostFor(key, CLAUDE, 'cut-3a'),
        legacyThrough(key, PER_PROVIDER),
        hostFor(key, CODEX, 'cut-3b'),
        hostFor(key, OTHER, 'cut-3d')
      ])
      expect(resolveRoute(CUT_3D_ROUTES, key, { provider: OTHER }), key).toEqual(
        hostFor(key, OTHER, 'cut-3d')
      )
      for (const provider of NOT_MOVED) {
        expect(resolveRoute(CUT_3D_ROUTES, key, { provider }), `${key} ${provider}`).toEqual(
          legacyThrough(key, PER_PROVIDER)
        )
      }
    }
    // A-N29 is one `host` route for every dwarf since 3a; "Other…" is not in the catalog, so A-36 names no route for it.
    expect(resolveRoute(CUT_3D_ROUTES, STOP, { provider: OTHER })?.owner).toBe('host')
    expect(routeOf('agent:providers').some((r) => r.qualifier?.provider === OTHER)).toBe(false)

    // Through the root's composition: an "Other…" dwarf's send, console and stop reach the Host, an OpenCode dwarf's
    // send still reaches today's runtime.
    const world = step3dWorld()
    expect(await world.invoke(SEND, sendParams(OTHER_DWARF))).toEqual({
      ok: true,
      value: { ok: true, value: { messageId: MESSAGE } }
    })
    expect(await world.invoke(ACTIVATE, { dwarfId: OTHER_DWARF, purpose: 'open-console' })).toEqual(
      { ok: true, value: { outcome: 'opened', mode: 'log' } }
    )
    expect(await world.invoke(STOP, { dwarfId: OTHER_DWARF, requestId: REQUEST })).toEqual({
      ok: true,
      value: { ok: true, value: {} }
    })
    const sent = (await world.invoke(SEND, sendParams(OPENCODE_DWARF))) as { ok: boolean }
    expect(sent.ok).toBe(true)
    expect(world.hostCalls.map(([method]) => method)).toEqual([
      'conversation.send',
      'conversation.resolveConsole',
      'crew.stop'
    ])
    expect(world.legacyServed.map(([channel]) => channel)).toEqual(['dwarf:sendText'])
    world.dispose()
  })

  it('[ADR-001] in 3d A-27, A-P3 and A-P4 route legacy only for providers not yet moved', () => {
    for (const key of NOT_MOVED_ROWS) {
      expect(routeOf(key), key).toEqual(NOT_MOVED.map((provider) => legacyFor(key, provider)))
      // A moved provider has no route, and neither has "Other…" (no 3d build holds a legacy-launched "Other…"
      // session: today's hosted process dies with the window that launched it); B-F10, B-F19, B-F12 succeed them.
      for (const provider of [CLAUDE, CODEX, OTHER]) {
        expect(resolveRoute(CUT_3D_ROUTES, key, { provider }), `${key} ${provider}`).toBeUndefined()
      }
      for (const provider of NOT_MOVED) {
        expect(resolveRoute(CUT_3D_ROUTES, key, { provider })?.owner, `${key} ${provider}`).toBe(
          'legacy'
        )
      }
    }
  })

  it('[ADR-001] in 3d every host route uses only seam-B members born by 3d and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of CUT_3D_ROUTES.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at(CUT_3D_RELEASE)
        )
      }
    }
    // The routes 3d moved: A-39, and "Other…"'s A-13, A-23 and A-35.
    const moved = CUT_3D_ROUTES.filter((r) => r.owner === 'host' && r.since === 'cut-3d')
    expect(moved.map((r) => `${r.channel} ${r.qualifier?.provider ?? '*'}`).sort()).toEqual(
      [`${LAUNCH_HOSTED} *`, ...OTHER_ROWS.map((key) => `${key} ${OTHER}`)].sort()
    )
    // B-M34 is the one seam B member born in 3d (21 §2 row 3d "Rows born or moved").
    expect(
      Object.entries(SEAM_B_METHODS_BORN)
        .filter(([, step]) => step === 'cut-3d')
        .map(([member]) => member)
    ).toEqual(['launching.launchCustom'])
    // No NEW row is routed by 3d, so the unrouted list is 3b's (ISSUE-043 rule).
    expect(UNROUTED).toEqual({ 'host:connection:confirm-restart': 'generation-2' })
  })

  it('[ADR-001] a 3d rollback build routes A-39 and every Other… row as the 3b table did', async () => {
    // 21 §2.1 item 1, §2 cut 3 "Rollback (each step)": before the 3d deletion commit the rows flip back to `legacy`.
    // A-39 is today's runtime with today's shape again (21 §3.1 names no shape adapter for it); an "Other…" dwarf
    // reaches `PerProviderShapeAdapter`; A-27, A-P3 and A-P4 gain no "Other…" row (they never had one).
    const rolledBack = rollbackOf(cut3d, 'cut-3d')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    const order = (routes: readonly ChannelRoute[]) =>
      routes.map((route) => JSON.stringify(route)).sort()
    expect(order(rolledBack.routes)).toEqual(order(CUT_3B_ROUTES))
    const world = step3dWorld(rolledBack.routes, 'cut-3d')
    expect(await world.invoke(SEND, sendParams(OTHER_DWARF))).toMatchObject({ ok: true })
    expect(
      await world.invoke(LAUNCH_HOSTED, { mineId: MINE, command: 'my-agent', prompt: 'go' })
    ).toEqual({ launched: true })
    expect(world.hostCalls).toEqual([])
    expect(world.legacyServed.map(([channel]) => channel)).toEqual([
      'dwarf:sendText',
      'agent:launchHosted'
    ])
    world.dispose()
  })
})

// ADDED for ISSUE-188: the step-3e switch (21 §2 cut 3e; 14 §2.1 A-13, A-23, A-27, A-35, A-36, A-P3, A-P4, §5; 21 §1
// items 1, 2, 2a, 3; ADR-009 D6). The release table moves Antigravity's send, console and catalog rows to the Host,
// qualified by provider as 3a and 3b did, and a development build adds Antigravity's launch row (A-35 with its Retry
// path, `DEVELOPMENT_BUILD_ROUTES`): the one build flag decides, never a provider id. A-27, A-P3 and A-P4 shrink to
// OpenCode. Each case drives the development build's table through the root's own compositions; the public build's
// table is pinned by `publicBuild.3e.test.ts`.
// AMENDED for ISSUE-235 (was: the release table `routesForBuild` / `ROUTES_RELEASE`): from the step-4a switch the 3e
// tables as they shipped are `testing/cut3eRoutes.ts`; `describe('release 4a')` pins the release table.
describe('release 3e (21 §2 cut 3e)', () => {
  const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
  /** The "Other…" driver's provider id (15 §3 H1 `HostedCommandDriver`), outside the catalog (INV-43). */
  const OTHER = 'other'
  const DEVELOPMENT = CUT_3E_ROUTES
  const PUBLIC = cut3eRoutesForBuild({ publicBuild: true })
  const tableOf = (routes: readonly ChannelRoute[]): RouteTable => ({
    release: CUT_3E_RELEASE,
    routes,
    unrouted: UNROUTED,
    retired: CUT_4A_RETIRED,
    adapters: ADAPTERS_AS_SHIPPED
  })
  const cut3e = tableOf(DEVELOPMENT)
  const routeOf = (key: ChannelKey): ChannelRoute[] => DEVELOPMENT.filter((r) => r.channel === key)
  const REQUEST = '01920000-0000-7000-a000-000000000601'
  const MESSAGE = '01920000-0000-7000-8000-0000000006b1'
  const LAUNCH = '01920000-0000-7000-8000-0000000006c1'
  const FAILED_LAUNCH = '01920000-0000-7000-8000-0000000006c2'
  const ANTIGRAVITY_DWARF = '01920000-0000-7000-9000-000000000616'
  const OPENCODE_DWARF = '01920000-0000-7000-9000-000000000614'
  const PER_PROVIDER = 'PerProviderShapeAdapter'
  const CATALOG_MERGE = 'CatalogMergeAdapter'
  const ACTIVATE: ChannelKey = 'dwarf:activate' // A-13
  const SEND: ChannelKey = 'dwarf:sendText' // A-23
  const LAUNCH_ROW: ChannelKey = 'agent:launch' // A-35
  const PROVIDERS: ChannelKey = 'agent:providers' // A-36
  const STOP: ChannelKey = 'dwarf:stop' // A-N29
  const NOT_MOVED_ROWS = ['dwarf:retire', 'agent:launchFailed', 'dwarf:sendText:settled'] as const

  const hostFor = (channel: ChannelKey, provider: string, since: StepId): ChannelRoute => ({
    channel,
    owner: 'host',
    since,
    parity: 'passed',
    qualifier: { provider },
    shape: 'target'
  })
  const legacyThrough = (channel: ChannelKey, adapter: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: adapter
  })
  const legacyFor = (channel: ChannelKey, provider: string): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    qualifier: { provider },
    shape: 'today'
  })

  /** The rows as the root composes them over `table`, one Antigravity and one OpenCode dwarf on the Host board. */
  const step3eWorld = (
    table: readonly ChannelRoute[] = DEVELOPMENT,
    release: StepId = CUT_3E_RELEASE
  ) =>
    providerRowsWorld({
      table,
      release,
      dwarfs: [
        dwarfWire(ANTIGRAVITY_DWARF, ANTIGRAVITY, true),
        dwarfWire(OPENCODE_DWARF, OPENCODE, false)
      ],
      hostReplies: {
        'launching.launch': { launchId: LAUNCH },
        'conversation.send': { ok: true, value: { messageId: MESSAGE } },
        'conversation.resolveConsole': {
          mode: 'log',
          command: { program: 'tail', args: [], cwd: '/w' }
        },
        // A development build's Host lists its gated provider as launchable (ADR-009 D6: development builds keep it).
        'suppliers.launchable': [
          hostEntry(CLAUDE),
          hostEntry(CODEX),
          hostEntry(ANTIGRAVITY, 'gated')
        ],
        'crew.stop': { ok: true, value: {} }
      },
      today: {
        'agent:launch': { launched: true, provider: OPENCODE, launchId: 'receipt:1' },
        'agent:providers': {
          providers: [
            { provider: CLAUDE, installed: true, launchable: true },
            { provider: CODEX, installed: true, launchable: true },
            { provider: ANTIGRAVITY, installed: true, launchable: true },
            { provider: OPENCODE, installed: true, launchable: true }
          ]
        },
        'dwarf:sendText': { delivered: true, via: 'terminal' },
        'dwarf:activate': { focused: true, openedTerminal: false }
      }
    })

  const launchParams = (providerId: string, extra: Record<string, unknown> = {}) => ({
    mineId: WORLD_MINE,
    way: { kind: 'supplier', providerId },
    prompt: 'Map the build',
    jevOn: false,
    jevAutoAccept: false,
    requestId: REQUEST,
    ...extra
  })
  const sendParams = (dwarfId: string) => ({
    dwarfId,
    text: 'go on',
    attachments: [],
    requestId: REQUEST
  })

  it('[ADR-001] in a 3e development build A-35, A-36, A-23, A-13 and A-N29 route host for the Antigravity qualifier', async () => {
    expect(CUT_3E_RELEASE).toBe('cut-3e')
    expect(checkRouteTable(cut3e, KEYS)).toEqual([])
    expect(checkRouteTable(tableOf(PUBLIC), KEYS)).toEqual([])
    // One owner per (channel, qualifier) (21 §1 item 2): the Host for Claude (3a), Codex (3b), "Other…" (3d) and
    // Antigravity (3e); OpenCode is the one provider still reaching `PerProviderShapeAdapter`.
    for (const key of [ACTIVATE, SEND, LAUNCH_ROW]) {
      expect(routeOf(key), key).toEqual([
        hostFor(key, CLAUDE, 'cut-3a'),
        legacyThrough(key, PER_PROVIDER),
        hostFor(key, CODEX, 'cut-3b'),
        hostFor(key, OTHER, 'cut-3d'),
        hostFor(key, ANTIGRAVITY, 'cut-3e')
      ])
      expect(resolveRoute(DEVELOPMENT, key, { provider: ANTIGRAVITY }), key).toEqual(
        hostFor(key, ANTIGRAVITY, 'cut-3e')
      )
      expect(resolveRoute(DEVELOPMENT, key, { provider: OPENCODE }), key).toEqual(
        legacyThrough(key, PER_PROVIDER)
      )
    }
    expect(routeOf(PROVIDERS)).toEqual([
      hostFor(PROVIDERS, CLAUDE, 'cut-3a'),
      legacyThrough(PROVIDERS, CATALOG_MERGE),
      hostFor(PROVIDERS, CODEX, 'cut-3b'),
      hostFor(PROVIDERS, ANTIGRAVITY, 'cut-3e')
    ])
    // A-N29 is one `host` route for every dwarf since 3a.
    expect(resolveRoute(DEVELOPMENT, STOP, { provider: ANTIGRAVITY })?.owner).toBe('host')
    // The launch row is the development build's only (one build flag, ADR-009 D6); the others serve every build.
    expect(DEVELOPMENT_BUILD_ROUTES).toEqual([hostFor(LAUNCH_ROW, ANTIGRAVITY, 'cut-3e')])
    expect(DEVELOPMENT).toEqual([...PUBLIC, ...DEVELOPMENT_BUILD_ROUTES])

    // Through the root's composition: an Antigravity launch (and its Retry), send, console and stop reach the Host with
    // the renderer's payload unchanged; the catalog lists Antigravity's entry from the Host, never today's.
    const world = step3eWorld()
    expect(await world.invoke(LAUNCH_ROW, launchParams(ANTIGRAVITY))).toEqual({
      ok: true,
      value: { launchId: LAUNCH }
    })
    expect(
      await world.invoke(LAUNCH_ROW, launchParams(ANTIGRAVITY, { retryOf: FAILED_LAUNCH }))
    ).toEqual({ ok: true, value: { launchId: LAUNCH } })
    expect(await world.invoke(SEND, sendParams(ANTIGRAVITY_DWARF))).toEqual({
      ok: true,
      value: { ok: true, value: { messageId: MESSAGE } }
    })
    expect(
      await world.invoke(ACTIVATE, { dwarfId: ANTIGRAVITY_DWARF, purpose: 'open-console' })
    ).toEqual({ ok: true, value: { outcome: 'opened', mode: 'log' } })
    expect(await world.invoke(STOP, { dwarfId: ANTIGRAVITY_DWARF, requestId: REQUEST })).toEqual({
      ok: true,
      value: { ok: true, value: {} }
    })
    const catalog = (await world.invoke(PROVIDERS, {})) as {
      ok: boolean
      value: Array<{ providerId: string }>
    }
    expect(catalog.value.map((entry) => entry.providerId)).toEqual([
      CLAUDE,
      CODEX,
      ANTIGRAVITY,
      OPENCODE
    ])
    expect(catalog.value[2]).toEqual(hostEntry(ANTIGRAVITY, 'gated'))
    expect(world.hostCalls.map(([method]) => method)).toEqual([
      'launching.launch',
      'launching.launch',
      'conversation.send',
      'conversation.resolveConsole',
      'crew.stop',
      'suppliers.launchable'
    ])
    expect(world.hostCalls[0]?.[1]).toEqual(launchParams(ANTIGRAVITY))
    expect(world.legacyServed.map(([channel]) => channel)).toEqual(['agent:providers'])
    world.dispose()
  })

  it('[ADR-001] in 3e A-27, A-P3 and A-P4 route legacy qualified to OpenCode only', () => {
    for (const table of [DEVELOPMENT, PUBLIC]) {
      for (const key of NOT_MOVED_ROWS) {
        expect(
          table.filter((r) => r.channel === key),
          key
        ).toEqual([legacyFor(key, OPENCODE)])
        // A moved provider has no route: its successors are B-F10, B-F19 and B-F12 (21 §2 cut 3 common rules).
        for (const provider of [CLAUDE, CODEX, ANTIGRAVITY, OTHER]) {
          expect(resolveRoute(table, key, { provider }), `${key} ${provider}`).toBeUndefined()
        }
      }
    }
  })

  it('[ADR-001] in 3e every host route uses only seam-B members born by 3e and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of DEVELOPMENT.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at(CUT_3E_RELEASE)
        )
      }
    }
    // The routes 3e moved: Antigravity's A-13, A-23, A-35 and A-36.
    const moved = DEVELOPMENT.filter((r) => r.owner === 'host' && r.since === 'cut-3e')
    expect(moved.map((r) => `${r.channel} ${r.qualifier?.provider ?? '*'}`).sort()).toEqual(
      [ACTIVATE, SEND, LAUNCH_ROW, PROVIDERS].map((key) => `${key} ${ANTIGRAVITY}`).sort()
    )
    // No seam B member and no NEW row is born in 3e (21 §2 row 3e), so the unrouted list is 3d's (ISSUE-043 rule).
    expect(Object.values(SEAM_B_METHODS_BORN).filter((step) => step === 'cut-3e')).toEqual([])
    expect(UNROUTED).toEqual({ 'host:connection:confirm-restart': 'generation-2' })
  })

  it('[ADR-001] in 3e the legacy feed keeps only the legacy-launched Antigravity sessions, in either build', () => {
    // 21 §3 `LegacyAgentRegistryFeed` shrinks per provider step; A-36 is the Host's for Antigravity in both builds, so
    // the Host observes every Antigravity session and today's runtime keeps only the ones it launched (for
    // `LegacyEndFirstAdapter`). A 3e rollback build composes Antigravity's whole discovery again.
    const expected = {
      [CLAUDE]: 'legacy-launched',
      [CODEX]: 'legacy-launched-or-pending-questions',
      [ANTIGRAVITY]: 'legacy-launched',
      [OPENCODE]: 'discover'
    }
    expect(legacyFeedModesOf(DEVELOPMENT)).toEqual(expected)
    expect(legacyFeedModesOf(PUBLIC)).toEqual(expected)
    expect(legacyFeedModesOf(rollbackOf(cut3e, 'cut-3e').routes)).toEqual(
      legacyFeedModesOf(CUT_3D_ROUTES)
    )
  })

  it('[ADR-001] a 3e rollback build routes every Antigravity row as the 3d table did', async () => {
    // 21 §2.1 item 1, §2 cut 3 "Rollback (each step)": before the 3e deletion commit (ISSUE-189) the rows flip back to
    // `legacy`, in either build: Antigravity reaches the shape adapters again and gets its A-27, A-P3, A-P4 rows back.
    const order = (routes: readonly ChannelRoute[]) =>
      routes.map((route) => JSON.stringify(route)).sort()
    for (const table of [cut3e, tableOf(PUBLIC)]) {
      const rolledBack = rollbackOf(table, 'cut-3e')
      expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
      expect(order(rolledBack.routes)).toEqual(order(CUT_3D_ROUTES))
    }
    const world = step3eWorld(rollbackOf(cut3e, 'cut-3e').routes, 'cut-3e')
    expect(await world.invoke(LAUNCH_ROW, launchParams(ANTIGRAVITY))).toEqual({
      ok: true,
      value: { launchId: WORLD_MINTED }
    })
    expect(world.hostCalls).toEqual([])
    expect(world.legacyServed.map(([channel]) => channel)).toEqual(['agent:launch'])
    world.dispose()
  })
})

// ADDED for ISSUE-235: the step-4a switch (21 §2 cut 4a; 14 §2.1 A-33, A-42, A-43, A-47, A-51…A-55, §5; 21 §1 items 1,
// 2, 2a, 3; §3, §3.1). The release table moves the Settings family to the Host with its target shape and no shape
// adapter (A-42, A-43, A-47, A-51 KEEP, A-52…A-55 and A-33 CHANGE), ends `ResetFanout`, `SettingsMirrorBridge` and
// `JevSettingsShapeAdapter`, and switches today's OpenCode plugin half off (the Host is the one writer of the plugin
// file and the one answerer of its asks), while OpenCode's launch, send, stop and console rows and A-27, A-P3, A-P4 stay
// `legacy` until 4b. RED is the 3e table (`testing/cut3eRoutes.ts`). AMENDED for ISSUE-238 (was: the release table
// `routesForBuild`, `ROUTES_RELEASE` and `RETIRED`): from the step-4b switch the 4a table as it shipped is
// `testing/cut4aRoutes.ts`.
describe('release 4a (21 §2 cut 4a)', () => {
  const [, CODEX = '', , OPENCODE = ''] = CATALOG_PROVIDER_IDS
  const DEVELOPMENT = cut4aRoutesForBuild({ publicBuild: false })
  const PUBLIC = cut4aRoutesForBuild({ publicBuild: true })
  const tableOf = (routes: readonly ChannelRoute[]): RouteTable => ({
    release: CUT_4A_RELEASE,
    routes,
    unrouted: UNROUTED,
    retired: CUT_4A_RETIRED,
    adapters: ADAPTERS_AS_SHIPPED
  })
  const cut4a = tableOf(DEVELOPMENT)
  const routeOf = (key: ChannelKey): ChannelRoute[] => DEVELOPMENT.filter((r) => r.channel === key)
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const REQUEST = '01920000-0000-7000-a000-000000000235'
  /** The rows 4a moves to the Host (21 §2 cut 4a "New core serves" H). */
  const SETTINGS_ROWS: readonly ChannelKey[] = [
    'notifications:enabled:get', // A-42
    'notifications:enabled:set', // A-43
    'jev:settings:get', // A-47
    'jev:preferences:set', // A-51
    'opencode:settings:get', // A-52
    'opencode:plugin:set', // A-53
    'opencode:password:set', // A-54
    'opencode:password:clear', // A-55
    'metrics:reset' // A-33, the saga only
  ]
  const ENDED = ['ResetFanout', 'SettingsMirrorBridge', 'JevSettingsShapeAdapter']
  const NOT_MOVED_ROWS = ['dwarf:retire', 'agent:launchFailed', 'dwarf:sendText:settled'] as const

  const hostCut4a = (channel: ChannelKey): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-4a',
    parity: 'passed',
    shape: 'target'
  })

  /** The Host as the Settings rows reach it: B-M12, B-M13, B-M14, B-M15, recording each call. */
  function settingsHost() {
    const calls: Array<[string, unknown]> = []
    const call = (method: string, params: unknown): Promise<unknown> => {
      calls.push([method, params])
      if (method === 'preferences.get') {
        return Promise.resolve({
          preferences: {
            subagentDelegationOn: false,
            routingProfile: 'balanced',
            systemNotificationsOn: true
          },
          secrets: [
            { name: 'jev-key', configured: false },
            { name: 'opencode-password', configured: false }
          ],
          secretBackend: 'os-secret-store',
          integrations: [{ id: 'opencode-permissions', state: 'off', changedAt: 1 }],
          welcome: { due: false, legacyFound: [], offered: [] }
        })
      }
      if (method === 'preferences.resetMetrics') {
        return Promise.resolve({ outcome: 'reset', epoch: 3 })
      }
      return Promise.reject(new Error(`unexpected ${method}`))
    }
    const client = {
      call,
      state: () => ({ state: 'connected', hostVersion: '0.0.0-test', compat: false }),
      onStateChange: () => () => {},
      withUiConnection: <T>(work: (c: { call: typeof call }) => Promise<T>) => work({ call })
    }
    return {
      calls,
      client: client as unknown as NonNullable<Parameters<typeof composeJevKeyRows>[0]['client']>
    }
  }

  /** The Settings parts of the `host` target as the root composes them over `routes`. */
  function settingsParts(routes: readonly ChannelRoute[], release: StepId) {
    const { client, calls } = settingsHost()
    const jev = composeJevKeyRows({
      routes,
      release,
      client,
      migration: undefined,
      log: { record: () => {} },
      mintId: () => REQUEST
    })
    const parts = [
      composeSystemNotificationRows({ routes, client, mintId: () => REQUEST }),
      jev?.part,
      composeOpenCodeSettingsRows({ routes, client }),
      composeOpenCodePasswordRows({
        routes,
        release,
        client,
        migration: undefined,
        log: { record: () => {} },
        mintId: () => REQUEST
      })?.part,
      composeResetMetricsRow({ routes, client })
    ].filter((part) => part !== undefined)
    return { parts, calls, jev, client }
  }

  it('[ADR-001] in 4a A-42, A-43, A-47, A-51, A-52, A-53, A-54, A-55 and A-33 route host with no shape adapter', async () => {
    expect(CUT_4A_RELEASE).toBe('cut-4a')
    expect(checkRouteTable(cut4a, KEYS)).toEqual([])
    expect(checkRouteTable(tableOf(PUBLIC), KEYS)).toEqual([])
    for (const key of SETTINGS_ROWS) {
      expect(routeOf(key), key).toEqual([hostCut4a(key)])
      expect(
        PUBLIC.filter((r) => r.channel === key),
        key
      ).toEqual([hostCut4a(key)])
    }

    // Through the root's compositions: every row is a part of the `host` target, and A-33 runs the Host saga alone.
    const { parts, calls } = settingsParts(DEVELOPMENT, CUT_4A_RELEASE)
    const served = parts.flatMap((part) => part.channels)
    expect(served.filter((key) => SETTINGS_ROWS.includes(key)).sort()).toEqual(
      [...SETTINGS_ROWS].sort()
    )
    const router = createRouter({
      routes: DEVELOPMENT.filter((r) => SETTINGS_ROWS.includes(r.channel)),
      legacy: { serve: () => Promise.reject(new Error('no legacy Settings row from 4a')) },
      host: composeRouteTargets(parts),
      senders
    })
    const reset = await router.dispatch('metrics:reset', FROM_PANEL as never, {
      confirmed: 'yes',
      requestId: REQUEST
    })
    expect(CHANNELS['metrics:reset'].response.parse(reset)).toEqual({
      ok: true,
      value: { outcome: 'reset', epoch: 3 }
    })
    expect(calls).toEqual([['preferences.resetMetrics', { confirmed: 'yes', requestId: REQUEST }]])
  })

  // AMENDED for ISSUE-236, the 4a retirement (was: also `composeResetFanout`, `settingsMirrorComposed` and the Jev
  // composition's shape adapters, over the 4a and the 3e tables): the three bridges left the tree, and
  // `describe('after the 4a retirement')` pins their absence from the listing.
  it('[ADR-001] in 4a ResetFanout, SettingsMirrorBridge and JevSettingsShapeAdapter are no longer composed', () => {
    for (const table of [DEVELOPMENT, PUBLIC]) {
      expect(
        table.filter((r) => r.shapeAdapter !== undefined && ENDED.includes(r.shapeAdapter))
      ).toEqual([])
    }
  })

  it('[ADR-001] in 4a the OpenCode plugin asks are not under the legacy-ask-channel qualifier, which covers only person-launched Codex questions', () => {
    // 21 §2 cut 4a: the Host's plugin channel answers the OpenCode plugin asks, of legacy-launched sessions too; today's
    // plugin installer and the OpenCode route of its loopback listener are not composed, so no OpenCode ask reaches
    // `LegacyAskRelay`. The `legacy-ask-channel` route stays for the person-launched Codex questions only.
    expect(legacyOpenCodePluginComposed(DEVELOPMENT)).toBe(false)
    expect(legacyOpenCodePluginComposed(PUBLIC)).toBe(false)
    expect(legacyOpenCodePluginComposed(CUT_3E_ROUTES)).toBe(true)
    for (const key of ['agent:answerQuestion', 'agent:answerPermission'] as const) {
      expect(
        routeOf(key).map((r) => r.qualifier?.origin ?? 'host'),
        key
      ).toEqual(['host', 'legacy-launch', 'legacy-ask-channel'])
    }
    expect(legacyFeedModesOf(DEVELOPMENT)).toMatchObject({
      [CODEX]: 'legacy-launched-or-pending-questions'
    })
  })

  it('[ADR-001] in 4a the OpenCode launch, send, stop, console rows and A-27, A-P3, A-P4 still route legacy for OpenCode', () => {
    expect(CUT_4A_RELEASE).toBe('cut-4a')
    for (const table of [DEVELOPMENT, PUBLIC]) {
      for (const key of ['dwarf:activate', 'dwarf:sendText', 'agent:launch'] as const) {
        expect(resolveRoute(table, key, { provider: OPENCODE }), key).toEqual({
          channel: key,
          owner: 'legacy',
          since: 'cut-3a',
          parity: 'n/a',
          shape: 'target',
          shapeAdapter: 'PerProviderShapeAdapter'
        })
      }
      expect(resolveRoute(table, 'agent:providers', { provider: OPENCODE })?.shapeAdapter).toBe(
        'CatalogMergeAdapter'
      )
      for (const key of NOT_MOVED_ROWS) {
        expect(
          table.filter((r) => r.channel === key),
          key
        ).toEqual([
          {
            channel: key,
            owner: 'legacy',
            since: 'cut-3a',
            parity: 'n/a',
            qualifier: { provider: OPENCODE },
            shape: 'today'
          }
        ])
      }
      // A-N29 ends a legacy-launched OpenCode session through `LegacyEndFirstAdapter` (one `host` route since 3a).
      expect(resolveRoute(table, 'dwarf:stop', { provider: OPENCODE })?.owner).toBe('host')
      expect(legacyFeedModesOf(table)).toMatchObject({ [OPENCODE]: 'discover' })
    }
  })

  it('[ADR-001] in 4a every host route uses only seam-B members born by 4a and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of DEVELOPMENT.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at(CUT_4A_RELEASE)
        )
      }
    }
    const moved = DEVELOPMENT.filter((r) => r.since === 'cut-4a')
    expect(moved.map((r) => r.channel).sort()).toEqual([...SETTINGS_ROWS].sort())
    // B-M14 is born in 4a (21 §2 "Seam B members" row 4a); no NEW row is, so the unrouted list is 3e's.
    expect(
      Object.entries(SEAM_B_METHODS_BORN)
        .filter(([, step]) => step === 'cut-4a')
        .map(([method]) => method)
    ).toEqual(['preferences.setOpenCodePermissions'])
    expect(UNROUTED).toEqual({ 'host:connection:confirm-restart': 'generation-2' })
  })

  // AMENDED for ISSUE-236, the 4a retirement (was: "a 4a rollback build routes A-33, A-42, A-43, A-47 and A-51 as 3e
  // did and keeps A-52…A-55 on the Host"): today's settings handlers and the adapters that rollback routed A-33 and
  // A-47 through left the tree, so 4a rolls forward only (21 §2.1 item 4; docs/strangler/rollback.md).
  it('[ADR-001] a 4a rollback build is refused since the 4a retirement: 4a rolls forward only', () => {
    expect(CUT_4A_RELEASE).toBe('cut-4a')
    for (const table of [cut4a, tableOf(PUBLIC)]) {
      expect(() => rollbackOf(table, 'cut-4a')).toThrow(/cut-4a rolls forward only/)
    }
  })
})

// ADDED for ISSUE-238: the step-4b switch, the last provider step (21 §2 cut 4b; 14 §8 I-11; 21 §1 items 1, 2, 2a, 3,
// 4; §3, §3.1). OpenCode's launch (A-35 with its Retry path), catalog (A-36), send (A-23) and console (A-13) rows move to
// the Host qualified by provider as every provider step did (A-N29's one `host` route already serves every dwarf); no
// provider is left for `PerProviderShapeAdapter` or `CatalogMergeAdapter`, so the renderer's one catalog call reaches
// the Host itself; A-27, A-P3 and A-P4 have no provider qualifier left and are retired with no route. RED is the 4a
// table (`testing/cut4aRoutes.ts`).
describe('release 4b (21 §2 cut 4b)', () => {
  const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
  /** The "Other…" driver's provider id (15 §3 H1 `HostedCommandDriver`), outside the catalog (INV-43). */
  const OTHER = 'other'
  const DEVELOPMENT = routesForBuild({ publicBuild: false })
  const PUBLIC = routesForBuild({ publicBuild: true })
  const tableOf = (routes: readonly ChannelRoute[]): RouteTable => ({
    release: ROUTES_RELEASE,
    routes,
    unrouted: UNROUTED,
    retired: RETIRED,
    adapters: LEGACY_BRIDGE_ADAPTERS
  })
  const cut4b = tableOf(DEVELOPMENT)
  const routeOf = (key: ChannelKey): ChannelRoute[] => DEVELOPMENT.filter((r) => r.channel === key)
  const REQUEST = '01920000-0000-7000-a000-000000000238'
  const MESSAGE = '01920000-0000-7000-8000-0000000238b1'
  const LAUNCH = '01920000-0000-7000-8000-0000000238c1'
  const FAILED_LAUNCH = '01920000-0000-7000-8000-0000000238c2'
  const OPENCODE_DWARF = '01920000-0000-7000-9000-000000000238'
  const ACTIVATE: ChannelKey = 'dwarf:activate' // A-13
  const SEND: ChannelKey = 'dwarf:sendText' // A-23
  const LAUNCH_ROW: ChannelKey = 'agent:launch' // A-35
  const PROVIDERS: ChannelKey = 'agent:providers' // A-36
  const STOP: ChannelKey = 'dwarf:stop' // A-N29
  const CUSTOM: ChannelKey = 'agent:launchHosted' // A-39
  const RETIRED_IN_4B = ['dwarf:retire', 'agent:launchFailed', 'dwarf:sendText:settled'] as const
  const SHAPE_ADAPTERS = ['PerProviderShapeAdapter', 'CatalogMergeAdapter']

  const hostFor = (channel: ChannelKey, provider: string, since: StepId): ChannelRoute => ({
    channel,
    owner: 'host',
    since,
    parity: 'passed',
    qualifier: { provider },
    shape: 'target'
  })
  const hostCut4b = (channel: ChannelKey): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-4b',
    parity: 'passed',
    shape: 'target'
  })

  /** The rows as the root composes them over `table`, one Host-launched OpenCode dwarf on the Host board. */
  const step4bWorld = (
    table: readonly ChannelRoute[] = DEVELOPMENT,
    release: StepId = ROUTES_RELEASE
  ) =>
    providerRowsWorld({
      table,
      release,
      dwarfs: [dwarfWire(OPENCODE_DWARF, OPENCODE, true)],
      hostReplies: {
        'launching.launch': { launchId: LAUNCH },
        'conversation.send': { ok: true, value: { messageId: MESSAGE } },
        'conversation.resolveConsole': {
          mode: 'log',
          command: { program: 'tail', args: [], cwd: '/w' }
        },
        'suppliers.launchable': [
          hostEntry(CLAUDE),
          hostEntry(CODEX),
          hostEntry(ANTIGRAVITY, 'gated'),
          hostEntry(OPENCODE)
        ],
        'crew.stop': { ok: true, value: {} }
      },
      today: {
        'agent:launch': { launched: true, provider: OPENCODE, launchId: 'receipt:1' },
        'agent:providers': {
          providers: [{ provider: OPENCODE, installed: true, launchable: true }]
        },
        'dwarf:sendText': { delivered: true, via: 'terminal' },
        'dwarf:activate': { focused: true, openedTerminal: false }
      }
    })

  const launchParams = (way: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    mineId: WORLD_MINE,
    way,
    prompt: 'Map the build',
    jevOn: way['kind'] === 'jev',
    jevAutoAccept: false,
    requestId: REQUEST,
    ...extra
  })

  it('[ADR-001] in 4b A-35, A-36, A-23, A-13 and A-N29 route host with shape target for the OpenCode qualifier', async () => {
    expect(ROUTES_RELEASE).toBe('cut-4b')
    expect(checkRouteTable(cut4b, KEYS)).toEqual([])
    expect(checkRouteTable(tableOf(PUBLIC), KEYS)).toEqual([])
    // One owner per (channel, qualifier) (21 §1 item 2): the Host for every provider, OpenCode's routes born in 4b.
    for (const key of [ACTIVATE, SEND]) {
      expect(routeOf(key), key).toEqual([
        hostFor(key, CLAUDE, 'cut-3a'),
        hostFor(key, CODEX, 'cut-3b'),
        hostFor(key, OTHER, 'cut-3d'),
        hostFor(key, ANTIGRAVITY, 'cut-3e'),
        hostFor(key, OPENCODE, 'cut-4b'),
        hostCut4b(key)
      ])
    }
    expect(routeOf(LAUNCH_ROW)).toEqual([
      hostFor(LAUNCH_ROW, CLAUDE, 'cut-3a'),
      hostFor(LAUNCH_ROW, CODEX, 'cut-3b'),
      hostFor(LAUNCH_ROW, OTHER, 'cut-3d'),
      hostFor(LAUNCH_ROW, OPENCODE, 'cut-4b'),
      hostCut4b(LAUNCH_ROW),
      hostFor(LAUNCH_ROW, ANTIGRAVITY, 'cut-3e') // `DEVELOPMENT_BUILD_ROUTES`
    ])
    // A-36: each provider's entry is the Host's, and the renderer's one (unqualified) catalog call reaches the Host; the
    // unqualified routes of A-13, A-23, A-35 are the Host's too (no provider is left for the shape adapters).
    expect(routeOf(PROVIDERS)).toEqual([
      hostFor(PROVIDERS, CLAUDE, 'cut-3a'),
      hostFor(PROVIDERS, CODEX, 'cut-3b'),
      hostFor(PROVIDERS, ANTIGRAVITY, 'cut-3e'),
      hostFor(PROVIDERS, OPENCODE, 'cut-4b'),
      hostCut4b(PROVIDERS)
    ])
    for (const key of [ACTIVATE, SEND, LAUNCH_ROW, PROVIDERS]) {
      expect(resolveRoute(DEVELOPMENT, key, { provider: OPENCODE }), key).toEqual(
        key === PROVIDERS
          ? hostFor(PROVIDERS, OPENCODE, 'cut-4b')
          : hostFor(key, OPENCODE, 'cut-4b')
      )
    }
    for (const key of [ACTIVATE, SEND, LAUNCH_ROW, PROVIDERS]) {
      expect(resolveRoute(DEVELOPMENT, key), key).toEqual(hostCut4b(key))
    }
    expect(resolveRoute(DEVELOPMENT, STOP, { provider: OPENCODE })?.owner).toBe('host')

    // Through the root's composition: an OpenCode launch (and its Retry), send, console and stop reach the Host with the
    // renderer's payload unchanged, and the catalog is the Host's entries, today's catalog never read.
    const world = step4bWorld()
    expect(
      await world.invoke(LAUNCH_ROW, launchParams({ kind: 'supplier', providerId: OPENCODE }))
    ).toEqual({
      ok: true,
      value: { launchId: LAUNCH }
    })
    expect(
      await world.invoke(
        LAUNCH_ROW,
        launchParams({ kind: 'supplier', providerId: OPENCODE }, { retryOf: FAILED_LAUNCH })
      )
    ).toEqual({ ok: true, value: { launchId: LAUNCH } })
    expect(
      await world.invoke(SEND, {
        dwarfId: OPENCODE_DWARF,
        text: 'go on',
        attachments: [],
        requestId: REQUEST
      })
    ).toEqual({ ok: true, value: { ok: true, value: { messageId: MESSAGE } } })
    expect(
      await world.invoke(ACTIVATE, { dwarfId: OPENCODE_DWARF, purpose: 'open-console' })
    ).toEqual({
      ok: true,
      value: { outcome: 'opened', mode: 'log' }
    })
    expect(await world.invoke(STOP, { dwarfId: OPENCODE_DWARF, requestId: REQUEST })).toEqual({
      ok: true,
      value: { ok: true, value: {} }
    })
    const catalog = (await world.invoke(PROVIDERS, { refresh: true })) as {
      ok: boolean
      value: unknown[]
    }
    expect(CHANNELS[PROVIDERS].response.parse(catalog)).toEqual({
      ok: true,
      value: [
        hostEntry(CLAUDE),
        hostEntry(CODEX),
        hostEntry(ANTIGRAVITY, 'gated'),
        hostEntry(OPENCODE)
      ]
    })
    expect(world.hostCalls.map(([method]) => method)).toEqual([
      'launching.launch',
      'launching.launch',
      'conversation.send',
      'conversation.resolveConsole',
      'crew.stop',
      'suppliers.launchable'
    ])
    expect(world.hostCalls[0]?.[1]).toEqual(
      launchParams({ kind: 'supplier', providerId: OPENCODE })
    )
    expect(world.hostCalls[5]?.[1]).toEqual({ refresh: true })
    expect(world.legacyServed).toEqual([])
    world.dispose()
  })

  it('[ADR-001] in 4b no legacy launch, send or stop row remains for any provider', async () => {
    for (const table of [DEVELOPMENT, PUBLIC]) {
      // Every launch, catalog, send, console, stop and "Other…" route is the Host's, with its target shape.
      for (const key of [ACTIVATE, SEND, LAUNCH_ROW, PROVIDERS, STOP, CUSTOM]) {
        const own = table.filter((r) => r.channel === key)
        expect(own.length, key).toBeGreaterThan(0)
        for (const route of own) {
          expect(route.owner, `${key} ${route.qualifier?.provider ?? '*'}`).toBe('host')
          expect(route.shape, key).toBe('target')
        }
        // Every provider, one no route names and none at all: the Host (a public build's gated provider included,
        // whose launch its Host refuses, ADR-009 D6: no gated driver in a public build).
        for (const provider of [...CATALOG_PROVIDER_IDS, OTHER, 'not-a-provider']) {
          expect(resolveRoute(table, key, { provider })?.owner, `${key} ${provider}`).toBe('host')
        }
        expect(resolveRoute(table, key)?.owner, key).toBe('host')
      }
      // No route names a per-provider shape adapter: no provider is left for it (21 §3.1).
      expect(
        table.filter((r) => r.shapeAdapter !== undefined && SHAPE_ADAPTERS.includes(r.shapeAdapter))
      ).toEqual([])
      // A-27, A-P3 and A-P4: no provider qualifier left, so no route and no handler (21 §2 cut 4b "Parity / exit").
      for (const key of RETIRED_IN_4B) {
        expect(
          table.filter((r) => r.channel === key),
          key
        ).toEqual([])
        expect(RETIRED[key], key).toBe('cut-4b')
      }
      // The legacy feed keeps only the sessions today's runtime launched, for `LegacyEndFirstAdapter` until ISSUE-241.
      expect(legacyFeedModesOf(table)).toEqual({
        [CLAUDE]: 'legacy-launched',
        [CODEX]: 'legacy-launched-or-pending-questions',
        [ANTIGRAVITY]: 'legacy-launched',
        [OPENCODE]: 'legacy-launched'
      })
      // The Host is the one answerer of the OpenCode asks since 4a; today's plugin half stays off.
      expect(legacyOpenCodePluginComposed(table)).toBe(false)
    }
    // The root composes neither shape adapter nor their settlement join.
    const legacy = {
      serve: () => Promise.reject(new Error('no legacy launch, send or stop row in 4b'))
    }
    expect(
      composeProviderShapeAdapters({
        routes: DEVELOPMENT,
        release: ROUTES_RELEASE,
        legacy,
        models: { read: () => Promise.resolve({ catalogs: [] }) },
        client: undefined,
        mintId: () => REQUEST
      })
    ).toBeUndefined()
    expect(composeSettlementJoin({ routes: DEVELOPMENT, release: ROUTES_RELEASE })).toBeUndefined()

    // "Let Jev choose" reaches the Host, whose candidates are every launchable provider (the narrowing ends).
    const world = step4bWorld()
    expect(await world.invoke(LAUNCH_ROW, launchParams({ kind: 'jev' }))).toEqual({
      ok: true,
      value: { launchId: LAUNCH }
    })
    expect(world.hostCalls.map(([method]) => method)).toEqual(['launching.launch'])
    expect(world.legacyServed).toEqual([])
    world.dispose()
  })

  it('[ADR-001] in 4b every host route uses only seam-B members born by 4b and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of DEVELOPMENT.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).toBe('passed')
      const members = HOST_ROUTE_MEMBERS[route.channel]
      expect(members, `${route.channel} names the seam B members it relays`).toBeDefined()
      for (const member of members ?? []) {
        const born = SEAM_B_METHODS_BORN[member]
        expect(born, `${member} has a birth release`).toBeDefined()
        expect(at(born ?? 'generation-2'), `${route.channel} → ${member}`).toBeLessThanOrEqual(
          at(ROUTES_RELEASE)
        )
      }
    }
    // The routes 4b moved: OpenCode's A-13, A-23, A-35, A-36, and their unqualified routes.
    const moved = DEVELOPMENT.filter((r) => r.since === 'cut-4b')
    expect(moved.map((r) => `${r.channel} ${r.qualifier?.provider ?? '*'}`).sort()).toEqual(
      [ACTIVATE, SEND, LAUNCH_ROW, PROVIDERS]
        .flatMap((key) => [`${key} ${OPENCODE}`, `${key} *`])
        .sort()
    )
    // No seam B member and no NEW row is born in 4b (21 §2 seam-B table row 4b), so the unrouted list is 4a's.
    expect(Object.values(SEAM_B_METHODS_BORN).filter((step) => step === 'cut-4b')).toEqual([])
    expect(UNROUTED).toEqual({ 'host:connection:confirm-restart': 'generation-2' })
  })

  it('[ADR-001] a 4b rollback build routes every OpenCode row as the 4a table did', async () => {
    // 21 §2 cut 4b "Rollback", §2.1 item 1: before the 4b deletion commits (ISSUE-239…ISSUE-241) the OpenCode rows flip
    // back to `legacy`, in either build: OpenCode reaches the shape adapters again and gets its A-27, A-P3, A-P4 rows
    // back. The rows 4a moved keep their routes (only forward fixes after 4a's own deletion).
    const order = (routes: readonly ChannelRoute[]) =>
      routes.map((route) => JSON.stringify(route)).sort()
    for (const [table, before] of [
      [cut4b, CUT_4A_ROUTES],
      [tableOf(PUBLIC), cut4aRoutesForBuild({ publicBuild: true })]
    ] as const) {
      const rolledBack = rollbackOf(table, 'cut-4b')
      expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
      expect(order(rolledBack.routes)).toEqual(order(before))
      expect(rolledBack.retired).toEqual(CUT_4A_RETIRED)
    }
    const world = step4bWorld(rollbackOf(cut4b, 'cut-4b').routes, 'cut-4b')
    expect(
      await world.invoke(LAUNCH_ROW, launchParams({ kind: 'supplier', providerId: OPENCODE }))
    ).toEqual({
      ok: true,
      value: { launchId: WORLD_MINTED }
    })
    expect(world.hostCalls).toEqual([])
    expect(world.legacyServed.map(([channel]) => channel)).toEqual(['agent:launch'])
    world.dispose()
  })
})

// TC-178-03 (21 §2 step 3a, §3 row `LegacyEndFirstAdapter`; 14 §5): A-N29 is a `host` row born in 3a, and in every 3a
// release the relay that ends a legacy-launched session first (the adapter's `beforeStopDwarf`, ISSUE-178) lives
// beside it. The route row and the root's composition of the adapter on it are the step-3a switch's (later: ISSUE-001),
// which shares this case.
describe('step 3a A-N29 (21 §2 step 3a)', () => {
  it('[ADR-001] in 3a A-N29 composes LegacyEndFirstAdapter for legacy-launched sessions', () => {
    const STOP_DWARF: ChannelKey = 'dwarf:stop'
    expect(CHANNELS[STOP_DWARF].status).toBe('new')
    expect(CHANNELS[STOP_DWARF].placement).toBe('host')
    // Unrouted until the step-3a switch routes it. AMENDED for ISSUE-001 (was: `UNROUTED[STOP_DWARF]`, the release's
    // list): the switch routed it, so the cut-2 table as it shipped still lists it, and the release table routes it.
    expect(CUT_2_UNROUTED[STOP_DWARF]).toBe('cut-3a')
    expect(UNROUTED[STOP_DWARF]).toBeUndefined()

    // A 3a table routing A-N29 `host` passes the router test, and lists LegacyEndFirstAdapter as living in it.
    const cut3a: RouteTable = { ...routedBase, release: 'cut-3a' }
    expect(cut3a.routes.filter((r) => r.channel === STOP_DWARF)).toEqual([
      { channel: STOP_DWARF, owner: 'host', since: 'cut-3a', parity: 'passed', shape: 'target' }
    ])
    expect(reasons(cut3a).filter((reason) => reason.endsWith(STOP_DWARF))).toEqual([])
    const endFirst = cut3a.adapters.find((a) => a.name === 'LegacyEndFirstAdapter')
    expect(endFirst?.cuts).toContain('cut-3a')
    expect(endFirst?.shapeAdapter).toBe(false)
    // It lives with A-N29 through every step of cut 3 and of cut 4, and is gone in cut 5 with LegacyDwarfIdBridge.
    for (const step of ['cut-3a', 'cut-3b', 'cut-3d', 'cut-3e', 'cut-4a', 'cut-4b'] as const)
      expect(endFirst?.cuts, step).toContain(step)
    expect(endFirst?.cuts).not.toContain('cut-5')
    expect(endFirst?.cuts.at(-1)).toBe(
      LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'LegacyDwarfIdBridge')?.cuts.at(-1)
    )
  })
})

// ADDED for ISSUE-177: the two per-provider shape adapters of steps 3a–4b (21 §3.1). The route rows that name them are
// the step switches' (later: ISSUE-001, ISSUE-002, ISSUE-186, ISSUE-188); these cases drive a 3a table built here, with
// Claude moved and the other providers still launched by today's runtime.
describe('shape adapters (21 §3.1)', () => {
  const SRC = resolve(import.meta.dirname, '../..')
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const MINE = '01920000-0000-7000-8000-000000000177'
  const REQUEST = '01920000-0000-7000-a000-000000000177'
  const MINTED = '01920000-0000-7000-8000-0000000001a1'
  const PER_PROVIDER = 'PerProviderShapeAdapter'
  const CATALOG_MERGE = 'CatalogMergeAdapter'
  const PROVIDER_ROWS: ChannelKey[] = ['dwarf:activate', 'dwarf:sendText', 'agent:launch']
  const PROVIDERS: ChannelKey = 'agent:providers' // A-36
  const MODELS: ChannelKey = 'agent:models' // A-37
  const shapeRows: ChannelKey[] = [...PROVIDER_ROWS, PROVIDERS, MODELS]

  const hostFor = (channel: ChannelKey, provider: string): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-3a',
    parity: 'passed',
    qualifier: { provider },
    shape: 'target'
  })
  const legacyThrough = (
    channel: ChannelKey,
    adapter: string,
    provider?: string
  ): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    ...(provider === undefined ? {} : { qualifier: { provider } }),
    shape: 'target',
    shapeAdapter: adapter
  })

  /** A 3a table: Claude's rows on the Host, Codex's through the shape adapters, A-36 merged, A-37 retired. */
  const cut3a: RouteTable = {
    ...routedBase,
    release: 'cut-3a',
    routes: [
      ...routedBase.routes.filter((r) => !shapeRows.includes(r.channel)),
      ...PROVIDER_ROWS.flatMap((channel) => [
        hostFor(channel, 'claude'),
        legacyThrough(channel, PER_PROVIDER, 'codex')
      ]),
      hostFor(PROVIDERS, 'claude'),
      legacyThrough(PROVIDERS, CATALOG_MERGE)
    ],
    retired: { [MODELS]: 'cut-3a' }
  }

  const HOST_CLAUDE = {
    providerId: 'claude',
    label: 'Claude Code',
    models: [{ value: 'opus', efforts: ['high'] }],
    permissionModes: ['default'],
    offeredModes: ['default'],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available'
  }

  /** The root's composition over `table`, with today's runtime and the Host recording what reaches them. */
  function shapeWorld(table: readonly ChannelRoute[]) {
    const legacyServed: Array<[string, unknown]> = []
    const hostCalls: Array<[string, unknown]> = []
    const today: Record<string, unknown> = {
      'agent:launch': { launched: true, provider: 'codex', launchId: 'receipt:1' },
      'agent:providers': {
        providers: [
          { provider: 'claude', installed: true, launchable: true },
          { provider: 'codex', installed: true, launchable: true },
          { provider: 'antigravity', installed: false, launchable: false },
          { provider: 'opencode', installed: true, launchable: true }
        ]
      }
    }
    const legacy = {
      serve: (channel: string, payload: unknown) => {
        legacyServed.push([channel, payload])
        return Promise.resolve(today[channel])
      }
    }
    const client = {
      call: (method: string, params: unknown) => {
        hostCalls.push([method, params])
        // The Host lists Codex too (its driver may be offered later): never a second Codex entry.
        return Promise.resolve([
          HOST_CLAUDE,
          { ...HOST_CLAUDE, providerId: 'codex', label: 'Codex' }
        ])
      }
    }
    const adapters = composeProviderShapeAdapters({
      routes: table,
      release: 'cut-3a',
      legacy,
      models: {
        read: () =>
          Promise.resolve({
            catalogs: [
              {
                provider: 'codex',
                models: [{ value: 'gpt-5-codex', effortLevels: ['high'] }],
                efforts: [],
                source: 'history'
              }
            ]
          })
      },
      client: client as unknown as Parameters<typeof composeProviderShapeAdapters>[0]['client'],
      mintId: () => MINTED
    })
    const router = createRouter({
      routes: table.filter((r) => shapeRows.includes(r.channel)),
      legacy,
      host: { serve: () => Promise.reject(new Error('the Host route is not under test')) },
      ...(adapters === undefined ? {} : { shapeAdapters: adapters }),
      senders
    })
    return { adapters, router, legacyServed, hostCalls }
  }

  /** Every production source under src/ (no test, contract, testing or fixture file), as [path, text]. */
  function productionSources(): Array<[string, string]> {
    const walk = (folder: string): string[] =>
      readdirSync(resolve(SRC, folder), { withFileTypes: true }).flatMap((entry) => {
        const relative = folder === '' ? entry.name : `${folder}/${entry.name}`
        if (entry.isDirectory()) {
          return ['node_modules', 'testing', 'fixtures'].includes(entry.name) ? [] : walk(relative)
        }
        return /\.(ts|mts|vue)$/.test(entry.name) && !/\.(test|contract)\.ts$/.test(entry.name)
          ? [relative]
          : []
      })
    return walk('').map((path): [string, string] => [
      path,
      readFileSync(resolve(SRC, path), 'utf8')
    ])
  }

  it('[ADR-001] catalog merge answers one entry per provider, moved ones from the Host and the others from the legacy catalog, each a valid SupplierEntryView', async () => {
    const world = shapeWorld(cut3a.routes)
    const answer = (await world.router.dispatch(PROVIDERS, FROM_PANEL as never, {})) as {
      ok: boolean
      value: Array<{ providerId: string; label: string; models: unknown[] }>
    }

    expect(answer.ok).toBe(true)
    // One entry per provider: Claude from the Host, Codex and OpenCode converted from today's list; Antigravity is
    // not launchable today, so it is absent.
    expect(answer.value.map((entry) => entry.providerId)).toEqual(['claude', 'codex', 'opencode'])
    expect(answer.value[0]).toEqual(HOST_CLAUDE)
    expect(answer.value[1]?.label).toBe('Codex CLI')
    expect(answer.value[1]?.models).toEqual([{ value: 'gpt-5-codex', efforts: ['high'] }])
    for (const entry of answer.value) {
      expect(supplierEntryViewSchema.safeParse(entry).success, entry.providerId).toBe(true)
    }
    expect(world.hostCalls).toEqual([['suppliers.launchable', {}]])
    // A-37 is never reached: the catalog is read inside the adapter.
    expect(world.legacyServed.map(([channel]) => channel)).toEqual(['agent:providers'])
  })

  it('[ADR-001] a legacy route with shape target for A-13, A-23 or A-35 names PerProviderShapeAdapter, and one for A-36 names CatalogMergeAdapter', async () => {
    expect(
      reasons(cut3a).filter((reason) => shapeRows.some((row) => reason.endsWith(row)))
    ).toEqual([])
    for (const route of cut3a.routes.filter(
      (r) => r.owner === 'legacy' && r.shape === 'target' && shapeRows.includes(r.channel)
    )) {
      expect(route.shapeAdapter, route.channel).toBe(
        route.channel === PROVIDERS ? CATALOG_MERGE : PER_PROVIDER
      )
    }
    const world = shapeWorld(cut3a.routes)
    expect(Object.keys(world.adapters ?? {}).sort()).toEqual([CATALOG_MERGE, PER_PROVIDER])

    // A Codex launch in the target shape reaches today's launch and answers LaunchAccepted.
    const launch = {
      mineId: MINE,
      way: { kind: 'supplier', providerId: 'codex' },
      prompt: 'Map the build',
      jevOn: false,
      jevAutoAccept: false,
      requestId: REQUEST
    }
    expect(
      await world.router.dispatch('agent:launch', FROM_PANEL as never, launch, {
        provider: 'codex'
      })
    ).toEqual({ ok: true, value: { launchId: MINTED } })
    expect(world.legacyServed).toEqual([
      ['agent:launch', { mineId: MINE, provider: 'codex', prompt: 'Map the build' }]
    ])

    // An adapter named for a row it does not convert stops the router from starting.
    for (const [channel, adapter] of [
      ['agent:launch', CATALOG_MERGE],
      [PROVIDERS, PER_PROVIDER]
    ] as const) {
      const wrong = withRoutes(cut3a, channel, legacyThrough(channel, adapter, 'codex')).routes
      expect(() => shapeWorld(wrong), `${channel} ${adapter}`).toThrow(
        `router: shape adapter ${adapter} does not serve ${channel}`
      )
    }
  })

  it('[ADR-001] both adapters are listed in the router test and composed only by src/ui-main/index.ts', () => {
    for (const name of [PER_PROVIDER, CATALOG_MERGE]) {
      const listed = LEGACY_BRIDGE_ADAPTERS.find((adapter) => adapter.name === name)
      expect(listed?.shapeAdapter, name).toBe(true)
      expect(listed?.cuts, name).toEqual([
        'cut-3a',
        'cut-3b',
        'cut-3d',
        'cut-3e',
        'cut-4a',
        'cut-4b'
      ])
    }
    const inert = {
      legacy: { serve: () => Promise.resolve(undefined) },
      models: { read: () => Promise.resolve(undefined) },
      client: undefined,
      mintId: () => MINTED
    }
    // Not composed by the cut-2 table, which names neither. AMENDED for ISSUE-001 (was: the release table, which named
    // neither before the step-3a switch; it names both from 3a, `describe('release 3a')`).
    expect(
      composeProviderShapeAdapters({ ...inert, routes: CUT_2_ROUTES, release: 'cut-2' })
    ).toBeUndefined()
    // Not composed in a release they do not live in, even where a table names them.
    for (const release of ['cut-2', 'cut-5'] as const) {
      expect(
        composeProviderShapeAdapters({ ...inert, routes: cut3a.routes, release }),
        release
      ).toBeUndefined()
    }
    const importers = productionSources().filter(([, text]) =>
      /from '[^']*legacy-bridge\/shape\//.test(text)
    )
    expect(importers.map(([path]) => path)).toEqual(['ui-main/index.ts'])
    expect(readFileSync(resolve(SRC, 'ui-main/index.ts'), 'utf8')).toMatch(
      /= composeProviderShapeAdapters\(\{/
    )
  })

  it('[R16] nothing outside src/ui-main/index.ts imports src/legacy-bridge', () => {
    const outside = productionSources().filter(
      ([path, text]) =>
        !path.startsWith('legacy-bridge/') && /(from|import\()\s*'[^']*legacy-bridge\//.test(text)
    )
    expect(outside.map(([path]) => path)).toEqual(['ui-main/index.ts'])
  })
})

// ADDED for ISSUE-217: the Jev key rows of step 3a (21 §2 cut 3a, §3 `SecretMigrationBridge`, §3.1
// `JevSettingsShapeAdapter`, §4 row "Jev API key"). The route rows are the step-3a switch's (later: ISSUE-001); these
// cases drive a 3a table built here, over a temp legacy `userData` holding today's encrypted Jev-key file.
describe('Jev key rows (21 §2 cut 3a)', () => {
  const MINTED = '01920000-0000-7000-a000-000000000217'
  const GET: ChannelKey = 'jev:settings:get' // A-47
  const SET: ChannelKey = 'jev:apiKey:set' // A-48
  const CLEAR: ChannelKey = 'jev:apiKey:clear' // A-49

  const hostRoute = (channel: ChannelKey): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-3a',
    parity: 'passed',
    shape: 'target'
  })
  /** A-47 through the adapter, A-48/A-49 `host`, as ISSUE-001's 3a rows will read. */
  const JEV_3A: ChannelRoute[] = [
    {
      channel: GET,
      owner: 'legacy',
      since: 'cut-3a',
      parity: 'n/a',
      shape: 'target',
      shapeAdapter: 'JevSettingsShapeAdapter'
    },
    hostRoute(SET),
    hostRoute(CLEAR)
  ]

  /** Electron's `safeStorage` as the bridge sees it: a reversible stand-in, never real cryptography. */
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (data: Buffer) => {
      const text = data.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not ciphertext')
      return text.slice('enc:'.length)
    }
  }

  /** The Host over an in-memory Jev key: B-M10, B-M11 and B-M12, recording each call. */
  function jevHost() {
    const calls: Array<[string, unknown]> = []
    let key: string | undefined
    const call = (method: string, params: unknown): Promise<unknown> => {
      calls.push([method, params])
      if (method === 'settings.secret.set') {
        key = (params as { value: string }).value
        return Promise.resolve({ ok: true, value: { name: 'jev-key', configured: true } })
      }
      if (method === 'settings.secret.clear') {
        key = undefined
        return Promise.resolve({ ok: true, value: { name: 'jev-key', configured: false } })
      }
      if (method === 'preferences.get') {
        return Promise.resolve({
          preferences: {},
          secrets: [{ name: 'jev-key', configured: key !== undefined }],
          secretBackend: 'os-secret-store',
          integrations: [],
          welcome: { due: false, legacyFound: [], offered: [] }
        })
      }
      return Promise.reject(new Error(`unexpected ${method}`))
    }
    const client = {
      call,
      state: () => ({ state: 'connected', hostVersion: '0.0.0-test', compat: false }),
      onStateChange: () => () => {},
      withUiConnection: <T>(work: (c: { call: typeof call }) => Promise<T>) => work({ call })
    }
    return {
      calls,
      key: () => key,
      client: client as unknown as Parameters<typeof composeJevKeyRows>[0]['client']
    }
  }

  // AMENDED for ISSUE-236, the 4a retirement (was: today's runtime answering A-47 through `JevSettingsShapeAdapter`, and
  // the case "in a 3a table the legacy Jev-key file moves to the Host once before A-47 answers, and A-48/A-49
  // round-trip through B-M10 and B-M11" over it): the adapter left the tree.

  // AMENDED for ISSUE-001 (was: "the release table composes no Jev key row…", over `ROUTES`): from the step-3a switch the
  // release table routes the Jev key rows (`describe('release 3a')`), so the table that composes none is cut 2's.
  it('[ADR-001] the cut-2 table composes no Jev key row and no migration; a release the adapters do not live in binds neither', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dwarfai-217-'))
    try {
      const base = {
        client: jevHost().client,
        migration: { userDataDir: userData, safeStorage },
        log: { record: () => {} },
        mintId: () => MINTED
      }
      expect(composeJevKeyRows({ ...base, routes: CUT_2_ROUTES, release: 'cut-2' })).toBeUndefined()
      const late = composeJevKeyRows({ ...base, routes: JEV_3A, release: 'cut-5' })
      expect(late?.migration).toBeUndefined()
      // Without the Host attach nothing is composed.
      expect(
        composeJevKeyRows({ ...base, client: undefined, routes: JEV_3A, release: 'cut-3a' })
      ).toBeUndefined()
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })
})

// ADDED for ISSUE-192: A-50 `routeJevLaunch` relayed to B-M38 `jev.suggest` where the table routes it `host`. The route
// row is the step-3a switch's (later: ISSUE-001); these cases drive a 3a row built here.
describe('Jev suggestion row (21 §2 cut 3a)', () => {
  const SRC = resolve(import.meta.dirname, '../..')
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const MINE = '01920000-0000-7000-9000-0000000000f1'
  const A_50: ChannelRoute = {
    channel: 'jev:route',
    owner: 'host',
    since: 'cut-3a',
    parity: 'passed',
    shape: 'target'
  }

  it('[US-LAUNCH-003.AC02] where the table routes A-50 host, routeJevLaunch relays jev.suggest and the renderer gets its result unchanged', async () => {
    const sent: Array<[string, unknown]> = []
    const suggestion = {
      ok: true,
      value: {
        providerId: 'claude',
        model: 'sonnet',
        tier: 'balanced',
        confidence: { providerId: 0.9 },
        truncated: false,
        parts: { providerId: 'answered', model: 'answered', tier: 'answered' }
      }
    }
    const client = {
      call: (method: string, params: unknown) => {
        sent.push([method, params])
        return Promise.resolve(suggestion)
      }
    } as unknown as Parameters<typeof composeJevRouteRow>[0]['client']

    const rows = composeJevRouteRow({ routes: [A_50], client })
    expect(rows?.channels).toEqual(['jev:route'])
    const router = createRouter({
      routes: [A_50],
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(rows === undefined ? {} : { host: rows.target }),
      senders
    })
    const request = { prompt: 'add a field to this form', mineId: MINE }
    expect(await router.dispatch('jev:route', FROM_PANEL, request)).toEqual({
      ok: true,
      value: suggestion
    })
    expect(sent).toEqual([['jev.suggest', request]])
  })

  // AMENDED for ISSUE-001 (was: "the release table and the cut tables…", over `ROUTES`): the step-3a switch routes A-50
  // `host` in the release table (`describe('release 3a')`); the earlier cut tables compose none.
  it('[ADR-001] the cut tables before 3a compose no Jev suggestion row: A-50 stays legacy until the step-3a switch', () => {
    const client = {
      call: () => Promise.reject(new Error('never called'))
    } as unknown as Parameters<typeof composeJevRouteRow>[0]['client']
    for (const routes of [CUT_2_ROUTES, CUT_1_ROUTES, CUT_0_ROUTES]) {
      expect(composeJevRouteRow({ routes, client })).toBeUndefined()
    }
    expect(readFileSync(resolve(SRC, 'ui-main/index.ts'), 'utf8')).toMatch(
      /composeJevRouteRow\(\{ routes, client: host\.client \}\)/
    )
  })
})

// ADDED for ISSUE-228: A-52 and A-53 are CHANGE rows the step-4a switch routes `host` (ISSUE-235, 22 §5); until then
// today's handlers serve them. These cases drive a table built here with both rows routed `host`.
describe('step 4a A-52 and A-53 (21 §2 step 4a)', () => {
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const REQUEST = '01920000-0000-7000-a000-000000000228'
  const ROWS: ChannelKey[] = ['opencode:settings:get', 'opencode:plugin:set']

  it('[ADR-001, ADR-011] the root composes the A-52/A-53 host handlers only where the table routes them host, relaying preferences.get and preferences.setOpenCodePermissions', async () => {
    const sent: Array<[string, unknown]> = []
    const client = {
      call: (method: string, params: unknown) => {
        sent.push([method, params])
        return Promise.resolve(
          method === 'preferences.get'
            ? {
                preferences: { subagentDelegationOn: false, routingProfile: 'balanced' },
                secrets: [{ name: 'opencode-password', configured: false }],
                secretBackend: 'os-secret-store',
                integrations: [{ id: 'opencode-permissions', state: 'off', changedAt: 1 }],
                welcome: { due: false, legacyFound: [], offered: [] }
              }
            : { ok: true, value: { state: 'on-verified' } }
        )
      }
    } as unknown as Parameters<typeof composeOpenCodeSettingsRows>[0]['client']

    // Today's table keeps them `legacy` with today's shape: the root composes nothing for them.
    // AMENDED for ISSUE-235 (was: the release table `ROUTES`): the step-4a switch routes them `host`, so the table
    // that keeps them `legacy` is the 3e table as it shipped (`testing/cut3eRoutes.ts`).
    for (const key of ROWS) {
      expect(
        CUT_3E_ROUTES.filter((r) => r.channel === key).map((r) => [r.owner, r.shape]),
        key
      ).toEqual([['legacy', 'today']])
    }
    expect(composeOpenCodeSettingsRows({ routes: CUT_3E_ROUTES, client })).toBeUndefined()

    const switched: ChannelRoute[] = ROWS.map((channel) => ({
      channel,
      owner: 'host',
      since: 'cut-4a',
      parity: 'pending',
      shape: 'target'
    }))
    const rows = composeOpenCodeSettingsRows({ routes: switched, client })
    expect(rows?.channels).toEqual(ROWS)
    const router = createRouter({
      routes: switched,
      legacy: { serve: () => Promise.reject(new Error('never legacy')) },
      ...(rows === undefined ? {} : { host: rows.target }),
      senders
    })
    const get = await router.dispatch('opencode:settings:get', FROM_PANEL, undefined)
    expect(CHANNELS['opencode:settings:get'].response.safeParse(get).success).toBe(true)
    expect(get).toEqual({
      ok: true,
      value: { permissions: 'off', passwordConfigured: false, secretBackend: 'os-secret-store' }
    })
    const set = await router.dispatch('opencode:plugin:set', FROM_PANEL, {
      on: true,
      origin: 'add-panel',
      requestId: REQUEST
    })
    expect(CHANNELS['opencode:plugin:set'].response.safeParse(set).success).toBe(true)
    expect(set).toEqual({ ok: true, value: { ok: true, value: { state: 'on-verified' } } })
    expect(sent).toEqual([
      ['preferences.get', {}],
      ['preferences.setOpenCodePermissions', { on: true, origin: 'add-panel', requestId: REQUEST }]
    ])
  })
})

// ADDED for ISSUE-231: the OpenCode server password rows of step 4a (21 §2 cut 4a, §3 `SecretMigrationBridge`, §4 row
// "OpenCode server password"). The route rows are the step-4a switch's (later: ISSUE-235); these cases drive a 4a table
// built here, over a temp legacy `userData` holding today's encrypted password file.
describe('OpenCode server password rows (21 §2 cut 4a)', () => {
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const PASSWORD = ' migrated pass 0231 '
  const TYPED = 'typed-pass-4a-0231'
  const MINTED = '01920000-0000-7000-a000-000000000231'
  const PASSWORD_FILE = 'opencode-server-password-v1.json'
  const SET: ChannelKey = 'opencode:password:set' // A-54
  const CLEAR: ChannelKey = 'opencode:password:clear' // A-55

  const hostRoute = (channel: ChannelKey): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-4a',
    parity: 'passed',
    shape: 'target'
  })
  /** A-54/A-55 `host`, as ISSUE-235's 4a rows will read. */
  const PASSWORD_4A: ChannelRoute[] = [hostRoute(SET), hostRoute(CLEAR)]

  /** Electron's `safeStorage` as the bridge sees it: a reversible stand-in, never real cryptography. */
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (data: Buffer) => {
      const text = data.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not ciphertext')
      return text.slice('enc:'.length)
    }
  }

  /** The Host over an in-memory password: B-M10, B-M11 and B-M12, recording each call. */
  function passwordHost(backend: 'os-secret-store' | 'unavailable' = 'os-secret-store') {
    const calls: Array<[string, unknown]> = []
    let password: string | undefined
    const call = (method: string, params: unknown): Promise<unknown> => {
      calls.push([method, params])
      if (method === 'settings.secret.set') {
        if (backend === 'unavailable') {
          return Promise.resolve({ ok: false, error: 'backend-unavailable' })
        }
        password = (params as { value: string }).value
        return Promise.resolve({ ok: true, value: { name: 'opencode-password', configured: true } })
      }
      if (method === 'settings.secret.clear') {
        password = undefined
        return Promise.resolve({
          ok: true,
          value: { name: 'opencode-password', configured: false }
        })
      }
      if (method === 'preferences.get') {
        return Promise.resolve({
          preferences: {},
          secrets: [{ name: 'opencode-password', configured: password !== undefined }],
          secretBackend: backend,
          integrations: [],
          welcome: { due: false, legacyFound: [], offered: [] }
        })
      }
      return Promise.reject(new Error(`unexpected ${method}`))
    }
    const client = {
      call,
      state: () => ({ state: 'connected', hostVersion: '0.0.0-test', compat: false }),
      onStateChange: () => () => {},
      withUiConnection: <T>(work: (c: { call: typeof call }) => Promise<T>) => work({ call })
    }
    return {
      calls,
      password: () => password,
      client: client as unknown as Parameters<typeof composeOpenCodePasswordRows>[0]['client']
    }
  }

  async function seedPassword(userData: string): Promise<void> {
    const encrypted = safeStorage.encryptString(PASSWORD).toString('base64')
    await writeFile(join(userData, PASSWORD_FILE), `${JSON.stringify({ encrypted })}\n`)
  }

  it('[ADR-001] the release table composes no password row and no migration; a release the bridge does not live in runs none', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dwarfai-231-'))
    try {
      const base = {
        client: passwordHost().client,
        migration: { userDataDir: userData, safeStorage },
        log: { record: () => {} },
        mintId: () => MINTED
      }
      // AMENDED for ISSUE-235 (was: the release table `ROUTES` / `ROUTES_RELEASE`): the step-4a switch routes
      // A-54/A-55 `host`, so the table that composes none is the 3e table as it shipped.
      expect(
        composeOpenCodePasswordRows({ ...base, routes: CUT_3E_ROUTES, release: CUT_3E_RELEASE })
      ).toBeUndefined()
      const late = composeOpenCodePasswordRows({ ...base, routes: PASSWORD_4A, release: 'cut-5' })
      expect(late?.part.channels).toEqual([SET, CLEAR])
      expect(late?.migration).toBeUndefined()
      // Without the Host attach nothing is composed.
      expect(
        composeOpenCodePasswordRows({
          ...base,
          client: undefined,
          routes: PASSWORD_4A,
          release: 'cut-4a'
        })
      ).toBeUndefined()
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('[ADR-017, C-23] in a 4a table the legacy password file moves to the Host once before A-54/A-55 answer, and they round-trip through B-M10 and B-M11', async () => {
    // TC-231-01, TC-231-02
    const userData = await mkdtemp(join(tmpdir(), 'dwarfai-231-'))
    try {
      await seedPassword(userData)
      const host = passwordHost()
      const rows = composeOpenCodePasswordRows({
        routes: PASSWORD_4A,
        release: 'cut-4a',
        client: host.client,
        migration: { userDataDir: userData, safeStorage },
        log: { record: () => {} },
        mintId: () => MINTED
      })
      expect(rows?.part.channels).toEqual([SET, CLEAR])
      const router = createRouter({
        routes: PASSWORD_4A,
        legacy: { serve: () => Promise.reject(new Error('no legacy password row from 4a')) },
        ...(rows === undefined ? {} : { host: rows.part.target }),
        senders
      })
      const response = CHANNELS[SET].response

      // A-55 waits for the run: the migrated password was in the Host before the clear, and today's file is gone.
      expect(response.parse(await router.dispatch(CLEAR, FROM_PANEL as never, undefined))).toEqual({
        ok: true,
        value: { permissions: 'off', passwordConfigured: false, secretBackend: 'os-secret-store' }
      })
      expect(await readdir(userData)).toEqual([])

      // Over the cap: refused in main, it never crosses.
      const refused = await router.dispatch(SET, FROM_PANEL as never, 'a'.repeat(1025))
      expect(JSON.stringify(refused)).not.toContain('a'.repeat(1025))

      const saved = response.parse(await router.dispatch(SET, FROM_PANEL as never, TYPED))
      expect(saved).toEqual({
        ok: true,
        value: { permissions: 'off', passwordConfigured: true, secretBackend: 'os-secret-store' }
      })
      expect(JSON.stringify(saved)).not.toContain(TYPED)
      expect(host.password()).toBe(TYPED)
      expect(host.calls.filter(([method]) => method.startsWith('settings.secret.'))).toEqual([
        [
          'settings.secret.set',
          { name: 'opencode-password', value: PASSWORD, requestId: MINTED, origin: 'migration' }
        ],
        ['settings.secret.clear', { name: 'opencode-password', requestId: MINTED }],
        [
          'settings.secret.set',
          { name: 'opencode-password', value: TYPED, requestId: MINTED, origin: 'settings' }
        ]
      ])
      rows?.migration?.dispose()
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('[NFR-SEC-12] the migrated or typed password never reaches a log line', async () => {
    // L7 (17 §1.7 log redaction): the UI log and every console method, over a migration that succeeds, one the Host
    // refuses, and a typed save.
    const consoleLines: unknown[][] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args)
      })
    )
    const logged: unknown[] = []
    try {
      for (const backend of ['os-secret-store', 'unavailable'] as const) {
        const userData = await mkdtemp(join(tmpdir(), 'dwarfai-231-'))
        try {
          await seedPassword(userData)
          const host = passwordHost(backend)
          const rows = composeOpenCodePasswordRows({
            routes: PASSWORD_4A,
            release: 'cut-4a',
            client: host.client,
            migration: { userDataDir: userData, safeStorage },
            log: { record: (entry) => logged.push(entry) },
            mintId: () => MINTED
          })
          await rows?.part.target.serve(SET, TYPED, FROM_PANEL as never)
          rows?.migration?.dispose()
        } finally {
          await rm(userData, { recursive: true, force: true })
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }

    expect(logged.length).toBeGreaterThan(0)
    for (const line of [...logged, ...consoleLines]) {
      expect(JSON.stringify(line)).not.toContain(PASSWORD.trim())
      expect(JSON.stringify(line)).not.toContain(TYPED)
    }
  })
})

// ADDED for ISSUE-230: the Settings rows of step 4a (21 §2 cut 4a "New core serves"; 14 §2.1 A-42, A-43, A-47, A-51).
// The route rows are the step-4a switch's (later: ISSUE-235); these cases drive a 4a table built here. The handlers'
// own cases are in handlers/settingsParity.contract.test.ts.
describe('Settings rows served by the Host (21 §2 cut 4a)', () => {
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: APP_ENTRY } }
  const senders = { appEntry: APP_ENTRY, isModeWindow: (id: number) => id === 7 }
  const MINTED = '01920000-0000-7000-a000-000000000230'
  const NOTIFICATIONS_GET: ChannelKey = 'notifications:enabled:get' // A-42
  const NOTIFICATIONS_SET: ChannelKey = 'notifications:enabled:set' // A-43
  const JEV_GET: ChannelKey = 'jev:settings:get' // A-47
  const KEY_SET: ChannelKey = 'jev:apiKey:set' // A-48
  const KEY_CLEAR: ChannelKey = 'jev:apiKey:clear' // A-49
  const JEV_SET: ChannelKey = 'jev:preferences:set' // A-51

  const hostRoute = (channel: ChannelKey): ChannelRoute => ({
    channel,
    owner: 'host',
    since: 'cut-4a',
    parity: 'passed',
    shape: 'target'
  })
  /** Every Settings row of this issue and the Jev key rows `host`, as ISSUE-235's 4a rows will read. */
  const SETTINGS_4A: ChannelRoute[] = [
    NOTIFICATIONS_GET,
    NOTIFICATIONS_SET,
    JEV_GET,
    KEY_SET,
    KEY_CLEAR,
    JEV_SET
  ].map(hostRoute)

  /** The Host over in-memory preferences and Jev key: B-M10…B-M13, recording each call. */
  function settingsHost() {
    const calls: Array<[string, unknown]> = []
    let key: string | undefined
    let preferences: Record<string, unknown> = {
      subagentDelegationOn: false,
      routingProfile: 'balanced',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    }
    const call = (method: string, params: unknown): Promise<unknown> => {
      calls.push([method, params])
      if (method === 'settings.secret.set') {
        key = (params as { value: string }).value
        return Promise.resolve({ ok: true, value: { name: 'jev-key', configured: true } })
      }
      if (method === 'settings.secret.clear') {
        key = undefined
        return Promise.resolve({ ok: true, value: { name: 'jev-key', configured: false } })
      }
      if (method === 'preferences.get') {
        return Promise.resolve({
          preferences,
          secrets: [{ name: 'jev-key', configured: key !== undefined }],
          secretBackend: 'os-secret-store',
          integrations: [],
          welcome: { due: false, legacyFound: [], offered: [] }
        })
      }
      if (method === 'preferences.set') {
        const { key: name, value } = params as { key: string; value: unknown }
        preferences = { ...preferences, [name]: value }
        return Promise.resolve(preferences)
      }
      return Promise.reject(new Error(`unexpected ${method}`))
    }
    const client = {
      call,
      state: () => ({ state: 'connected', hostVersion: '0.0.0-test', compat: false }),
      onStateChange: () => () => {},
      withUiConnection: <T>(work: (c: { call: typeof call }) => Promise<T>) => work({ call })
    }
    return {
      calls,
      client: client as unknown as NonNullable<Parameters<typeof composeJevKeyRows>[0]['client']>
    }
  }

  /** Today's runtime never answers a Settings row of this table. */
  const legacy = { serve: () => Promise.reject(new Error('no legacy Settings row from 4a')) }

  // AMENDED for ISSUE-235 (was: the release table `ROUTES` / `ROUTES_RELEASE`): the step-4a switch routes these rows
  // `host`, so the table that composes none of them is the 3e table as it shipped (`testing/cut3eRoutes.ts`).
  it('[ADR-001] the release table composes none of A-42, A-43, A-47 and A-51 from the Host', () => {
    const { client } = settingsHost()
    expect(
      composeSystemNotificationRows({ routes: CUT_3E_ROUTES, client, mintId: () => MINTED })
    ).toBeUndefined()
    const jev = composeJevKeyRows({
      routes: CUT_3E_ROUTES,
      release: CUT_3E_RELEASE,
      client,
      migration: undefined,
      log: { record: () => {} },
      mintId: () => MINTED
    })
    expect(jev?.part?.channels ?? []).not.toContain(JEV_GET)
    expect(jev?.part?.channels ?? []).not.toContain(JEV_SET)
  })

  it("[ADR-001] in a 4a table A-42, A-43, A-47 and A-51 are served by the Host, and A-48/A-49 answer the Host's Jev preferences", async () => {
    const host = settingsHost()
    const jev = composeJevKeyRows({
      routes: SETTINGS_4A,
      release: 'cut-4a',
      client: host.client,
      migration: undefined,
      log: { record: () => {} },
      mintId: () => MINTED
    })
    const notifications = composeSystemNotificationRows({
      routes: SETTINGS_4A,
      client: host.client,
      mintId: () => MINTED
    })
    expect(jev?.part?.channels).toEqual([KEY_SET, KEY_CLEAR, JEV_GET, JEV_SET])
    expect(notifications?.channels).toEqual([NOTIFICATIONS_GET, NOTIFICATIONS_SET])
    const parts = [jev?.part, notifications].filter((part) => part !== undefined)
    const router = createRouter({
      routes: SETTINGS_4A,
      legacy,
      host: composeRouteTargets(parts),
      senders
    })
    const dispatch = async (channel: ChannelKey, payload?: unknown) =>
      CHANNELS[channel].response.parse(await router.dispatch(channel, FROM_PANEL as never, payload))

    expect(await dispatch(NOTIFICATIONS_GET)).toBe(true)
    expect(await dispatch(NOTIFICATIONS_SET, false)).toBe(false)
    expect(await dispatch(NOTIFICATIONS_GET)).toBe(false)
    const premium = { profile: 'premium', default: { provider: 'claude' }, delegation: true }
    expect(await dispatch(JEV_SET, premium)).toEqual({ configured: false, preferences: premium })
    // A-48 answers the preferences the Host holds, never today's (JevSettingsShapeAdapter is not composed).
    expect(await dispatch(KEY_SET, 'ts-live-0123456789abcdef')).toEqual({
      configured: true,
      preferences: premium
    })
    expect(await dispatch(JEV_GET)).toEqual({ configured: true, preferences: premium })
    expect(host.calls.filter(([method]) => method === 'preferences.set')).toEqual([
      ['preferences.set', { key: 'systemNotificationsOn', value: false, requestId: MINTED }],
      ['preferences.set', { key: 'routingProfile', value: 'premium', requestId: MINTED }],
      ['preferences.set', { key: 'defaultProvider', value: 'claude', requestId: MINTED }],
      ['preferences.set', { key: 'subagentDelegationOn', value: true, requestId: MINTED }]
    ])
  })
})

// ADDED for ISSUE-236, the 4a retirement (21 §2 cut 4a "Retired at the end"; §3, §3.1; §1 items 3, 6, 7): after the
// soak, today's settings, secret and reset handlers and the three bridges whose lifetime ended in 4a leave the tree.
// Read as text, because this tree never imports legacy code (05 R16).
describe('after the 4a retirement', () => {
  const SRC = resolve(import.meta.dirname, '..', '..')
  /** The rows 4a moved to the Host, with today's preload member (14 §2.1 A-33, A-42, A-43, A-47…A-55). */
  const RETIRED_HANDLERS: Readonly<Record<string, string>> = {
    'notifications:enabled:get': 'getNotificationsEnabled', // A-42
    'notifications:enabled:set': 'setNotificationsEnabled', // A-43
    'jev:settings:get': 'getJevSettings', // A-47
    'jev:apiKey:set': 'setJevApiKey', // A-48
    'jev:apiKey:clear': 'clearJevApiKey', // A-49
    'jev:route': 'routeJevLaunch', // A-50
    'jev:preferences:set': 'setJevPreferences', // A-51
    'opencode:settings:get': 'getOpenCodeSettings', // A-52
    'opencode:plugin:set': 'setOpenCodePluginEnabled', // A-53
    'opencode:password:set': 'setOpenCodeServerPassword', // A-54
    'opencode:password:clear': 'clearOpenCodeServerPassword', // A-55
    'metrics:reset': 'resetMetrics' // A-33
  }

  it('[ADR-001] no settings, secret or reset row has a legacy handler', () => {
    const legacyHandlers = ['legacy-bridge/LegacyRuntimeRoute.ts', 'main/index.ts'].flatMap(
      (file) => {
        const text = readFileSync(resolve(SRC, file), 'utf8')
        return Object.values(RETIRED_HANDLERS)
          .filter((member) =>
            new RegExp(String.raw`(handle|ipcMain\.handle)\(\s*IPC_CHANNELS\.${member}\b`).test(
              text
            )
          )
          .map((member) => `${file} ${member}`)
      }
    )
    expect(legacyHandlers).toEqual([])
    for (const channel of Object.keys(RETIRED_HANDLERS)) {
      expect(
        ROUTES.filter((route) => route.channel === channel && route.owner === 'legacy'),
        channel
      ).toEqual([])
    }
  })

  it('[ADR-001] SettingsMirrorBridge, ResetFanout and JevSettingsShapeAdapter are absent from the adapter listing', () => {
    const names = LEGACY_BRIDGE_ADAPTERS.map((adapter) => adapter.name)
    for (const ended of ['SettingsMirrorBridge', 'ResetFanout', 'JevSettingsShapeAdapter']) {
      expect(names, ended).not.toContain(ended)
    }
    for (const path of [
      'legacy-bridge/settingsMirror',
      'legacy-bridge/reset/resetFanout.ts',
      'legacy-bridge/secrets/jevSettingsShapeAdapter.ts'
    ]) {
      expect(existsSync(resolve(SRC, path)), path).toBe(false)
    }
  })
})
