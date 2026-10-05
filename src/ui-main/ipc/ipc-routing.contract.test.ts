// layer: L6
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  PRELOAD_HELPERS,
  ROW_IDS,
  STEP_ORDER,
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
  composeStopAllRelay,
  type LegacyRuntimeSurface
} from '../index'
import type { HostEvent } from '../window/ports/hostClient'
import { createStopEverything } from '../window/application/stopEverything'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { UI_MAIN_PUSHES } from '../index'
import { checkRouteTable, type ChannelRoute, type RouteTable } from './channelRoute'
import { createStopEverythingRows, STOP_EVERYTHING_CONFIRM } from './handlers/stopEverything'
import { rollbackOf } from './rollbackTable'
import { createRouter } from './router'
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

const preCut: RouteTable = {
  release: ROUTES_RELEASE,
  routes: ROUTES,
  unrouted: UNROUTED,
  adapters: LEGACY_BRIDGE_ADAPTERS
}

/**
 * The pre-cut table with every unrouted NEW row routed as its step will route it (its registry placement, target
 * shape), so a table built for another release or with other unrouted entries checks only the change under test.
 */
const routedBase: RouteTable = {
  ...preCut,
  routes: [
    ...ROUTES,
    ...(Object.entries(UNROUTED) as [ChannelKey, StepId][]).map(
      ([channel, since]): ChannelRoute => ({
        channel,
        owner: CHANNELS[channel].placement === 'host' ? 'host' : 'ui-local',
        since,
        parity: CHANNELS[channel].placement === 'host' ? 'passed' : 'n/a',
        shape: 'target'
      })
    )
  ],
  unrouted: {}
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
      expect(routes.length + (UNROUTED[key] ? 1 : 0), key).toBe(1)
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
    const BOARD_ROWS: ChannelKey[] = ['mines:get', 'mines:update']
    for (const key of BOARD_ROWS) {
      expect([CHANNELS[key].status, CHANNELS[key].placement], key).toEqual(['retired', 'host'])
      expect(
        ROUTES.filter((r) => r.channel === key).map((r) => r.owner),
        key
      ).toEqual(['legacy'])
    }

    // The root composes the facade only once the table routes A-12 to the Host: not in this release.
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
    expect(composeBoardFacade({ routes: ROUTES, client, windows, defer })).toBeUndefined()
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
      ...ROUTES.filter((r) => !BOARD_ROWS.includes(r.channel)),
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

/**
 * The 14 ids of the rows cut 0 serves `ui-local` (21 §2 cut 0 "New core serves" U), plus A-N34 (owner-approved
 * amendment 2026-10-01, ISSUE-316: the renderer's entry to the tray's Stop everything and quit, `ui-local`).
 */
// prettier-ignore
const CUT_0_UI_LOCAL_IDS = [
  'A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'A-07', 'A-08', 'A-09', 'A-10', 'A-11',
  'A-21', 'A-22', 'A-24', 'A-28', 'A-29', 'A-45', 'A-46', 'A-56', 'A-57', 'A-P1', 'A-P6', 'A-X1',
  'A-N03', 'A-N04', 'A-N05', 'A-N30', 'A-N25', 'A-N27', 'A-N34'
]

/** The registry keys of the given 14 ids (A-44's today wire is not a registry key, so no row matches twice). */
const keysOf = (ids: readonly string[]): ChannelKey[] =>
  KEYS.filter((key) => ids.includes(ROW_IDS[key] ?? ''))

describe('release cut-0 (21 §2 cut 0)', () => {
  const cut0: RouteTable = {
    release: ROUTES_RELEASE,
    routes: ROUTES,
    unrouted: UNROUTED,
    adapters: LEGACY_BRIDGE_ADAPTERS
  }
  const uiLocal = keysOf(CUT_0_UI_LOCAL_IDS)
  const routeOf = (key: ChannelKey): ChannelRoute[] => ROUTES.filter((r) => r.channel === key)

  it('[ADR-001] in cut 0 the window family, A-N03 to A-N05, A-N30, A-N25 and A-N27 route ui-local', () => {
    expect(ROUTES_RELEASE).toBe('cut-0')
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
    expect(UNROUTED).toEqual({
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
    expect(ROUTES.filter((r) => r.owner === 'host').map((r) => r.channel)).toEqual([
      STOP_EVERYTHING_CONFIRM
    ])
    // The relay that ends the legacy-launched sessions first lives in this release (21 §3), and the root composes it
    // as A-N26's only path (`composeStopAllRelay`, the LegacyEndFirstAdapter case above; index.cut0.test.ts).
    expect(LEGACY_BRIDGE_ADAPTERS.find((a) => a.name === 'LegacyEndFirstAdapter')?.cuts).toContain(
      ROUTES_RELEASE
    )
  })

  it('[ADR-001] in cut 0 every other row routes legacy with shape today, RETIRE rows included', () => {
    const moved = new Set<ChannelKey>([...uiLocal, STOP_EVERYTHING_CONFIRM])
    const others = KEYS.filter((key) => !moved.has(key) && UNROUTED[key] === undefined)
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
    expect(others.length + moved.size + Object.keys(UNROUTED).length).toBe(KEYS.length)
  })

  it('[ADR-001] in cut 0 every host route uses only seam-B members born in cut 0 and none has parity pending', () => {
    const at = (step: StepId) => STEP_ORDER.indexOf(step)
    for (const route of ROUTES.filter((r) => r.owner === 'host')) {
      expect(route.parity, route.channel).not.toBe('pending')
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
    // 21 §2 "Seam B members: the cut in which each is born", row 0 (B-M02…B-M06; B-M01 `hello` is the handshake).
    expect(SEAM_B_METHODS_BORN).toEqual({
      ping: 'cut-0',
      'events.subscribe': 'cut-0',
      'session.snapshot': 'cut-0',
      'host.shutdown': 'cut-0',
      'host.upgrade.request': 'cut-0'
    })
    expect(HOST_ROUTE_MEMBERS).toEqual({ [STOP_EVERYTHING_CONFIRM]: ['host.shutdown'] })
  })

  it('[ADR-001] in cut 0 LegacyRuntimeRoute and LegacyEndFirstAdapter are the only adapters composed', () => {
    expect(
      LEGACY_BRIDGE_ADAPTERS.filter((a) => a.cuts.includes(ROUTES_RELEASE)).map((a) => a.name)
    ).toEqual(['LegacyRuntimeRoute', 'LegacyEndFirstAdapter'])
    // No route of this release names a shape adapter (21 §3.1: the first is born in cut 1).
    expect(ROUTES.filter((r) => r.shapeAdapter !== undefined)).toEqual([])
  })

  it('[ADR-019] every ipcMain registration, preload member and push of the cut-0 build maps to exactly one CHANNELS entry and back', () => {
    // ipcMain: the router registers one listener per invoke and send row, under the wire its route speaks.
    const registered: string[] = []
    createRouter({
      routes: ROUTES,
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
      expect(routeOf(key).length + (UNROUTED[key] ? 1 : 0), key).toBe(1)
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
describe('rollback', () => {
  const cut0: RouteTable = {
    release: ROUTES_RELEASE,
    routes: ROUTES,
    unrouted: UNROUTED,
    adapters: LEGACY_BRIDGE_ADAPTERS
  }
  /**
   * A cut-1 table as its switch would build it from the cut-0 table: the NEW rows unrouted until cut 1 born there, one
   * kept row moved to the Host. It stands for the first table whose rollback meets rows of an earlier, retired cut.
   */
  const cut1: RouteTable = {
    ...cut0,
    release: 'cut-1',
    routes: [
      ...ROUTES.filter((r) => r.channel !== 'mine:history'),
      { channel: 'mine:history', owner: 'host', since: 'cut-1', parity: 'passed', shape: 'target' },
      ...(Object.entries(UNROUTED) as [ChannelKey, StepId][])
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
      Object.entries(UNROUTED).filter(([, step]) => step !== 'cut-1')
    ) as RouteTable['unrouted']
  }

  it('[ADR-001] the rollback table of cut 0 passes the router test with one owner per channel', () => {
    const rolledBack = rollbackOf(cut0, 'cut-0')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    for (const key of KEYS) {
      const routes = rolledBack.routes.filter((r) => r.channel === key)
      expect(routes.length + (UNROUTED[key] ? 1 : 0), key).toBe(1)
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
      ROUTES.filter((r) => r.since === 'cut-0')
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
    for (const release of [ROUTES_RELEASE, 'cut-0', 'cut-5', 'v1'] as StepId[]) {
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
    for (const release of [ROUTES_RELEASE, 'cut-0', 'cut-5', 'v1'] as StepId[]) {
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
    for (const release of [ROUTES_RELEASE, 'cut-0', 'cut-5', 'v1'] as StepId[]) {
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
