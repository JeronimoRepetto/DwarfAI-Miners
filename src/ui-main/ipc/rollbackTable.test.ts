// layer: L1
import { describe, expect, it } from 'vitest'
import { CHANNELS, type ChannelKey } from '@dwarfai/contracts'
import { checkRouteTable, type ChannelRoute, type RouteTable } from './channelRoute'
import { rollbackOf } from './rollbackTable'
import { CUT_0_ROUTES as ROUTES, CUT_0_TABLE } from './testing/cut0Routes'

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
        'claude:hooks:set': 'cut-2'
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
})
