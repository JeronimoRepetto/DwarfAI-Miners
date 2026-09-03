/**
 * Which of the four map paintings the world is wearing right now (#136).
 *
 * The design gives one table, keyed on the user's LOCAL clock — `07:00-11:59`
 * morning, `12:00-15:59` day, `16:00-19:59` sunset, `20:00-06:59` night — and
 * that is the whole rule. It is transcribed once, here, as a pure function of a
 * Date, so the panel never grows a second opinion about what hour it is and the
 * table can be checked from both sides of every boundary without a clock.
 *
 * Local, never UTC: `getHours()` is deliberate. The design says the user's own
 * time of day, and a UTC reading would draw a Buenos Aires morning as night.
 *
 * The four variants are RENDERER-only. Nothing crosses a process boundary here
 * — main has no opinion about the sky — so this type stays out of
 * `shared/contracts.ts` by the rule in AGENTS.md.
 */

/** The four paintings, in the order the design's own comparison strip shows them. */
export const MAP_TIME_VARIANTS = ['morning', 'day', 'sunset', 'night'] as const

export type MapTimeVariant = (typeof MAP_TIME_VARIANTS)[number]

/**
 * How often the panel re-reads the clock. The design marks refresh cadence
 * **Unspecified**, so this is a decision.
 *
 * A minute, rather than one long timeout scheduled at the next boundary. The
 * timeout is tempting — it wakes exactly once and switches on the second — but
 * a laptop suspended at 19:50 and opened at 21:00 has slept through its own
 * alarm, and a timer that fires once fires late and leaves the map wearing the
 * afternoon until the next boundary. A cheap minute tick is at worst 59 seconds
 * behind, and is right again within a minute of the machine waking.
 */
export const MAP_TIME_REFRESH_MS = 60_000

/**
 * The variant for one moment. Boundaries are the design's: each range includes
 * its opening hour and runs to the minute before the next one starts, and night
 * is the one that wraps midnight — which is why it is the fallthrough rather
 * than a range with two halves.
 */
export function mapVariantAt(now: Date): MapTimeVariant {
  const hour = now.getHours()
  if (hour >= 7 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 16) return 'day'
  if (hour >= 16 && hour < 20) return 'sunset'
  return 'night'
}
