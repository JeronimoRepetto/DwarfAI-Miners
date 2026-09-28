import type { Dwarf } from '../../types'

/*
 * A delivery route that went away (#635, decision log, Copy alone on a closed session).
 *
 * The board says only what channel a dwarf has NOW. A dwarf with none is either a session type
 * this app has no channel for yet, or a session whose channel was there and went away — and the
 * design gives the two different sentences, because only the second is a session that can no
 * longer take text. One board cannot tell them apart; the boards of this app run can. So a store
 * remembers every dwarf id it ever saw with a channel, and a remembered dwarf with none now is
 * one whose route went away. Remembered for the run only: nothing here is worth persisting, and a
 * dwarf the app never saw with a channel is honestly one it cannot say more about.
 */

type Routed = Pick<Dwarf, 'id' | 'textDelivery'>

/**
 * The ids ever seen with a text delivery channel, with this board's added. The same set comes
 * back when the board adds nobody, so a reactive store holding it changes only when it grows; the
 * set handed in is never changed.
 */
export function rememberRoutes(
  seen: ReadonlySet<string>,
  dwarfs: readonly Routed[]
): ReadonlySet<string> {
  const added = dwarfs.filter((d) => d.textDelivery !== undefined && !seen.has(d.id))
  if (added.length === 0) return seen
  return new Set([...seen, ...added.map((d) => d.id)])
}

/** A dwarf once seen with a channel for text that has none now. */
export function routeWentAway(seen: ReadonlySet<string>, dwarf: Routed): boolean {
  return dwarf.textDelivery === undefined && seen.has(dwarf.id)
}
