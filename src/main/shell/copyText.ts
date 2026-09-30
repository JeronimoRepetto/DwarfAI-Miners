import { MAX_DWARF_TEXT_CHARS, type CopyTextResult } from '../domain/types'

/**
 * Copy on a message that could not be handed over (#635, decision log, Failed delivery): the
 * words exactly as the person wrote them, put on the system clipboard.
 *
 * Pure and Electron-free, like `openExternalLink.ts` beside it: Electron's `clipboard` is
 * `index.ts`'s and arrives here as the port, which is what lets every branch be asserted with a
 * hand-written fake. Electron's `clipboard.writeText` is synchronous and needs no focused
 * document, where `navigator.clipboard` does, and it is the same call on Windows, macOS and
 * Linux (on Linux it writes the CLIPBOARD selection, the one Ctrl+V pastes), so nothing here is
 * per platform.
 */

/** The one member of Electron's `clipboard` this needs. */
export interface ClipboardPort {
  writeText(text: string): void
}

/**
 * The text a renderer asked to copy, or `null` — the boundary discipline every channel in
 * `index.ts` holds. Not trimmed or normalised: Copy copies the message as written. Nothing empty,
 * and nothing past the largest message any route carries (MAX_DWARF_TEXT_CHARS), since no bubble
 * this app drew can hold more.
 */
export function parseCopyTextRequest(payload: unknown): string | null {
  if (typeof payload !== 'string') return null
  if (payload.length === 0 || payload.length > MAX_DWARF_TEXT_CHARS) return null
  return payload
}

/**
 * Write the requested text to the clipboard, and say whether it was written. A platform that
 * throws answers "not copied" rather than rejecting across the bridge: the renderer's toast
 * claims a copy only on `copied: true`.
 */
export function copyTextToClipboard(payload: unknown, clipboard: ClipboardPort): CopyTextResult {
  const text = parseCopyTextRequest(payload)
  if (text === null) return { copied: false }
  try {
    clipboard.writeText(text)
  } catch (error) {
    console.warn(`[shell] could not write the clipboard: ${String(error)}`)
    return { copied: false }
  }
  return { copied: true }
}
