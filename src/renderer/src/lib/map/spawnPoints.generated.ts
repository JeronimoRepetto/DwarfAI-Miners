/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by `node scripts/build-map-sites.mjs` from
 * `docs/map-spawn-points.json` (74 points measured off the design's
 * `map-mine-spawn-points.png` export). That script's header carries the conversion,
 * the measurement it rests on, and the error budget; edit the numbers there,
 * never here.
 *
 * The convention is IMAGE percent — a percentage of the map painting itself,
 * origin top-left — which is neither of the two spaces
 * `.claude/rules/coordinates.md` describes and is NOT the source JSON's own
 * percentages either. Project one of these into the rendered box with
 * `mapProjection.projectToMapBox` before drawing it.
 */

/** One of the design's spawn locations, in percent of the map painting. */
export interface MapSpawnPoint {
  /**
   * The extraction's own id, 1-based. This is the PERSISTED identity of a site:
   * the projects store remembers this number, so it must stay attached to this
   * position across a regeneration — an id is not an array index, and the order
   * below is only a drawing order.
   */
  id: number
  x: number
  y: number
}

/**
 * The 74 spawn locations, ordered as the extraction found them: down the
 * painting, farthest first. The order is a drawing order — later markers paint
 * over earlier ones, so a nearer mine overlaps a farther one — and nothing
 * else. Identity is `id`.
 *
 * Typed as a non-empty tuple so a caller can take the first point without a
 * runtime guard: a map with no spawn locations is a generation bug, not a state
 * the renderer has to survive.
 */
export const MAP_SPAWN_POINTS: readonly [MapSpawnPoint, ...MapSpawnPoint[]] = [
  { id: 1, x: 31.14, y: 28.28 },
  { id: 2, x: 29.43, y: 30.48 },
  { id: 3, x: 18.88, y: 31.88 },
  { id: 4, x: 26.74, y: 32.58 },
  { id: 5, x: 15.28, y: 34.55 },
  { id: 6, x: 45.68, y: 34.98 },
  { id: 7, x: 71.06, y: 35.45 },
  { id: 8, x: 25.9, y: 35.66 },
  { id: 9, x: 75.21, y: 36.07 },
  { id: 10, x: 67.12, y: 36.14 },
  { id: 11, x: 12.12, y: 36.34 },
  { id: 12, x: 55.33, y: 36.77 },
  { id: 13, x: 49.14, y: 36.81 },
  { id: 14, x: 59.25, y: 36.83 },
  { id: 15, x: 63.16, y: 37.46 },
  { id: 16, x: 29.42, y: 38.04 },
  { id: 17, x: 44.84, y: 39.45 },
  { id: 18, x: 35.45, y: 40.14 },
  { id: 19, x: 15.43, y: 42.76 },
  { id: 20, x: 10.79, y: 44.14 },
  { id: 21, x: 61.61, y: 44.56 },
  { id: 22, x: 38.74, y: 46.23 },
  { id: 23, x: 37.03, y: 48.25 },
  { id: 24, x: 59.23, y: 48.66 },
  { id: 25, x: 8.91, y: 49.72 },
  { id: 26, x: 43.99, y: 50.21 },
  { id: 27, x: 35.32, y: 50.55 },
  { id: 28, x: 3.42, y: 50.64 },
  { id: 29, x: 70.92, y: 51.56 },
  { id: 30, x: 11.64, y: 51.93 },
  { id: 31, x: 32.71, y: 52.28 },
  { id: 32, x: 29.42, y: 53.68 },
  { id: 33, x: 8.86, y: 54.69 },
  { id: 34, x: 26.75, y: 55.38 },
  { id: 35, x: 57.51, y: 56.67 },
  { id: 36, x: 45.68, y: 56.76 },
  { id: 37, x: 24.28, y: 57.35 },
  { id: 38, x: 7.16, y: 58.73 },
  { id: 39, x: 21.75, y: 59.43 },
  { id: 40, x: 84.28, y: 62.06 },
  { id: 41, x: 32.02, y: 62.07 },
  { id: 42, x: 7.84, y: 62.14 },
  { id: 43, x: 19.19, y: 62.14 },
  { id: 44, x: 77.77, y: 63.78 },
  { id: 45, x: 96.83, y: 63.79 },
  { id: 46, x: 10.58, y: 64.34 },
  { id: 47, x: 20.03, y: 65.17 },
  { id: 48, x: 13.32, y: 66.55 },
  { id: 49, x: 71.04, y: 67.24 },
  { id: 50, x: 17.16, y: 67.93 },
  { id: 51, x: 65.73, y: 71.01 },
  { id: 52, x: 87.71, y: 71.01 },
  { id: 53, x: 82.4, y: 72.39 },
  { id: 54, x: 93.84, y: 72.4 },
  { id: 55, x: 50.14, y: 75.7 },
  { id: 56, x: 78.63, y: 75.7 },
  { id: 57, x: 92.99, y: 77.09 },
  { id: 58, x: 81.54, y: 78.46 },
  { id: 59, x: 64.0, y: 79.66 },
  { id: 60, x: 6.3, y: 81.32 },
  { id: 61, x: 66.75, y: 81.86 },
  { id: 62, x: 86.0, y: 82.69 },
  { id: 63, x: 10.58, y: 84.07 },
  { id: 64, x: 69.49, y: 84.07 },
  { id: 65, x: 72.76, y: 87.48 },
  { id: 66, x: 91.01, y: 89.84 },
  { id: 67, x: 76.92, y: 90.73 },
  { id: 68, x: 96.82, y: 91.42 },
  { id: 69, x: 80.68, y: 91.42 },
  { id: 70, x: 22.57, y: 92.11 },
  { id: 71, x: 71.21, y: 92.12 },
  { id: 72, x: 51.85, y: 93.49 },
  { id: 73, x: 85.15, y: 96.44 },
  { id: 74, x: 57.02, y: 98.62 }
]
