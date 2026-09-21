/**
 * Reading a JSON document off DISK, where the bytes may carry an editor's mark
 * this app did not put there (#555).
 *
 * A Windows editor — Notepad by default — writes `EF BB BF` at the head of a
 * UTF-8 file to say "this is UTF-8". The bytes are invisible in every editor
 * and the file is perfectly good UTF-8, but JSON's grammar does not admit
 * them, so `JSON.parse` throws on a character nobody can see. Each bare
 * `JSON.parse` in this app then failed its own way: the hook installer skipped
 * a whole Claude configuration directory, and `configFile` silently ignored
 * the entire configuration — on the one document whose own comment says it is
 * meant to be edited by hand.
 *
 * So the tolerance lives in one place rather than at each call site, beside
 * the fs seam it belongs to.
 *
 * What does NOT read through here, on purpose: `JSON.parse` over a CLI's
 * stdout, an HTTP body, or a SQLite TEXT column (`platform/focus.ts`,
 * `hooks/hookPayload.ts`, the provider parsers). Those bytes never came from a
 * text editor, one of them is the poll's hot path, and a parse that quietly
 * skipped a leading character there would be hiding a real protocol fault
 * rather than accommodating an encoding.
 */

/**
 * U+FEFF: the one code point `EF BB BF` decodes to once the bytes are read as
 * UTF-8. Node hands it over as an ordinary character at the head of the
 * string, which is exactly why nothing downstream notices it.
 */
export const BYTE_ORDER_MARK = '﻿'

/**
 * Whether `text` opens with the mark.
 *
 * Only at position zero. The same code point in the MIDDLE of a document is a
 * zero-width no-break space inside somebody's real string, not an encoding
 * mark, and removing it there would corrupt their data to fix nothing.
 */
export function hasByteOrderMark(text: string): boolean {
  return text.startsWith(BYTE_ORDER_MARK)
}

/**
 * `text` without its leading mark, or `text` unchanged when it has none.
 *
 * Exactly ONE mark comes off. A file that opens with two is corrupt rather
 * than doubly marked, and eating the run would turn bytes nobody can explain
 * into a parse that silently succeeded — the caller's "this file is
 * unreadable" branch is the honest answer there.
 */
export function stripByteOrderMark(text: string): string {
  return hasByteOrderMark(text) ? text.slice(BYTE_ORDER_MARK.length) : text
}

/**
 * `JSON.parse` for text read off disk: the same function, one encoding mark
 * later.
 *
 * It throws on everything `JSON.parse` throws on, which is the load-bearing
 * half — tolerating an encoding mark must never become tolerating corruption,
 * because every caller's own refusal depends on this still failing.
 */
export function parseJsonText(text: string): unknown {
  return JSON.parse(stripByteOrderMark(text))
}
