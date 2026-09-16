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
