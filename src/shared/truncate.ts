/** Single-character ellipsis appended to truncated text. */
const ELLIPSIS = '…'

/**
 * Truncate `text` to at most `max` characters, appending an ellipsis when cut.
 * Newlines are collapsed to spaces so the result stays single-line friendly
 * (speech bubbles); the raw message is kept elsewhere, truncation is UI-only.
 */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s*\r?\n\s*/g, ' ')
  if (max <= 0) return ''
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1).trimEnd() + ELLIPSIS
}
