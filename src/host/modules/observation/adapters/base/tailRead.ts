// Bounded tail reads from a byte-offset cursor (FM-088; ADR-006 item 3; L-06): only the unread
// tail of a file is read, and never more than the size gate; a line still being written is left
// for a later read (FM-089). Byte arithmetic is UTF-8: a cursor always sits on a line boundary,
// which is a single byte, so a read never starts inside a character. Pure.

/** The lines of a tail and the bytes they consumed. */
export interface TailLines {
  /** Complete lines, each with its byte offset in the file. */
  lines: Array<{ text: string; offset: number }>
  /** Bytes from the read's start through the last consumed newline. */
  consumed: number
  /** A last line with no newline yet, or null. */
  fragment: { text: string; offset: number } | null
}

const encoder = new TextEncoder()

/** The byte length of `text` in UTF-8. */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/**
 * Splits `text`, read from file offset `start`, into lines. With `dropFirst` the text began inside
 * a line (a gated read), whose rest is skipped up to the first newline.
 */
export function splitTail(text: string, start: number, dropFirst: boolean): TailLines {
  let at = 0
  let offset = start
  if (dropFirst) {
    const first = text.indexOf('\n')
    if (first < 0) return { lines: [], consumed: 0, fragment: null }
    at = first + 1
    offset = start + byteLength(text.slice(0, at))
  }
  const lines: TailLines['lines'] = []
  for (;;) {
    const nl = text.indexOf('\n', at)
    if (nl < 0) break
    const raw = text.slice(at, nl)
    lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, offset })
    offset += byteLength(raw) + 1
    at = nl + 1
  }
  const rest = text.slice(at)
  return {
    lines,
    consumed: offset - start,
    fragment: rest === '' ? null : { text: rest, offset }
  }
}
