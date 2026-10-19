// Where a new mine's marker stands on the map (06 §4.1 `MapSite`; US-MAP-004.AC01): one free spawn
// site picked at random, never a site another mine holds, and no sequential pattern. Pure: the
// spawn sites and the random source are inputs.
//
// Transplanted from `src/main/projects/mapSite.ts` (`chooseMapSite`), with a site now its measured
// image-percent position instead of an index into the renderer's table. The site is chosen once,
// when the mine's row is first written, and kept: a mine that moved would have to be found again.
import type { MapSite } from './mine'

/** Whether two sites are the same position. */
export function sameMapSite(a: MapSite, b: MapSite): boolean {
  return a.xPct === b.xPct && a.yPct === b.yPct
}

/**
 * One of `sites` that no mine of `occupied` holds, chosen with `random` (a fraction in [0, 1)), or
 * null when every site is taken: two mines never share a site, so past the last one nothing is
 * stored and the map places that marker itself.
 */
export function chooseMapSite(
  sites: readonly MapSite[],
  occupied: readonly MapSite[],
  random: () => number
): MapSite | null {
  const free = sites.filter((site) => !occupied.some((taken) => sameMapSite(taken, site)))
  if (free.length === 0) return null
  // Clamped: an injected source answering exactly 1 would index one past the last free site.
  const index = Math.min(Math.floor(random() * free.length), free.length - 1)
  return free[index]!
}
