import { MAP_SPAWN_SITE_COUNT } from '../domain/types'

/**
 * Choosing where a project's mine stands on the world map (#136).
 *
 * The design gives three rules and this is all three of them: assign randomly
 * to one UNOCCUPIED location, never let two projects share one, and avoid
 * sequential placement patterns so the distribution feels organic. The third is
 * not a fourth rule bolted on top — it is the reason the first says random. The
 * cheap implementation, "lowest free id", satisfies the first two and fills the
 * valley in a line, which is exactly what the design is ruling out.
 *
 * The choice is made ONCE, by the store, and written down. Everything after
 * that is a lookup: a mine that moved when the app restarted would be a mine
 * the user has to find again, and the design says so outright.
 */

/**
 * One free spawn location, or `null` when there are none left.
 *
 * `random` is injected for the reason every clock in this repository is: a
 * placement nobody can reproduce is a placement nobody can test. Production
 * passes `Math.random`.
 *
 * `null` at the seventy-fifth project is the honest end of "two projects must
 * never occupy the same location" — beyond 74 it cannot be kept, so nothing is
 * written and the panel places that mine itself rather than a duplicate being
 * sealed into a row forever.
 */
export function chooseMapSite(occupied: ReadonlySet<number>, random: () => number): number | null {
  const free: number[] = []
  for (let site = 1; site <= MAP_SPAWN_SITE_COUNT; site++) {
    if (!occupied.has(site)) free.push(site)
  }
  if (free.length === 0) return null
  // Clamped rather than trusted: Math.random() never reaches 1, but the source
  // is injected, and a fraction of exactly 1 would index one past the last
  // location and place the mine nowhere.
  const index = Math.min(Math.floor(random() * free.length), free.length - 1)
  return free[index]!
}
