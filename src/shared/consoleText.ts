/**
 * The rule a console applies to a message before anything is typed into it —
 * whitespace runs collapsed to one space, then trimmed (#404, #419).
 *
 * Shared for the reason `externalLinkOf` already is in this file's sibling:
 * MAIN's console write (`textDelivery/sendKeys.ts`'s `toConsoleLine`) and the
 * RENDERER's echo reconciliation (`lib/message/echo.ts`) both have to read a
 * message the same way the console itself will before comparing anything
 * against a transcript row, and two copies of the same regex is how one of
 * them drifts from the other. A message typed with Shift+Enter reaches the
 * console as one line; the echo the panel is still holding keeps its own
 * newlines, and normalizing both sides through this one rule — rather than
 * trusting `.trim()` alone — is what lets the comparison see the same string
 * the console does (#419).
 */
export function normalizeConsoleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The largest chunk `boundedChunks` below will hand a caller, in CODE POINTS
 * (issue #425).
 *
 * One `WriteConsoleInput` call carrying a long message loses its own
 * beginning somewhere between ConPTY's translation and a live Claude Code
 * TUI's reader — a defect no raw-mode receiver can show, which is why
 * `docs/console-hosting.md` §6's earlier 16 384-character reading never
 * settled this. A BOUNDED chunk, one `WriteConsoleInputW` call each with the
 * builder's own pause between them, does not lose anything: measured live
 * 2026-09-16 at 200, 400 and 800 code points, three runs each, every run
 * arriving whole. 500 sits below the largest size actually exercised (800)
 * rather than at its edge — three quick runs on one machine cannot stand in
 * for every load and terminal condition a real delivery meets — and still
 * three times the original known-safe 200. Full table in
 * `docs/console-hosting.md` §6.
 */
export const MAX_CONSOLE_CHUNK_CODE_POINTS = 500

/**
 * Split `text` into chunks of at most `MAX_CONSOLE_CHUNK_CODE_POINTS` code
 * points each, never inside a surrogate pair (#425).
 *
 * Iterating with `for…of`/`Array.from` walks CODE POINTS rather than UTF-16
 * code units, which is the whole point: an emoji is one code point but two
 * code units, and a boundary that split the pair would hand
 * `WriteConsoleInput` half a surrogate, which is not a character at all.
 *
 * Never emits an empty chunk — empty input returns an empty array rather
 * than `['']` — because a chunk with nothing in it spends a
 * `WriteConsoleInputW` call writing zero records, which
 * `buildConsoleInputSequenceCommand` already refuses outright.
 *
 * Lives here, beside `normalizeConsoleText`, rather than in
 * `consoleInputWrite.ts`: both are pure text-shaping rules with no Electron
 * or Node import, and both callers that need bounding —
 * `buildConsoleInputWriteCommand` and `consoleChunksFor` — already reach into
 * `shared/` for `toConsoleLine`'s own rule, so this is the one place both
 * already import from.
 */
export function boundedChunks(text: string): string[] {
  const points = Array.from(text)
  const chunks: string[] = []
  for (let index = 0; index < points.length; index += MAX_CONSOLE_CHUNK_CODE_POINTS) {
    chunks.push(points.slice(index, index + MAX_CONSOLE_CHUNK_CODE_POINTS).join(''))
  }
  return chunks
}
