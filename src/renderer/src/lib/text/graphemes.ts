/**
 * Text counted the way a person reads it: one grapheme cluster (Unicode UAX #29), whatever the
 * code points behind it, is one character. A decomposed accented letter, a flag or an emoji family
 * is one character, as the app counts a custom dwarf name (`host/modules/crew/domain/dwarfName.ts`,
 * which the renderer may not import, 05 §5.1 R8). `Intl.Segmenter` is built into Chromium and
 * Node, so nothing is added to count it.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The grapheme clusters of `text`, in order; joined they are `text` again. */
export function graphemeClusters(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment)
}

/**
 * `text` cut to its first `max` grapheme clusters with an ellipsis after them, or `text` itself
 * when it holds `max` or fewer. A cluster is never cut in half.
 */
export function trimGraphemes(text: string, max: number): string {
  const clusters = graphemeClusters(text)
  if (clusters.length <= max) return text
  return clusters.slice(0, max).join('') + '…'
}
