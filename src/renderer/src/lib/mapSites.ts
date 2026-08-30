/**
 * The authored dig sites of the valley, and the trails that join them.
 *
 * These replace the old hash-diamond `MAP_SLOTS`: every entry is a real place
 * in `MAP_BG_SRC` (a ledge, a channel fork, a fold in the hogback) rather than
 * an arbitrary point floating over the painting, so a mound reads as standing
 * somewhere instead of hovering.
 *
 * ## Why the coordinates look conservative
 *
 * Coordinates are percentages of the *rendered map box*, not of the painting:
 * `MineMound` is absolutely positioned with `left`/`top`, and the trail overlay
 * uses `viewBox="0 0 100 100"` with `preserveAspectRatio="none"`, so both share
 * this one coordinate space. The painting underneath, however, is drawn with
 * `object-fit: cover; object-position: 50% 60%` — the panel is resizable, so
 * the box and the painting almost never have the same aspect ratio and the
 * painting gets cropped.
 *
 * The saving grace is the *direction* of that error. `cover` scales the
 * painting until it covers the box, so the visible window is always a
 * sub-rectangle of the painting, and the box's coordinate space therefore maps
 * onto a contraction of the painting's — never an expansion. With
 * `object-position: 50% 60%` the contraction is toward image x 50% and toward
 * an image y between 50% and 60% (the exact centre depends on how much is
 * cropped). So an authored point can only ever drift *inward*, toward the open
 * valley floor: it can never ride up past the horizon into the sky, and it can
 * never fall off the canvas.
 *
 * Two rules follow, and `mapSites.test.ts` enforces both:
 *
 * 1. Sites live inside a safe central band (x 18-82, y 24-76). The horizon sits
 *    at roughly image y 20%, so this band keeps every site on ground at every
 *    panel shape — measured, the whole set stays within image y 25-74 from a
 *    1200x400 letterbox to a 300x1200 sliver.
 * 2. Sites are anchored to *broad* landforms, not pinpoint details. A site that
 *    needs to hit an exact 2%-wide rock to make sense would be wrong the moment
 *    the user drags the panel wider.
 *
 * The coordinates below were read off a percent grid laid over the painting at
 * the default 460x545 map box, where box and image percentages agree within
 * ~1.5 points.
 */

/** A point on the map, in percent of the rendered map box. */
export interface MapPoint {
  x: number
  y: number
}

/** One authored dig site: a named place in the painting a mine can occupy. */
export interface MineSite extends MapPoint {
  /** Names the painted feature, so a coordinate edit can be sanity-checked against the art. */
  name: string
  /**
   * Depth hint applied to the mound as a CSS `scale`. The valley is painted in
   * perspective, so a mound at the far basin must be smaller than one on the
   * near apron or the illusion collapses. Grows with y, never far from 1.
   */
  scale: number
}

/**
 * The dig sites, ordered far to near (y ascending).
 *
 * The order is load-bearing twice over: `MapView` paints mounds in this order
 * so nearer ones overlap farther ones (isometric depth), and `assignSlots`
 * treats the index as the stable identity of a site — inserting a site in the
 * middle reshuffles every mine, so append or re-author deliberately.
 *
 * Typed as a non-empty tuple so callers get a site back from index 0 without a
 * runtime guard: a valley with no dig sites is an authoring bug, not a state
 * the renderer has to survive.
 */
export const MINE_SITES: readonly [MineSite, ...MineSite[]] = [
  /*
    Far basin, below the horizon plateau — hazy, pale, cut by dry channels.
    A mound is anchored 60% of the way down its own art, so it reaches roughly
    8% of the box height above its site. The painted horizon sits at about
    image y 20%, so this row starts at y 28 rather than at the band's y 24
    edge: any higher and the far mounds would stand up into the night sky.
  */
  { name: 'Lantern Shoulder', x: 25, y: 28, scale: 0.82 },
  { name: 'Braidhead Flats', x: 47, y: 29, scale: 0.83 },
  { name: 'Crowncap Saddle', x: 68, y: 31, scale: 0.84 },
  { name: 'Mistcurl Ridge', x: 82, y: 35, scale: 0.86 },
  /* Mid terraces — the lit canyon rim, the channel network, the eastern folds. */
  { name: 'Kiln Rim Ledge', x: 19, y: 43, scale: 0.9 },
  { name: 'Ashfold Bench', x: 56, y: 44, scale: 0.91 },
  { name: 'Channel Fork', x: 36, y: 47, scale: 0.93 },
  { name: 'Hogback Cut', x: 75, y: 49, scale: 0.94 },
  /* The open apron — broad, soft dune ground where the mist banks roll in. */
  { name: 'Fogpocket Hollow', x: 24, y: 58, scale: 1.02 },
  { name: 'Apron Crest', x: 48, y: 59, scale: 1.03 },
  { name: 'Emberfold Basin', x: 70, y: 63, scale: 1.05 },
  /* Near ground, closest to the camera and largest. */
  { name: 'Sledtrack Bend', x: 33, y: 71, scale: 1.12 },
  { name: 'Valley Gate', x: 57, y: 74, scale: 1.13 }
]

/**
 * The crossroads on the open apron where every trail meets. Not a dig site —
 * it is the point that makes the valley read as one place rather than as
 * thirteen unrelated diggings, and the trail graph is checked for reachability
 * from here.
 */
export const VALLEY_HUB: MapPoint = { x: 46, y: 66 }

/**
 * Look a site up by name so a trail can never drift off the mound it serves.
 * Trails are matched to sites by exact coordinate, so copying the numbers by
 * hand would silently detach a path the first time a site is nudged.
 */
function at(name: string): MapPoint {
  const site = MINE_SITES.find((candidate) => candidate.name === name)
  if (!site) throw new Error(`Unknown mine site: ${name}`)
  return { x: site.x, y: site.y }
}

/**
 * Hand-authored trails, drawn under the mounds as a dim dirt overlay.
 *
 * Each trail is a polyline that climbs away from `VALLEY_HUB` through the
 * sites it serves, with a bend or two between them so the paths follow the
 * terrain instead of cutting straight lines across it. Trails join by sharing
 * an exact point (the peak spur leaves from Apron Crest, the near road runs
 * through the hub), which is also how the connectivity test walks the graph.
 */
export const MAP_TRAILS: readonly (readonly MapPoint[])[] = [
  /* West climb: hub → the mist hollow → the lit canyon rim → the lantern bluff. */
  [
    VALLEY_HUB,
    { x: 37, y: 64 },
    at('Fogpocket Hollow'),
    { x: 20, y: 51 },
    at('Kiln Rim Ledge'),
    { x: 21, y: 35 },
    at('Lantern Shoulder')
  ],
  /* Centre climb: hub → the apron → the channel fork → the head of the braids. */
  [
    VALLEY_HUB,
    at('Apron Crest'),
    { x: 43, y: 54 },
    at('Channel Fork'),
    { x: 40, y: 38 },
    at('Braidhead Flats')
  ],
  /* East climb: hub → the eastern basin → up through the hogback to the ridge. */
  [
    VALLEY_HUB,
    { x: 59, y: 66 },
    at('Emberfold Basin'),
    { x: 73, y: 56 },
    at('Hogback Cut'),
    { x: 79, y: 42 },
    at('Mistcurl Ridge')
  ],
  /* Peak spur: branches off the centre climb toward the crowned peak. */
  [
    at('Apron Crest'),
    { x: 52, y: 52 },
    at('Ashfold Bench'),
    { x: 62, y: 37 },
    at('Crowncap Saddle')
  ],
  /* Near road: the ore road across the foreground, passing through the hub. */
  [at('Sledtrack Bend'), { x: 39, y: 69 }, VALLEY_HUB, { x: 52, y: 70 }, at('Valley Gate')]
]

/** Serialize a trail into the `points` attribute of an SVG `<polyline>`. */
export function trailPoints(trail: readonly MapPoint[]): string {
  return trail.map((point) => `${point.x},${point.y}`).join(' ')
}

/**
 * The link class for one mound given the mound currently hovered or focused.
 *
 * Deliberately lights one chain at a time: drawing every relationship at once
 * is a hairball, so the hot mound brightens and the rest recede instead of all
 * of them competing. With nothing hot the map is neutral — no mound is dimmed
 * just because the pointer is elsewhere on the panel.
 */
export function moundLinkClass(mineId: string, hotMineId: string | null): string {
  if (hotMineId === null) return ''
  return mineId === hotMineId ? 'is-hot' : 'is-dim'
}
