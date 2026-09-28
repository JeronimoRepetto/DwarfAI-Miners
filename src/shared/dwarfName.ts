/**
 * What a dwarf's custom name may hold (#635, decision log "Dwarf names").
 *
 * A port of the prototype's DM.filterDwarfName and DM.cleanDwarfName (the design's
 * sample-data.md), kept rule for rule: the renderer's field filters with it while the person
 * types, and main cleans every write with it again, because main never trusts what a renderer
 * says it saved. Shared rather than duplicated so the two ends cannot disagree about a name.
 *
 * Free of Electron and Node on purpose: both processes import it directly, like truncate.ts.
 */

/** At most this many characters, counted as a person counts them (see nameChars). */
export const DWARF_NAME_MAX = 24

/**
 * Emoji are refused like control characters (PO ruling 2026-09-26): anything drawn as an emoji by
 * default, plus the pieces emoji are built from — variation selector 16, the zero-width joiner,
 * skin tones, the keycap mark, regional-indicator flags and tag characters. A character that is
 * text by default (a digit, ©, ⛏) stays; only the pieces that would dress it as an emoji go.
 */
const EMOJI =
  /[\p{Emoji_Presentation}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u200D\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu
// C0 and C1 controls, DEL, and the two Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/** Why the field dropped something: characters it refuses, or text past DWARF_NAME_MAX. */
export type DwarfNameRefusal = 'chars' | 'long'

/**
 * A name split into characters as a person counts them: a letter with its accents is one.
 * Grapheme clusters where the runtime can segment them, code points where it cannot — the
 * prototype's own fallback, which still never cuts a surrogate pair in half.
 */
export function nameChars(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(
      new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text),
      (part) => part.segment
    )
  }
  return Array.from(text)
}

/**
 * What the field lets through while typing: no emoji or control characters, at most
 * DWARF_NAME_MAX characters. `refused` says why something was dropped, and names refused
 * characters first when both happened.
 */
export function filterDwarfName(raw: string): { text: string; refused: DwarfNameRefusal | null } {
  let text = raw.replace(EMOJI, '').replace(CONTROL, '')
  let refused: DwarfNameRefusal | null = text !== raw ? 'chars' : null
  const chars = nameChars(text)
  if (chars.length > DWARF_NAME_MAX) {
    text = chars.slice(0, DWARF_NAME_MAX).join('')
    refused ??= 'long'
  }
  return { text, refused }
}

/**
 * What is saved: filtered, trimmed, and every run of white space inside made one space.
 *
 * A control character becomes a space before the filter runs, as in the prototype, so one that
 * sat between two words still separates them. The cut to DWARF_NAME_MAX happens before the trim,
 * also as in the prototype.
 */
export function cleanDwarfName(raw: string): string {
  return filterDwarfName(raw.replace(CONTROL, ' ')).text.replace(/\s+/g, ' ').trim()
}

/**
 * The custom name a save leaves a dwarf with, or undefined when the save removes it: the cleaned
 * text, unless it is empty or equal to the base name (DM.setDwarfName). Duplicates across dwarfs
 * are allowed, so nothing here looks at any other dwarf.
 */
export function customNameFor(raw: string, baseName: string): string | undefined {
  const clean = cleanDwarfName(raw)
  return clean !== '' && clean !== baseName ? clean : undefined
}
