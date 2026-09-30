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

/**
 * Keep the END of `text`, at most `max` characters as a person counts them, marking what was
 * dropped from the front with one ellipsis (#635, MESSAGE-QUESTIONS 23). For a failed tool's own
 * output, whose last lines say why it stopped: line breaks are kept (a Windows one written as one),
 * and a character is never cut in half. `truncate` above is its opposite for a speech bubble,
 * which keeps the start on one line.
 */
export function truncateTail(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = Array.from(text.replace(/\r\n/g, '\n'))
  if (chars.length <= max) return chars.join('')
  return (
    ELLIPSIS +
    chars
      .slice(chars.length - (max - 1))
      .join('')
      .trimStart()
  )
}
