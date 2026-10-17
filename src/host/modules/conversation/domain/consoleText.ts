// The console normalization of a message (spike S-022-1, ISSUE-325 passed; foreman ruling on ISSUE-167,
// 2026-10-17). Pure: no I/O (R1). The same rule as legacy `shared/consoleText.ts` `normalizeConsoleText`
// (copied, R16): a console cannot take a line break without submitting the line, so the observed-session
// relay types a message as one line, and the transcript records exactly that string.

/** Every whitespace run, tab and line break collapsed to one space, then trimmed. */
export function normalizeConsoleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether a transcript record's text is the echo of `sent` (S-022-1): equal to the text as sent (the
 * stream-json path keeps it byte for byte) or to its console normalization (the relay path), with no
 * further folding.
 */
export function echoesSentText(recorded: string, sent: string): boolean {
  return recorded === sent || recorded === normalizeConsoleText(sent)
}
