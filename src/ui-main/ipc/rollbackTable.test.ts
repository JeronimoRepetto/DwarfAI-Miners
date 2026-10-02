// layer: L1
import { describe, expect, it } from 'vitest'
import { CHANNELS, UNROUTED, type ChannelKey } from '@dwarfai/contracts'
import { checkRouteTable, type ChannelRoute, type RouteTable } from './channelRoute'
import { rollbackOf } from './rollbackTable'
import { LEGACY_BRIDGE_ADAPTERS, ROUTES, ROUTES_RELEASE } from './routes'

/**
 * The rollback table of a cut (21 §2.1 item 1): the cut's rows that replaced legacy code are flipped back to the
 * pre-cut row (`legacy`, today's shape); rows of earlier cuts and the cut's NEW rows (no legacy code serves them) are
 * kept as they are.
 */
const KEYS = Object.keys(CHANNELS) as ChannelKey[]

const cut0: RouteTable = {
  release: ROUTES_RELEASE,
  routes: ROUTES,
  unrouted: UNROUTED,
  adapters: LEGACY_BRIDGE_ADAPTERS
}

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
})
