// The `DwarfName` value object (06 §5.1; INV-29; US-MSG-005): a dwarf's custom name as the Host
// stores it, normalized again after UI main (NFR-SEC-08). Display only: never sent to a provider and
// never logged (NFR-PRIV-03, NFR-SEC-12). Pure: no I/O, no clock read (R1).
//
// - Emoji and control characters are dropped, and the result says so (US-MSG-005.AC05). An emoji is
//   a whole grapheme cluster holding a pictograph, a regional indicator or a keycap, so a ZWJ family
//   or a flag goes as one; a control character is any `Cc` or `Cf` code point that is not white
//   space (a bell, a zero-width space, a bidi override).
// - Every run of white space becomes one space and the ends are trimmed (US-MSG-005.AC07).
// - The name is composed (NFC) and counted in grapheme clusters, as a person counts them: an
//   accented letter is one (US-MSG-005.AC08). Above 24 it is refused.
// - Package gap (lead decision 2026-10-15): 06 counts the 24 in grapheme clusters, but the 09
//   `dwarfs.custom_name` CHECK `length(custom_name) BETWEEN 1 AND 24` counts code points, and
//   migration 1 is frozen. The name fails closed: above 24 code points it is refused too, so a name
//   of combining sequences with no composed form (x́) can never violate the CHECK.
// - An empty name, or one equal to the base name, is no custom name: a reset (US-MSG-005.AC04;
//   AMENDMENT-2, SC-AR-05).
import type { Result } from '../../../kernel/domain/values'

/** The most grapheme clusters a custom name holds (06 §5.1 `DwarfName` 1..24). */
export const DWARF_NAME_MAX_GRAPHEMES = 24

/** The most code points the 09 `dwarfs.custom_name` CHECK admits (SQLite `length()` of a text). */
const DWARF_NAME_MAX_CODE_POINTS = 24

/** A text after the `DwarfName` normalization; `name` may be empty (then it is a reset or `'empty'`). */
export interface NormalizedDwarfName {
  name: string
  /** Emoji or control characters were dropped from the text. */
  dropped: boolean
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** A grapheme cluster that is an emoji: a pictograph, a regional indicator (a flag) or a keycap. */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u
const WHITE_SPACE = /^\s+$/u
const CONTROL = /[\p{Cc}\p{Cf}]/gu

function clustersOf(text: string): string[] {
  return Array.from(graphemes.segment(text), (segment) => segment.segment)
}

/** `text` as a `DwarfName`, or `'too-long'` above 24 grapheme clusters or 24 code points once normalized. */
export function normalizeDwarfName(text: string): Result<NormalizedDwarfName, 'too-long'> {
  let dropped = false
  const kept: string[] = []
  for (const cluster of clustersOf(text.normalize('NFC'))) {
    if (EMOJI.test(cluster)) {
      dropped = true
    } else if (WHITE_SPACE.test(cluster)) {
      kept.push(' ')
    } else {
      const clean = cluster.replace(CONTROL, '')
      if (clean !== cluster) dropped = true
      kept.push(clean)
    }
  }
  const name = kept.join('').replace(/\s+/gu, ' ').trim()
  if (
    clustersOf(name).length > DWARF_NAME_MAX_GRAPHEMES ||
    [...name].length > DWARF_NAME_MAX_CODE_POINTS
  ) {
    return { ok: false, error: 'too-long' }
  }
  return { ok: true, value: { name, dropped } }
}

/** Whether saving `text` for a dwarf named `baseName` means no custom name: empty or the base name. */
export function isResetOf(baseName: string, text: string): boolean {
  const normalized = normalizeDwarfName(text)
  if (!normalized.ok) return false
  return normalized.value.name === '' || normalized.value.name === baseName.normalize('NFC')
}
