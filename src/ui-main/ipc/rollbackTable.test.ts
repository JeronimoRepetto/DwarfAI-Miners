// layer: L1
import { describe, expect, it } from 'vitest'
import {
  CATALOG_PROVIDER_IDS,
  CHANNELS,
  RETIRED,
  UNROUTED,
  type ChannelKey
} from '@dwarfai/contracts'
import { checkRouteTable, type ChannelRoute, type RouteTable } from './channelRoute'
import { rollbackOf } from './rollbackTable'
// AMENDED for ISSUE-002 (was: the release table `ROUTES` as the 3a table): from the step-3b switch the 3a table as it
// shipped is `testing/cut3aRoutes.ts`.
import { LEGACY_BRIDGE_ADAPTERS, ROUTES as RELEASE_ROUTES, ROUTES_RELEASE } from './routes'
import { CUT_3A_RELEASE, CUT_3A_ROUTES } from './testing/cut3aRoutes'
import { CUT_3B_RELEASE, CUT_3B_ROUTES } from './testing/cut3bRoutes'
import { CUT_0_ROUTES as ROUTES, CUT_0_TABLE } from './testing/cut0Routes'
import { CUT_2_ROUTES, CUT_2_TABLE } from './testing/cut2Routes'

/**
 * The rollback table of a cut (21 §2.1 item 1): the cut's rows that replaced legacy code are flipped back to the
 * pre-cut row (`legacy`, today's shape); rows of earlier cuts and the cut's NEW rows (no legacy code serves them) are
 * kept as they are.
 */
const KEYS = Object.keys(CHANNELS) as ChannelKey[]

// AMENDED for ISSUE-123 (was: the release table `ROUTES` as the cut-0 table): from the cut-1 switch the release table is
// cut 1's, so the cut-0 rollback is built from the cut-0 table as it shipped (`testing/cut0Routes.ts`).
const cut0: RouteTable = CUT_0_TABLE

const legacyToday = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'pre-cut-0',
  parity: 'n/a',
  shape: 'today'
})

describe('rollbackOf', () => {
  it('[ADR-001] rolling back cut 0 flips every cut-0 row to legacy with shape today and leaves the table valid', () => {
    expect(cut0.release).toBe('cut-0')
    const rolledBack = rollbackOf(cut0, 'cut-0')

    const moved = ROUTES.filter((r) => r.since === 'cut-0' && CHANNELS[r.channel].status !== 'new')
    expect(moved.length).toBeGreaterThan(0)
    for (const route of moved) {
      expect(
        rolledBack.routes.filter((r) => r.channel === route.channel),
        route.channel
      ).toEqual([legacyToday(route.channel)])
    }
    // A NEW row of the cut has no legacy code to go back to: it keeps its route, so the rollback build still reaches
    // its Host and the tray's Stop everything and quit (21 §2.1 item 2a; ADR-002 D7).
    const born = ROUTES.filter((r) => r.since === 'cut-0' && CHANNELS[r.channel].status === 'new')
    expect(born.length).toBeGreaterThan(0)
    for (const route of born) {
      expect(
        rolledBack.routes.filter((r) => r.channel === route.channel),
        route.channel
      ).toEqual([route])
    }
    // Every other row, the unrouted entries, the adapters and the release are unchanged.
    expect(rolledBack.routes).toEqual(
      ROUTES.map((r) => (moved.includes(r) ? legacyToday(r.channel) : r))
    )
    expect(rolledBack.unrouted).toEqual(cut0.unrouted)
    expect(rolledBack.adapters).toEqual(cut0.adapters)
    expect(rolledBack.release).toBe('cut-0')
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
  })

  it('[ADR-001] a rollback is built only from the table of the cut it rolls back', () => {
    // An earlier cut is past its retirement step once a later release ships: only forward fixes exist (21 §2.1 item 4).
    expect(() => rollbackOf({ ...cut0, release: 'cut-1' }, 'cut-0')).toThrow(RangeError)
    expect(() => rollbackOf(cut0, 'cut-1')).toThrow(RangeError)
  })

  // AMENDED for ISSUE-123 (appended): lead resolution H1, the rows a cut retired with no route.
  it('[ADR-001] rolling back a cut routes the rows it retired legacy again with shape today, and keeps an earlier cut’s', () => {
    const bornIn1 = (Object.keys(cut0.unrouted) as ChannelKey[]).filter(
      (channel) => cut0.unrouted[channel] === 'cut-1'
    )
    const cut1: RouteTable = {
      ...cut0,
      release: 'cut-1',
      routes: [
        ...cut0.routes.filter((r) => r.channel !== 'dwarf:feed' && r.channel !== 'mines:get'),
        ...bornIn1.map((channel): ChannelRoute => ({
          channel,
          owner: CHANNELS[channel].placement === 'host' ? 'host' : 'ui-local',
          since: 'cut-1',
          parity: CHANNELS[channel].placement === 'host' ? 'passed' : 'n/a',
          shape: 'target'
        }))
      ],
      // AMENDED for ISSUE-221 (was: A-N33 only): A-N31, born `host` in cut 2, is unrouted in cut 1 too.
      unrouted: {
        'host:connection:confirm-restart': 'generation-2',
        'claude:hooks:set': 'cut-2',
        // AMENDED for ISSUE-129: A-N07, born `host` in cut 2, is unrouted in cut 1 too.
        'ask:step:set': 'cut-2',
        // AMENDED for ISSUE-223: A-N32, born `host` in cut 2, is unrouted in cut 1 too.
        'welcome:answer': 'cut-2',
        // AMENDED for ISSUE-171: A-N29, born `host` in 3a, is unrouted in cut 1 too.
        'dwarf:stop': 'cut-3a',
        // AMENDED for ISSUE-168: A-N06, born `host` in 3a, is unrouted in cut 1 too.
        'dwarf:message:retry': 'cut-3a',
        // AMENDED for ISSUE-172: A-N08 and A-N09, born `host` in cut 2, are unrouted in cut 1 too.
        'dwarf:rename': 'cut-2',
        'dwarf:name:reset': 'cut-2',
        // AMENDED for ISSUE-174: A-N10, A-N11, born `host` in 3a, are unrouted in cut 1 too.
        'host:recovery:retry': 'cut-3a',
        'host:recovery:dismiss': 'cut-3a'
      },
      // An earlier cut's retired row stands for one whose legacy code that cut's retirement already deleted.
      retired: { 'dwarf:feed': 'cut-1', 'mines:get': 'cut-0' }
    }
    expect(checkRouteTable(cut1, KEYS)).toEqual([])
    const rolledBack = rollbackOf(cut1, 'cut-1')
    expect(rolledBack.routes.filter((r) => r.channel === 'dwarf:feed')).toEqual([
      legacyToday('dwarf:feed')
    ])
    expect(rolledBack.routes.filter((r) => r.channel === 'mines:get')).toEqual([])
    expect(rolledBack.retired).toEqual({ 'mines:get': 'cut-0' })
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    // A retired entry is accepted only from its step on, and never beside a route.
    expect(
      checkRouteTable({ ...cut1, release: 'cut-0', retired: { 'dwarf:feed': 'cut-1' } }, KEYS)
    ).toContainEqual({ reason: 'retired-not-reached', channel: 'dwarf:feed' })
    expect(checkRouteTable({ ...cut0, retired: { 'agent:launch': 'cut-0' } }, KEYS)).toContainEqual(
      { reason: 'routed-and-retired', channel: 'agent:launch' }
    )
  })

  // AMENDED for ISSUE-141 (appended): the first cut with qualified rows and with NEW rows that write a foreign entry.
  // AMENDED for ISSUE-141 (verifier finding, 2026-10-14; was: "…into one legacy row with shape today…", expecting
  // `legacyToday`): the rollback build keeps this tree's preload and renderer, which send A-40/A-41 in the 14 target
  // shape, so the folded row keeps that shape through `LegacyAnswerShapeAdapter` (a today-shape row refused every answer).
  it('[ADR-001, ADR-016] rolling back cut 2 folds each qualified row into one unqualified legacy row through its shape adapter and withdraws the NEW rows that turn the Host’s Claude hook entry on', () => {
    // AMENDED for ISSUE-001 (was: the release table `ROUTES`, `UNROUTED` and `RETIRED` under release 'cut-2'): from the
    // step-3a switch the release table is 3a's, so cut 2's rollback is built from the cut-2 table as it shipped.
    const cut2: RouteTable = CUT_2_TABLE
    expect(checkRouteTable(cut2, KEYS)).toEqual([])
    const rolledBack = rollbackOf(cut2, 'cut-2')
    // A-40 and A-41: three routes in cut 2 (the Host, and each origin of the relay through its shape adapter), one
    // unqualified legacy row through the adapter in the rollback build (21 §2.1 item 1: the rows flipped back to `legacy`).
    for (const channel of ['agent:answerQuestion', 'agent:answerPermission'] as ChannelKey[]) {
      expect(CUT_2_ROUTES.filter((r) => r.channel === channel)).toHaveLength(3)
      expect(rolledBack.routes.filter((r) => r.channel === channel)).toEqual([
        {
          channel,
          owner: 'legacy',
          since: 'cut-2',
          parity: 'n/a',
          shape: 'target',
          shapeAdapter: 'LegacyAnswerShapeAdapter'
        }
      ])
    }
    // A-N31 and A-N32 make the Host write the Claude hook entry, while the rollback build composes today's installer
    // again: they have no route in that build (21 §1 items 4, 8). A-N07 writes no foreign entry and keeps its route.
    for (const channel of ['claude:hooks:set', 'welcome:answer'] as ChannelKey[]) {
      expect(rolledBack.routes.filter((r) => r.channel === channel)).toEqual([])
    }
    expect(rolledBack.withdrawn).toEqual({ 'claude:hooks:set': 'cut-2', 'welcome:answer': 'cut-2' })
    expect(rolledBack.routes.filter((r) => r.channel === 'ask:step:set')).toEqual(
      CUT_2_ROUTES.filter((r) => r.channel === 'ask:step:set')
    )
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
    // A withdrawn entry is accepted only in the release that withdrew it, and never beside a route.
    expect(checkRouteTable({ ...rolledBack, release: 'cut-3a' }, KEYS)).toContainEqual({
      reason: 'withdrawn-not-this-release',
      channel: 'claude:hooks:set'
    })
    expect(
      checkRouteTable({ ...cut2, withdrawn: { 'ask:step:set': 'cut-2' } }, KEYS)
    ).toContainEqual({ reason: 'routed-and-withdrawn', channel: 'ask:step:set' })
  })

  // APPENDED for ISSUE-001: the first provider step, with provider-qualified rows that reach today's runtime through an
  // unqualified shape-adapter route, and the one-time Jev-key migration (docs/strangler/rollback.md "Step 3a").
  it('[ADR-001, ADR-017] rolling back 3a folds each provider-qualified row into its unqualified shape-adapter row, keeps the Jev key rows on the Host and keeps the NEW rows', () => {
    const cut3a: RouteTable = {
      release: CUT_3A_RELEASE,
      routes: CUT_3A_ROUTES,
      unrouted: UNROUTED,
      retired: RETIRED,
      adapters: LEGACY_BRIDGE_ADAPTERS
    }
    expect(cut3a.release).toBe('cut-3a')
    expect(checkRouteTable(cut3a, KEYS)).toEqual([])
    const rolledBack = rollbackOf(cut3a, 'cut-3a')
    const routesOf = (channel: ChannelKey): ChannelRoute[] =>
      rolledBack.routes.filter((r) => r.channel === channel)
    // A-13, A-23, A-35 and A-36: the rollback build keeps this tree's renderer, which calls them with the 14 shapes, so
    // the Host route for Claude goes and every provider reaches today's runtime through the row's shape adapter.
    const throughAdapter = {
      'dwarf:activate': 'PerProviderShapeAdapter',
      'dwarf:sendText': 'PerProviderShapeAdapter',
      'agent:launch': 'PerProviderShapeAdapter',
      'agent:providers': 'CatalogMergeAdapter'
    } as const
    for (const [channel, shapeAdapter] of Object.entries(throughAdapter) as [
      ChannelKey,
      string
    ][]) {
      expect(CUT_3A_ROUTES.filter((r) => r.channel === channel && r.owner === 'host')).toHaveLength(
        1
      )
      expect(routesOf(channel), channel).toEqual([
        { channel, owner: 'legacy', since: 'cut-3a', parity: 'n/a', shape: 'target', shapeAdapter }
      ])
    }
    // A KEEP row moved for every provider (A-25) and the rows qualified to the providers not yet moved (A-27, A-P3,
    // A-P4) are the pre-cut row again: today's runtime serves every provider, in today's shape.
    for (const channel of [
      'dwarf:attachments:describe',
      'dwarf:retire',
      'agent:launchFailed',
      'dwarf:sendText:settled'
    ] as ChannelKey[]) {
      expect(routesOf(channel), channel).toEqual([legacyToday(channel)])
    }
    // The rows 3a retired (A-26, A-37, A-38) are today's again (lead resolution H1).
    for (const channel of ['dwarf:kick', 'agent:models', 'agent:launchHeld'] as ChannelKey[]) {
      expect(RETIRED[channel]).toBe('cut-3a')
      expect(routesOf(channel), channel).toEqual([legacyToday(channel)])
    }
    expect(Object.values(rolledBack.retired ?? {})).not.toContain('cut-3a')
    // A-48, A-49 (the key the one-time migration moved into the Host's SecretStore and deleted from today's file;
    // ADR-017 item 8) and A-50 (which reads that key) keep their Host routes, and A-47 keeps reading the key's status
    // from the Host through its shape adapter: today's runtime no longer holds the key (21 §2 cut 4a "Rollback" rule).
    for (const channel of [
      'jev:apiKey:set',
      'jev:apiKey:clear',
      'jev:route',
      'jev:settings:get'
    ] as ChannelKey[]) {
      expect(routesOf(channel), channel).toEqual(CUT_3A_ROUTES.filter((r) => r.channel === channel))
    }
    // The NEW rows born in 3a have no legacy code to go back to: A-N06, A-N10, A-N11, and A-N29, which ends a
    // legacy-launched session through LegacyEndFirstAdapter.
    for (const channel of [
      'dwarf:message:retry',
      'host:recovery:retry',
      'host:recovery:dismiss',
      'dwarf:stop'
    ] as ChannelKey[]) {
      expect(routesOf(channel), channel).toEqual(CUT_3A_ROUTES.filter((r) => r.channel === channel))
    }
    // Nothing is withdrawn, and the earlier cuts' rows keep their routes.
    expect(rolledBack.withdrawn).toBeUndefined()
    const earlier = CUT_3A_ROUTES.filter((r) => r.since !== 'cut-3a')
    for (const route of earlier) expect(rolledBack.routes, route.channel).toContainEqual(route)
    expect(rolledBack.routes.some((r) => r.owner === 'host' && r.qualifier !== undefined)).toBe(
      false
    )
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
  })

  // APPENDED for ISSUE-002: a later provider step beside the shape-adapter routes 3a created (docs/strangler/rollback.md
  // "Step 3b").
  it('[ADR-001] rolling back 3b drops the Codex host rows so Codex reaches the 3a shape adapters again, and gives Codex its A-27, A-P3 and A-P4 rows back', () => {
    const [, CODEX = ''] = CATALOG_PROVIDER_IDS
    // AMENDED for ISSUE-186 (was: the release table `ROUTES` / `ROUTES_RELEASE`): from the step-3d switch the 3b table
    // as it shipped is `testing/cut3bRoutes.ts`.
    const cut3b: RouteTable = {
      release: CUT_3B_RELEASE,
      routes: CUT_3B_ROUTES,
      unrouted: UNROUTED,
      retired: RETIRED,
      adapters: LEGACY_BRIDGE_ADAPTERS
    }
    expect(cut3b.release).toBe('cut-3b')
    const rolledBack = rollbackOf(cut3b, 'cut-3b')
    expect(rolledBack.routes.some((r) => r.since === 'cut-3b')).toBe(false)
    for (const channel of [
      'dwarf:retire',
      'agent:launchFailed',
      'dwarf:sendText:settled'
    ] as const) {
      expect(rolledBack.routes, channel).toContainEqual({
        channel,
        owner: 'legacy',
        since: 'cut-3a',
        parity: 'n/a',
        qualifier: { provider: CODEX },
        shape: 'today'
      })
    }
    const order = (routes: readonly ChannelRoute[]) => routes.map((r) => JSON.stringify(r)).sort()
    expect(order(rolledBack.routes)).toEqual(order(CUT_3A_ROUTES))
    expect(rolledBack.withdrawn).toBeUndefined()
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
  })

  // APPENDED for ISSUE-186: step 3d moves "Other…", outside the catalog (docs/strangler/rollback.md "Step 3d").
  it("[ADR-001] rolling back 3d gives A-39 back to today's runtime, sends Other… dwarfs to the 3a shape adapters and gives Other… no A-27, A-P3 or A-P4 row", () => {
    const cut3d: RouteTable = {
      release: ROUTES_RELEASE,
      routes: RELEASE_ROUTES,
      unrouted: UNROUTED,
      retired: RETIRED,
      adapters: LEGACY_BRIDGE_ADAPTERS
    }
    expect(cut3d.release).toBe('cut-3d')
    const rolledBack = rollbackOf(cut3d, 'cut-3d')
    expect(rolledBack.routes.some((r) => r.since === 'cut-3d')).toBe(false)
    expect(rolledBack.routes.filter((r) => r.channel === 'agent:launchHosted')).toEqual([
      {
        channel: 'agent:launchHosted',
        owner: 'legacy',
        since: 'pre-cut-0',
        parity: 'n/a',
        shape: 'today'
      }
    ])
    for (const channel of [
      'dwarf:retire',
      'agent:launchFailed',
      'dwarf:sendText:settled'
    ] as const) {
      const providers = rolledBack.routes
        .filter((r) => r.channel === channel)
        .map((r) => r.qualifier?.provider)
      expect(
        providers.every((provider) => CATALOG_PROVIDER_IDS.some((id) => id === provider)),
        channel
      ).toBe(true)
    }
    const order = (routes: readonly ChannelRoute[]) => routes.map((r) => JSON.stringify(r)).sort()
    expect(order(rolledBack.routes)).toEqual(order(CUT_3B_ROUTES))
    expect(rolledBack.withdrawn).toBeUndefined()
    expect(checkRouteTable(rolledBack, KEYS)).toEqual([])
  })
})
