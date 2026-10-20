// The console normalization of a message (spike S-022-1, ISSUE-325 passed; foreman ruling on ISSUE-167,
// 2026-10-17). Pure: no I/O (R1). The same rule as legacy `shared/consoleText.ts` `normalizeConsoleText`
// (copied, R16): a console cannot take a line break without submitting the line, so the observed-session
// relay types a message as one line, and the transcript records exactly that string.
import { attachmentKindOf } from './attachments'

/** Every whitespace run, tab and line break collapsed to one space, then trimmed. */
export function normalizeConsoleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** One file a sent message carried, as the echo rule reads it: its path and its name. */
export interface EchoedFile {
  path: string
  name: string
}

/**
 * The placeholder Claude Code writes into the row for one pasted image, whatever number its own
 * session counter gave it, wherever the read of that file finished (#408, #419; the renderer's
 * measured rule, `src/renderer/src/lib/message/echo.ts` `IMAGE_MARKER_RE`).
 */
const IMAGE_PLACEHOLDER = /\[Image #\d+\]/

/**
 * Whether a transcript record's text is the echo of `sent` (S-022-1): equal to the text as sent (the
 * stream-json path keeps it byte for byte) or to its console normalization (the relay path), with no
 * further folding.
 *
 * A send that carried `files` (#1463) is echoed by a record that carries one token per file — the
 * pasted path itself for a file, an `[Image #N]` placeholder for an image (`attachmentKindOf`) — in
 * any order and run together with the words, as the renderer's echo rule was measured
 * (`echo.ts` `expectedTokensFor` / `stripAttachmentTokens`): each token is taken off once, paths
 * first so a path shaped like a placeholder goes whole, and the words left, normalized, must equal
 * the words sent, normalized. A missing token, an extra placeholder or other words is no echo.
 */
export function echoesSentText(
  recorded: string,
  sent: string,
  files: readonly EchoedFile[] = []
): boolean {
  if (files.length === 0) return recorded === sent || recorded === normalizeConsoleText(sent)
  const rest = withoutFileTokens(recorded, files)
  return rest !== null && normalizeConsoleText(rest) === normalizeConsoleText(sent)
}

/** `recorded` with each file's token taken off once, or null when one is missing. */
function withoutFileTokens(recorded: string, files: readonly EchoedFile[]): string | null {
  let rest = recorded
  const images = files.filter((file) => attachmentKindOf(file.name) === 'image')
  for (const file of files) {
    if (attachmentKindOf(file.name) === 'image') continue
    const at = rest.indexOf(file.path)
    if (at === -1) return null
    rest = rest.slice(0, at) + rest.slice(at + file.path.length)
  }
  for (let n = 0; n < images.length; n += 1) {
    const marker = IMAGE_PLACEHOLDER.exec(rest)
    if (marker === null) return null
    rest = rest.slice(0, marker.index) + rest.slice(marker.index + marker[0].length)
  }
  return rest
}
