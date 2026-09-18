import type { ProbeCommand } from '../platform/processProbe'
import type { DwarfAttachment } from '../domain/types'
import { consoleChunksFor } from './attachmentDelivery'

/**
 * Writing a message into a Terminal.app tab addressed by its tty (#367, #471),
 * which is what replaces the System Events keystroke path for a SEND on macOS.
 *
 * `do script <text> in <tab>` puts the text into that tab's tty as input. It is
 * not a shell command being run — measured live 2026-09-18 against a
 * `setRawMode(true)` node reader, the bytes arrived verbatim: an ESC-bracketed
 * paste marker, quotes, backslashes, `$HOME` and a backtick all landed
 * unchanged, because a tty write is not a shell parse. The tab was not raised,
 * the foreground did not move, System Events was never involved, and no
 * Accessibility permission was needed — only Automation permission to control
 * Terminal. Full record in `docs/console-hosting.md`.
 *
 * Two findings shape everything here.
 *
 * **1. Every `do script` call appends exactly ONE carriage return.** There is
 * no form of it that appends none. So a message has to travel as ONE call: the
 * attachment pastes, the words and their embedded newlines all inside a single
 * payload, with `do script`'s own Return submitting the lot once. That is the
 * opposite shape to the Windows write, where each chunk needs its own
 * `WriteConsoleInput` call and Enter needs one of its own (#404, #402) — and it
 * is the same reason in reverse. There, a call boundary is what makes a
 * keystroke a keystroke. Here, the call boundary IS the Return, so a second
 * call would be a second submit.
 *
 * It is also why this tier carries a message and nothing else. A permission
 * digit (#203) and a picker's keys (#402) must NOT be followed by a Return —
 * the digit fires the row by itself, and a stray Return behind it submits
 * whatever the composer then holds. Those stay on the keystroke adapter, which
 * can press a key without one. Two mechanisms because the acts genuinely
 * differ, rather than one bent to cover both.
 *
 * **2. The payload goes through argv, so nothing is ever escaped.** The script
 * is a constant reading `on run argv`; the tty and the text are arguments. The
 * keystroke path beside this one has to escape `\` and `"` into an AppleScript
 * literal (`escapeAppleScriptString`), which is the same class of bug
 * `consoleInputWrite.ts` removed with base64 rather than escaped its members —
 * a quote the escaper missed closes the literal and the rest of somebody's
 * message becomes script. Through argv there is no literal to close.
 */

/**
 * The largest payload this will put on an argv, in CODE POINTS.
 *
 * A real ceiling exists — `ARG_MAX` is 1 MiB on macOS — and this project has
 * already paid for meeting one blind twice (#433, #437, where an over-long
 * argv threw `ENAMETOOLONG` at the spawn). The bound sits far below it because
 * it never needs to be near: the runtime truncates a message to 4 000
 * characters before it reaches any tier, so anything approaching this is a
 * caller that has stopped bounding its own input.
 *
 * Refused rather than split, for the reason a path chunk is refused in
 * `consoleChunksFor`: a second `do script` call would be a second Return, so
 * splitting would send half a message and submit it.
 */
export const MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS = 32_768

/**
 * The AppleScript, which never changes: find the tab whose tty is the first
 * argument and put the second into it.
 *
 * `error` when no tab matches, so a payload can never fall through to a tab
 * that is merely nearby. The reach verdict (`darwinTabReach.ts`) has already
 * matched the tty by the time this runs; this is the same check at the moment
 * of the write, because a tab can close in between.
 *
 * `contents of t` is AppleScript's DEREFERENCE operator, not a tab's text —
 * reading a tab is `history of t`. Nothing here reads a tab at all, and the
 * note is kept because getting it wrong looks like a working script.
 */
const TERMINAL_TAB_WRITE_SCRIPT = [
  'on run argv',
  '  set targetTty to item 1 of argv',
  '  set payloadText to item 2 of argv',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if tty of t is targetTty then',
  '          do script payloadText in t',
  '          return "written"',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  error "no Terminal tab on that tty" number 1',
  'end run'
].join('\n')

/**
 * osascript that writes `payload` into the Terminal.app tab on `tty`, or null
 * when there is nothing it could honestly do.
 *
 * Null, fail-closed, for the three cases the builders on the Windows side
 * already refuse this way: a tty that is not a device path (it would match no
 * tab, or — worse — be a name this never verified), an empty payload (whose
 * only effect would be `do script`'s bare Return, submitting whatever the
 * composer holds), and a payload past the argv bound.
 */
export function buildTerminalTabWriteCommand(tty: string, payload: string): ProbeCommand | null {
  if (!/^\/dev\/\S+$/.test(tty)) return null
  if (payload === '') return null
  if (Array.from(payload).length > MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS) return null
  return { command: 'osascript', args: ['-e', TERMINAL_TAB_WRITE_SCRIPT, tty, payload] }
}

/**
 * The ONE payload string for a message and its attachments, or null when it
 * cannot be built.
 *
 * Built on `consoleChunksFor` rather than beside it, so the bracketed-paste
 * shape a file takes (#408) and the bound a path may not exceed (#425) are
 * decided in one place for both platforms — the marker bytes were measured
 * once and this is not the file to re-derive them in. What differs is only what
 * happens to the chunk list afterwards: Windows turns each chunk into its own
 * call, and here they are joined, because the call boundary means the opposite
 * thing on each side.
 *
 * `pressEnter` is deliberately not a parameter. `do script` always appends a
 * Return, so the Enter chunk is asked for as `false` and the submit comes from
 * the call itself; a caller that must NOT submit cannot use this tier at all,
 * and `darwinTabConsoleInput` states that refusal rather than hiding it here.
 */
export function terminalTabPayloadFor(
  text: string,
  attachments: readonly DwarfAttachment[]
): string | null {
  const chunks = consoleChunksFor(text, attachments, false)
  if (chunks === null || chunks.length === 0) return null
  return chunks.join('')
}
