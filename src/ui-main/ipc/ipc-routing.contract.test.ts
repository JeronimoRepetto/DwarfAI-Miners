// layer: L6
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
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
  type StepId
} from '@dwarfai/contracts'
import {
  composeBoardFacade,
  composeLegacyAgentRegistryFeed,
  composeLegacyAskRelay,
  composeLegacyDwarfIdBridge,
  composeLegacyLaunchObservation,
  composeHostReads,
  composeMinesAdmin,
  composePresence,
  composeResetFanout,
  composeStopAllRelay,
  legacyObserverComposition,
  legacyObserverOwner,
  type LegacyRuntimeSurface
} from '../index'
import type { HostEvent } from '../window/ports/hostClient'
import { createStopEverything } from '../window/application/stopEverything'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CUT_1_ROLLBACK } from '../../contracts/strangler'
import { UI_MAIN_PUSHES } from '../index'
import { checkRouteTable, type ChannelRoute, type RouteTable } from './channelRoute'
import { createStopEverythingRows, STOP_EVERYTHING_CONFIRM } from './handlers/stopEverything'
import { rollbackOf } from './rollbackTable'
import { createRouter } from './router'
import { CUT_0_ROUTES, CUT_0_TABLE, CUT_0_UI_LOCAL_IDS, CUT_0_UNROUTED } from './testing/cut0Routes'
import { PRE_CUT_0_ROUTES } from './testing/preCutRoutes'
import {
  HOST_ROUTE_MEMBERS,
  LEGACY_BRIDGE_ADAPTERS,
  ROUTES,
  ROUTES_RELEASE,
  SEAM_B_METHODS_BORN
} from './routes'

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
      expect(routes.length + (UNROUTED[key] ? 1 : 0) + (RETIRED[key] ? 1 : 0), key).toBe(1)
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
      ResetFanout: span('cut-1', 'cut-3e'),
      LegacyAgentRegistryFeed: span('cut-1', 'cut-4b'),
      SettingsMirrorBridge: span('cut-1', 'cut-3e'),
      LegacyAskRelay: span('cut-1', 'cut-4b'),
      LegacyEndFirstAdapter: span('cut-0', 'cut-4b'),
      PerProviderShapeAdapter: span('cut-3a', 'cut-4b'),
      CatalogMergeAdapter: span('cut-3a', 'cut-4b'),
      LegacyAnswerShapeAdapter: span('cut-2', 'cut-4b'),
      JevSettingsShapeAdapter: span('cut-3a', 'cut-4a')
    })
    expect(
      LEGACY_BRIDGE_ADAPTERS.filter((a) => a.shapeAdapter)
        .map((a) => a.name)
        .sort()
    ).toEqual([
      'CatalogMergeAdapter',
      'JevSettingsShapeAdapter',
      'LegacyAnswerShapeAdapter',
      'PerProviderShapeAdapter',
      'ResetFanout'
    ])

    // A route's shape adapter must be listed as a shape adapter living in the table's release.
    const naming = (release: StepId, shapeAdapter: string): RouteTable => ({
      ...withRoutes(routedBase, 'metrics:reset', {
        ...legacyToday('metrics:reset'),
        shape: 'target',
        shapeAdapter
      }),
      release
    })
    expect(reasons(naming('cut-1', 'ResetFanout'))).toEqual([])
    expect(reasons(naming('cut-4a', 'ResetFanout'))).toEqual(['adapter-not-listed ResetFanout'])
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
      'mode:revealDwarfChat': 'cut-1'
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
    // entry is spoken exactly once; its one helper is A-X1, the preload-only member.
    const preload = readFileSync(resolve(import.meta.dirname, '../../preload/index.ts'), 'utf8')
    const spoken = [...preload.matchAll(/ipcRenderer\.(?:invoke|send|on)\(\s*'([^']+)'/g)].map(
      (match) => match[1] ?? ''
    )
    expect(spoken.map((wire) => keyOfWire(wire)).sort()).toEqual(
      KEYS.filter((key) => !helpers.includes(key)).sort()
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
    for (const key of ['agent:answerQuestion', 'agent:answerPermission'] as ChannelKey[]) {
      expect(
        ROUTES.filter((r) => r.channel === key).map((r) => [r.owner, r.shape]),
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
 * legacy writers' composition gated by this table is the cut-1 route switch's (ISSUE-123), which derives it from the
 * same table this rule reads (`legacyObserverOwner`).
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
  const cut1: RouteTable = {
    ...preCut,
    release: 'cut-1',
    routes: [
      ...ROUTES.filter((r) => r.channel !== 'mine:history'),
      { channel: 'mine:history', owner: 'host', since: 'cut-1', parity: 'passed', shape: 'target' },
      ...(Object.entries(UNROUTED) as [ChannelKey, StepId][])
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
      Object.entries(UNROUTED).filter(([, step]) => step !== 'cut-1')
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
describe('release cut 1 (21 §2 cut 1)', () => {
  const cut1: RouteTable = {
    release: ROUTES_RELEASE,
    routes: ROUTES,
    unrouted: UNROUTED,
    retired: RETIRED,
    adapters: LEGACY_BRIDGE_ADAPTERS
  }
  /** The one registry key of a 14 id. */
  const keyOf = (id: string): ChannelKey => {
    const keys = KEYS.filter((key) => ROW_IDS[key] === id)
    expect(keys, id).toHaveLength(1)
    return keys[0] as ChannelKey
  }
  const routeOf = (key: ChannelKey): ChannelRoute[] => ROUTES.filter((r) => r.channel === key)
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
    expect(ROUTES_RELEASE).toBe('cut-1')
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
      routes: ROUTES,
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
      routes: ROUTES.filter((r) => (reads?.part.channels ?? []).includes(r.channel)),
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
      routes: ROUTES,
      release: ROUTES_RELEASE,
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
      routes: ROUTES,
      release: ROUTES_RELEASE,
      client: recorded,
      native,
      legacy,
      bridge,
      newRequestId: () => '01890a5d-ac96-774b-bcce-b302099a8001'
    })
    const router = createRouter({
      routes: ROUTES.filter((r) => (admin?.part.channels ?? []).includes(r.channel)),
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
      ROUTES_RELEASE
    )
    const composedWith = (deps: Partial<Parameters<typeof composeMinesAdmin>[0]>) =>
      composeMinesAdmin({
        routes: ROUTES,
        release: ROUTES_RELEASE,
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
      routes: ROUTES,
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
    const order: string[] = []
    const legacy = {
      serve: async (channel: string) => {
        order.push(`legacy ${channel}`)
        return { outcome: 'reset' }
      }
    }
    const host = recordingHost()
    const adapters = composeResetFanout({
      routes: ROUTES,
      release: ROUTES_RELEASE,
      legacy,
      client: host.client as unknown as Parameters<typeof composeResetFanout>[0]['client'],
      now: () => 0
    })
    expect(Object.keys(adapters ?? {})).toEqual(['ResetFanout'])
    // Without it the router does not start: a route naming a shape adapter needs it bound.
    expect(() =>
      createRouter({ routes: ROUTES.filter((r) => r.channel === a33), legacy, senders })
    ).toThrow()
    const router = createRouter({
      routes: ROUTES.filter((r) => r.channel === a33),
      legacy,
      ...(adapters === undefined ? {} : { shapeAdapters: adapters }),
      senders
    })
    const answer = await router.dispatch(a33, FROM_PANEL, {
      confirmed: 'yes',
      requestId: '01890a5d-ac96-774b-bcce-b302099a8002'
    })
    expect(CHANNELS[a33].response.safeParse(answer).success).toBe(true)
    expect(order).toEqual(['legacy metrics:reset'])
    expect(host.sent).toEqual(['preferences.resetMetrics'])
  })

  it('[ADR-001] in cut 1 A-14, A-16, A-17, A-18 and A-P5 have no route and no handler, and A-N16 exists', async () => {
    const retired = ['A-14', 'A-16', 'A-17', 'A-18', 'A-P5'].map(keyOf)
    expect(RETIRED).toEqual(Object.fromEntries(retired.map((key) => [key, 'cut-1'])))
    const reached: string[] = []
    const router = createRouter({
      routes: ROUTES,
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
    expect(UNROUTED[an16]).toBeUndefined()
  })

  it('[ADR-001] in cut 1 A-44, A-N17 to A-N21 and A-N12 route ui-local with shape target, and A-44 feeds presence', async () => {
    const a44 = keyOf('A-44')
    expect(routeOf(a44)).toEqual([bornIn1(a44, 'ui-local', 'passed')])
    for (const id of ['A-N17', 'A-N18', 'A-N19', 'A-N20', 'A-N21', 'A-N12']) {
      const key = keyOf(id)
      expect(routeOf(key), id).toEqual([bornIn1(key, 'ui-local', 'n/a')])
    }
    // Only A-N33 is still unrouted (AMENDMENT-11).
    expect(UNROUTED).toEqual({ 'host:connection:confirm-restart': 'generation-2' })
    // A-44 on its 14 wire feeds UI main's PresenceTracker, which tells the Host (B-M07) once the report settled.
    const host = recordingHost()
    const timers: Array<() => void> = []
    const presence = composePresence({
      routes: ROUTES,
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

  it('[ADR-001] in cut 1 no legacy publish, crediting or notifier is composed and LegacyAgentRegistryFeed is composed', async () => {
    // TC-123-01, TC-123-06: the table routes the cut-1 board and read rows to the Host, so today's composition gets
    // none of its observer sinks (21 §2 cut 1 "Switched off in legacy"); the feed's cycles are the only ticks.
    expect(legacyObserverOwner(ROUTES)).toBe('host')
    expect(legacyObserverComposition(legacyObserverOwner(ROUTES))).toEqual({
      pollTimer: false,
      boardPublish: false,
      ledgerCrediting: false,
      projectsObserverWrites: false,
      notifier: false
    })
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

  it("[ADR-001] with the cut-1 rows flipped back to legacy the legacy observer, crediting and notifier are composed again, and never together with the Host observer's writes", async () => {
    const rolledBack = rollbackOf(cut1, 'cut-1')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    // Today's composition gets every observer sink back, and the build's Host rollback setting must be on with it.
    expect(legacyObserverOwner(rolledBack.routes)).toBe('legacy')
    expect(legacyObserverComposition(legacyObserverOwner(rolledBack.routes))).toEqual({
      pollTimer: true,
      boardPublish: true,
      ledgerCrediting: true,
      projectsObserverWrites: true,
      notifier: true
    })
    expect(cut1RowsRouteLegacy(rolledBack)).toBe(true)
    // In the release table the reverse: the Host observer writes and today's sinks are off. The two never meet.
    for (const table of [cut1, rolledBack]) {
      const legacyWrites = legacyObserverComposition(legacyObserverOwner(table.routes))
      const hostWrites = !cut1RowsRouteLegacy(table)
      for (const sink of ['ledgerCrediting', 'notifier', 'boardPublish'] as const) {
        expect(legacyWrites[sink], `${table === cut1 ? 'release' : 'rollback'} ${sink}`).toBe(
          !hostWrites
        )
      }
    }
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
    const retired = Object.keys(RETIRED) as ChannelKey[]
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
      ROUTES.filter((r) => r.since === 'cut-0')
    )
  })

  it('[ADR-001] in cut 1 every host route uses only seam-B members born by cut 1 and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of ROUTES.filter((r) => r.owner === 'host')) {
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
    expect(HOST_ROUTE_MEMBERS).toEqual({
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
      release: ROUTES_RELEASE,
      client,
      legacy: { serve: () => Promise.resolve(undefined) },
      registry: surface
    })
    const relay = composeLegacyAskRelay({ release: ROUTES_RELEASE, dwarfIds })
    const feed = composeLegacyAgentRegistryFeed({
      release: ROUTES_RELEASE,
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
