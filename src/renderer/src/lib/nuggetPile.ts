/**
 * Where each painted nugget sits in a mound (see #22).
 *
 * The cave used to draw its ore as five layered CSS circles, and a real user
 * looking at them could not tell what they were — "grey balls". The nuggets are
 * paintings now, and a painting only reads as a heap of ore if it is laid out
 * like one: nuggets shoulder to shoulder along the floor, each new row shorter
 * than the one below it, tilted and sized a little differently so the result is
 * a mound rather than a grid.
 *
 * Two constraints shape every number below.
 *
 * DETERMINISM. The panel re-renders on every 2-second poll. If the jitter were
 * random, a pile nobody touched would twitch continuously in the corner of the
 * user's eye. So every offset comes from hashString() — the same FNV-1a the map
 * already uses to nail a mine to its site — keyed by the slot the nugget sits
 * in rather than by its position in the list. Addressing slots instead of
 * indexes buys the stronger property: a pile that gains a nugget GROWS, it does
 * not rearrange, because nugget number four is still in slot four.
 *
 * A CAP. A mine can burn millions of tokens, and one nugget per unit would put
 * thousands of <img> nodes in a 460px panel that repaints every poll. The mound
 * therefore holds exactly as many nuggets as it has slots, and everything past
 * that is expressed by swelling the pile (pileScale) and printing the real
 * count beside it — growth stays visible at no cost in DOM.
 */
import { hashString } from './placement'

/** Nuggets in the bottom row of a full mound. Each row above holds one fewer. */
export const PILE_BASE_ROW = 6

/** Rows the mound stacks, the last of which is the single nugget at the peak. */
export const PILE_ROWS = 6

/**
 * Every slot in a full mound: 6 + 5 + 4 + 3 + 2 + 1. The cap is the mound's own
 * capacity rather than an arbitrary number, so hitting it means the mound is
 * exactly, visibly full — never a heap with a bite taken out of it.
 */
export const MAX_PILE_NUGGETS = (PILE_BASE_ROW * (PILE_BASE_ROW + 1)) / 2

/** How far a pile past the cap may swell. Beyond this it would crowd the crew. */
export const MAX_PILE_SCALE = 1.6

/** Doublings past the cap that take a pile from its natural size to MAX_PILE_SCALE. */
const SCALE_DOUBLINGS = 6

/** Horizontal room one nugget slot occupies, as a percentage of the pile box. */
const SLOT_WIDTH = 100 / PILE_BASE_ROW

/** How far each row sits above the one below it, as a percentage of the pile box. */
const ROW_RISE = 100 / PILE_ROWS

/* Jitter budgets. Small on purpose: enough that no two nuggets line up, little
   enough that the mound still reads as stacked rather than scattered. */
const JITTER_X = 3
const JITTER_Y = 4
const MAX_TILT_DEG = 14
const SIZE_VARIANCE = 0.12

/** One painted nugget, resolved to the box coordinates it should be drawn at. */
export interface PlacedNugget {
  /** Slot address, stable for the life of the pile — safe as a v-for key. */
  key: string
  /** 0 at the foot of the mound, counting up. */
  row: number
  /** Horizontal centre, as a percentage of the pile box. */
  x: number
  /** Height above the foot of the mound, as a percentage of the pile box. */
  y: number
  /** Tilt in degrees, so the mound is not a grid. */
  rotation: number
  /** Size multiplier, so no two nuggets are quite the same stone. */
  scale: number
  /** Paint order: the front row covers the rows behind it. */
  zIndex: number
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** Slots in row `row`, counting from the widest row at the foot of the mound. */
function rowCapacity(row: number): number {
  return PILE_BASE_ROW - row
}

/**
 * How many nuggets to actually draw for a whole-unit count.
 *
 * The floor is what keeps a mine with millions of tokens from emitting
 * thousands of DOM nodes; pileScale() and a printed count carry the growth from
 * there (see the module header).
 */
export function pileNuggetCount(units: number): number {
  if (Number.isNaN(units) || units <= 0) return 0
  return Math.min(MAX_PILE_NUGGETS, Math.floor(units))
}

/**
 * The mound for one material, filled bottom row first and left to right.
 *
 * `seed` identifies the pile — mine id and material, so two mines never grow
 * identical-looking heaps and a mine's coal does not mirror its gold. It must
 * NOT carry the count: the jitter is per slot precisely so that growing the
 * pile leaves every nugget already on screen exactly where it was.
 */
export function pileLayout(seed: string, units: number): PlacedNugget[] {
  const total = pileNuggetCount(units)
  const placed: PlacedNugget[] = []
  let remaining = total
  for (let row = 0; row < PILE_ROWS && remaining > 0; row++) {
    const inThisRow = Math.min(remaining, rowCapacity(row))
    for (let slot = 0; slot < inThisRow; slot++) {
      // One 32-bit hash, read four bytes at a time: four independent-looking
      // variations from a single cheap call.
      const hash = hashString(`${seed}:${row}:${slot}`)
      const spread = (byte: number): number => ((hash >>> (byte * 8)) & 0xff) / 255 - 0.5
      // Each row is inset by half a slot from the one below, which is what
      // turns rows of 6, 5, 4... into a centred mound instead of a staircase.
      const x = (row * 0.5 + slot + 0.5) * SLOT_WIDTH + spread(0) * 2 * JITTER_X
      const y = row * ROW_RISE + spread(1) * 2 * JITTER_Y
      placed.push({
        key: `${row}-${slot}`,
        row,
        x: round(clampPercent(x), 2),
        y: round(clampPercent(y), 2),
        rotation: round(spread(2) * 2 * MAX_TILT_DEG, 1),
        scale: round(1 + spread(3) * 2 * SIZE_VARIANCE, 2),
        zIndex: PILE_ROWS - row
      })
    }
    remaining -= inThisRow
  }
  return placed
}

/**
 * How much to swell a pile that has outgrown the mound.
 *
 * A mine that has mined a thousand nuggets must still read as richer than one
 * that has mined thirty, and scale is the one channel that says so without
 * adding a single node. It is logarithmic — ore piles up faster than a panel
 * can grow — and it stops at MAX_PILE_SCALE so the richest mine in the valley
 * still leaves room for the dwarfs standing next to it.
 */
export function pileScale(units: number): number {
  if (!(units > MAX_PILE_NUGGETS)) return 1
  const doublings = Math.log2(units / MAX_PILE_NUGGETS)
  const growth = Math.min(1, doublings / SCALE_DOUBLINGS)
  return round(1 + growth * (MAX_PILE_SCALE - 1), 2)
}
