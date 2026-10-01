// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, STEP_ORDER, UNROUTED, type ChannelKey, type StepId } from '@dwarfai/contracts'
import { checkRouteTable, type ChannelRoute, type RouteTable } from './channelRoute'
import { LEGACY_BRIDGE_ADAPTERS, ROUTES, ROUTES_RELEASE } from './routes'

/**
 * The router's contract (ADR-001 item 3; 21 §1 items 1, 2, 2a; 14 §6.5 "Router"): every registry row has exactly one
 * route per (channel, qualifier) in a release, or one unrouted entry naming a later step (22 §5); every `legacy` +
 * `target` route names a listed shape adapter (21 §3.1); no `host` route has `shape: 'today'` or, in a release
 * build, `parity: 'pending'`; every legacy-bridge adapter is listed with its cuts and absent after cut 5 (21 §3).
 */
const KEYS = Object.keys(CHANNELS) as ChannelKey[]

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
    expect(ROUTES_RELEASE).toBe('pre-cut-0')
    expect(checkRouteTable(preCut, KEYS)).toEqual([])
    for (const key of KEYS) {
      const routes = ROUTES.filter((r) => r.channel === key)
      expect(routes.length + (UNROUTED[key] ? 1 : 0), key).toBe(1)
    }
    // TC-043-01: before cut 0 every route is today's runtime with today's shape.
    for (const route of ROUTES) {
      expect(route, route.channel).toEqual(legacyToday(route.channel))
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
})
