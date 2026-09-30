/**
 * What a dwarf's custom name may hold (#635, decision log "Dwarf names").
 *
 * A port of the prototype's DM.filterDwarfName and DM.cleanDwarfName (the design's
 * sample-data.md), as amended by the design lead's rulings on NAMES-QUESTIONS 1, 2 and 3
 * (2026-09-28): the renderer's field filters with it while the person types, and main cleans
 * every write with it again, because main never trusts what a renderer
 * says it saved. Shared rather than duplicated so the two ends cannot disagree about a name.
 *
 * Free of Electron and Node on purpose: both processes import it directly, like truncate.ts.
 */

/** At most this many characters, counted as a person counts them (see nameChars). */
export const DWARF_NAME_MAX = 24

/**
 * Emoji are refused like control characters (PO ruling 2026-09-26): anything drawn as an emoji by
 * default, plus the pieces emoji are built from — variation selector 16, skin tones, the keycap
 * mark, regional-indicator flags and tag characters. The zero-width joiner also builds emoji
 * sequences; it is handled below with its other use joining a name's own letters
 * (NAMES-QUESTIONS 3), not here. A character that is
 * text by default (a digit, ©, ⛏) stays; only the pieces that would dress it as an emoji go.
 */
const EMOJI =
  /[\p{Emoji_Presentation}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu
// C0 and C1 controls, DEL, and the two Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * Half of a character, on its own (#635). Refused here, the one rule both the field and main's
 * re-validation read, rather than only in main: SQLite stores text as UTF-8, which cannot hold a
 * lone surrogate, so node:sqlite writes U+FFFD in its place and a name read back after a restart
 * would differ from the one published. Dropped like a control character, so what the field shows,
 * what main publishes and what a restart reads back are one string. With the `u` flag a surrogate
 * PAIR is one code point outside this range, so a whole astral character is untouched.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu

/**
 * Characters that draw as nothing or reorder the text around them (NAMES-QUESTIONS 2, design lead
 * ruling 2026-09-28): every Unicode format character (general category Cf — zero-width space,
 * left/right marks, word joiner, soft hyphen, the bidirectional embeddings, overrides and
 * isolates, the byte order mark, ...) and the three Hangul fillers, which are letters by category
 * but draw as blank. Removed like control characters, before trimming, so a name made only of them
 * saves empty and U+202E cannot flip the words around a name wherever it is printed.
 *
 * No 'g' flag: FORMAT is tested one character at a time below, and a global regex's test()
 * advances lastIndex, which would silently make it skip matches across the separate calls in
 * that loop.
 */
const FORMAT = /[\p{Cf}\u3164\u115F\u1160]/u

/**
 * The zero-width non-joiner and joiner (U+200C, U+200D) are format characters too, but Persian
 * and Indic scripts such as Devanagari use them inside ordinary words, to keep two letters from
 * joining or to force a conjunct. NAMES-QUESTIONS 3 (design lead ruling 2026-09-28) corrects
 * question 2's "every Cf including U+200C" for these two characters: kept only between two
 * letters of the same name — a letter, or a letter with its combining marks, right before it,
 * and a letter right after — and removed everywhere else (alone, leading, trailing, next to a
 * space or punctuation), with the other format characters.
 *
 * The check below reads the RAW text, before the emoji pass in withoutRefused runs, not after. A
 * joined emoji sequence (a technologist, a two-person family) is emoji characters joined by
 * exactly this character, and an emoji is never a letter — so reading the untouched
 * neighbours here correctly drops that joiner even when the emoji beside it sits with no space
 * against a real letter of the name. Reading the neighbours after emoji removal would not: with
 * the emoji gone, the joiner's new neighbours can be two real letters by coincidence of adjacency
 * (a single-joiner two-part emoji sequence typed with no surrounding space), and it would wrongly
 * survive between them — the ordering hazard the design's own prototype fix has in
 * DM.filterDwarfName (sample-data.js), avoided here by sharing one `withoutRefused` for both the
 * field and the save.
 */
const JOINER = /[\u200C\u200D]/
const LETTER_OR_MARK = /[\p{L}\p{M}]/u
const LETTER = /\p{L}/u

/**
 * `text` with every refused format character removed and a kept joiner kept, read code point by
 * code point rather than as graphemes: a joiner's neighbours are the raw characters beside it, and
 * a grapheme segmenter could bundle one of them into a cluster before this ever sees it.
 */
function withoutFormat(text: string): string {
  const chars = Array.from(text)
  const kept: string[] = []
  for (const [i, char] of chars.entries()) {
    if (JOINER.test(char)) {
      const before = chars[i - 1]
      const after = chars[i + 1]
      if (
        before !== undefined &&
        after !== undefined &&
        LETTER_OR_MARK.test(before) &&
        LETTER.test(after)
      ) {
        kept.push(char)
      }
      continue
    }
    if (!FORMAT.test(char)) kept.push(char)
  }
  return kept.join('')
}

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

/** The characters a name may never hold, whatever else it holds. */
function withoutRefused(text: string): string {
  return withoutFormat(text).replace(EMOJI, '').replace(CONTROL, '').replace(LONE_SURROGATE, '')
}

const WHITE_SPACE = /^\s+$/u

/**
 * What the field lets through while typing: no emoji, control, format or lone-surrogate
 * characters, and no more than the save would keep. `refused` says why something was dropped,
 * and names refused characters first when both happened.
 *
 * The cap measures the name that will be SAVED (NAMES-QUESTIONS 1), so the field counts as the
 * save does: leading white space is free, a run of it inside the name counts as the one space it
 * saves as, and trailing white space is free until a character follows it. The field keeps the
 * person's own spacing and stops at the character that would make the saved name 25 long, so
 * `cleanDwarfName` of what the field holds is what `cleanDwarfName` makes of the whole text.
 */
export function filterDwarfName(raw: string): { text: string; refused: DwarfNameRefusal | null } {
  const allowed = withoutRefused(raw)
  let refused: DwarfNameRefusal | null = allowed !== raw ? 'chars' : null
  let text = ''
  let saved = 0
  let spacePending = false
  for (const char of nameChars(allowed)) {
    if (WHITE_SPACE.test(char)) {
      spacePending = saved > 0
      text += char
      continue
    }
    const next = saved + (spacePending ? 1 : 0) + 1
    if (next > DWARF_NAME_MAX) {
      refused ??= 'long'
      break
    }
    saved = next
    spacePending = false
    text += char
  }
  // Stopping at the cap can leave the LAST character's own joiner with nothing after it -- the
  // grapheme that would have followed is exactly the one the cap refused. withoutFormat re-reads
  // that one boundary character and drops a joiner the cap itself left trailing, so the field
  // never shows text that would come back different once saved.
  return { text: withoutFormat(text), refused }
}

/**
 * What is saved: refused characters removed, every run of white space made one space, trimmed,
 * THEN at most DWARF_NAME_MAX characters (NAMES-QUESTIONS 1, reversing the prototype's accidental
 * cut-before-trim), with no space left at the end of a cut.
 *
 * A control character becomes a space first, as in the prototype, so one that sat between two
 * words still separates them. A format character or Hangul filler is removed outright: it draws
 * as nothing, so it separated nothing.
 */
export function cleanDwarfName(raw: string): string {
  const collapsed = withoutRefused(raw.replace(CONTROL, ' ')).replace(/\s+/g, ' ').trim()
  const chars = nameChars(collapsed)
  if (chars.length <= DWARF_NAME_MAX) return collapsed
  // The cut lands on a whole grapheme (a kept joiner never splits from the letter before it), but
  // that letter's OWN joiner can end up with nothing after it once the following grapheme is cut
  // away -- a joiner the cap itself leaves trailing. withoutFormat re-reads that one boundary
  // character and drops it, the same way a joiner typed trailing by the person would be dropped,
  // so the saved name never ends in one.
  return withoutFormat(chars.slice(0, DWARF_NAME_MAX).join('')).trimEnd()
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
