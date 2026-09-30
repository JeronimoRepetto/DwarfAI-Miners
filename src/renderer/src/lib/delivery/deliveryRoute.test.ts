import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import { rememberRoutes, routeWentAway } from './deliveryRoute'

/*
 * A delivery route that went away (#635, decision log, Copy alone on a closed session): a dwarf
 * this app run once saw with a text delivery channel, which now has none. Told apart from a
 * session type that has no channel yet, which never had one, by remembering who ever had one.
 */
describe('rememberRoutes', () => {
  it('remembers every dwarf the board shows with a text delivery channel', () => {
    const seen = rememberRoutes(new Set(), [
      defaultDwarf({ id: 'a', textDelivery: 'terminal' }),
      defaultDwarf({ id: 'b', textDelivery: undefined }),
      defaultDwarf({ id: 'c', textDelivery: 'foreman-relay' })
    ])
    expect([...seen].sort()).toEqual(['a', 'c'])
  })

  it('forgets nobody when a later board shows the same dwarf without its channel', () => {
    const first = rememberRoutes(new Set(), [defaultDwarf({ id: 'a', textDelivery: 'terminal' })])
    const later = rememberRoutes(first, [defaultDwarf({ id: 'a', textDelivery: undefined })])
    expect(later.has('a')).toBe(true)
  })

  it('hands back the same set when the board adds nobody, so a store need not change', () => {
    const first = rememberRoutes(new Set(), [defaultDwarf({ id: 'a', textDelivery: 'terminal' })])
    expect(rememberRoutes(first, [defaultDwarf({ id: 'a', textDelivery: 'terminal' })])).toBe(first)
  })

  it('never changes the set it was handed', () => {
    const first: ReadonlySet<string> = new Set()
    rememberRoutes(first, [defaultDwarf({ id: 'a', textDelivery: 'terminal' })])
    expect(first.size).toBe(0)
  })
})

describe('routeWentAway', () => {
  const seen: ReadonlySet<string> = new Set(['a'])

  it('is true for a dwarf once seen with a channel that now has none', () => {
    expect(routeWentAway(seen, defaultDwarf({ id: 'a', textDelivery: undefined }))).toBe(true)
  })

  it('is false while the dwarf still has its channel', () => {
    expect(routeWentAway(seen, defaultDwarf({ id: 'a', textDelivery: 'terminal' }))).toBe(false)
  })

  it('is false for a dwarf that never had a channel: its session type has none yet', () => {
    expect(routeWentAway(seen, defaultDwarf({ id: 'b', textDelivery: undefined }))).toBe(false)
  })
})
