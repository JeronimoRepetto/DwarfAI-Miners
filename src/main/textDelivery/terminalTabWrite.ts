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
 * **1. Every `do script` call appends exactly ONE carriage return, and that
 * Return does not SUBMIT.** There is no form of `do script` that appends none,
 * which is why a whole message still travels as one payload — attachment
 * pastes, words and embedded newlines together. What that payload's own Return
 * amounts to was read wrong until 2026-09-18.
 *
 * This file used to say "the call boundary IS the Return, so a second call
 * would be a second submit", and offered it as the exact inverse of the Windows
 * rule. **It was true of the raw-mode node reader it was measured against on
 * 2026-09-18 and false of a real TUI** — which is #404's finding arriving on a
 * second platform, for the same reason and with the same tell. Ink reads a
 * multi-character chunk arriving in ONE read as a PASTE, and inside a paste a
 * carriage return is line content rather than a submit gesture. Measured from
 * the panel on 2026-09-18 against a live Claude Code session: the one-call
 * shape pasted and never submitted, and two consecutive messages concatenated
 * in the composer until the maintainer pressed Enter by hand.
 *
 * So the submit is a SECOND `do script "" in t`, exactly as Windows needs a
 * second `WriteConsoleInput` call. The same rule, not its inverse — and the
 * generalisation to draw is the one #404 already drew: a receiver that treats
 * a lone `\r` as a submit proves nothing about one that treats a paste as a
 * paste. Both calls live inside ONE osascript script, so this stays one process
 * and one Automation event, with `SUBMIT_SPLIT_DELAY_SECONDS` between them as
 * the margin against the two being coalesced into a single read — all
 * `CHUNK_SPLIT_DELAY_MS` ever was on the other side.
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
 * `consoleChunksFor`: a message split across two payload calls would be pasted
 * in two pieces with a submit between them, sending half of somebody's words.
 */
export const MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS = 32_768

/**
 * How long the script waits between the payload call and the submit call.
 *
 * A margin, not the mechanism — the sibling of `CHUNK_SPLIT_DELAY_MS` in
 * `consoleInputWrite.ts`, and it carries the same 50 ms for the same reason.
 * What submits is that the Return arrives in a call of its OWN, not that
 * anything was waited out; the pause only insures against the two calls being
 * coalesced into one read while the receiving process is busy, which would put
 * the Return back inside the paste. Measured at 54 ms apart in the receiver on
 * 2026-09-18.
 *
 * In AppleScript `delay` takes SECONDS, so this is written as seconds and
 * named that way rather than silently being a thousandth of the Windows one.
 */
const SUBMIT_SPLIT_DELAY_SECONDS = 0.05

/**
 * The AppleScript: find the tab whose tty is the first argument, put the second
 * into it, and — unless the payload is the Enter-only shape — follow it with the
 * empty `do script` that submits.
 *
 * Built per call rather than kept as one constant because the submit half is
 * conditional, and a script that always carried it would press Return twice on
 * an Enter-only write.
 *
 * `error` when no tab matches, so a payload can never fall through to a tab
 * that is merely nearby. The reach verdict (`darwinTabReach.ts`) has already
 * matched the tty by the time this runs; this is the same check at the moment
 * of the write, because a tab can close in between. Note what the two calls do
 * NOT need: both address the tab by the same reference, so nothing is re-found
 * between them and the submit cannot land anywhere the payload did not.
 *
 * `contents of t` is AppleScript's DEREFERENCE operator, not a tab's text —
 * reading a tab is `history of t`. Nothing here reads a tab at all, and the
 * note is kept because getting it wrong looks like a working script.
 */
function terminalTabWriteScript(submits: boolean): string {
  return [
    'on run argv',
    '  set targetTty to item 1 of argv',
    '  set payloadText to item 2 of argv',
    '  tell application "Terminal"',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    '        if tty of t is targetTty then',
    '          do script payloadText in t',
    // The submit (#404, and 2026-09-18 on macOS): a Return in a call of its
    // own, because the one riding the payload is paste content to a TUI.
    ...(submits
      ? [`          delay ${SUBMIT_SPLIT_DELAY_SECONDS}`, '          do script "" in t']
      : []),
    '          return "written"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  error "no Terminal tab on that tty" number 1',
    'end run'
  ].join('\n')
}

/**
 * osascript that writes `payload` into the Terminal.app tab on `tty` and
 * submits it, or null when there is nothing it could honestly do.
 *
 * **`submits` is the caller's to state, and was derived here until #471.** It
 * used to be `payload !== ''`, which was right while a message was the only
 * caller: a message is a paste, a paste needs the second call (#404), and the
 * only empty payload was the Enter-only write. A one-digit KEY answer broke
 * that derivation — a non-empty payload that must stay ONE call, because a lone
 * digit is read as a keystroke rather than as a paste and its own appended
 * Return is the confirmation the dialog consumes. Inferring from the payload
 * would press Return twice on it, and what that second Return would answer is
 * whatever came next. So the three shapes state it themselves:
 *
 * | Caller | payload | `submits` |
 * | --- | --- | --- |
 * | a message (#367) | the pastes and the words | `true` |
 * | the Enter-only write | `''` | `false` |
 * | a permission or single-select digit (#471) | one digit | `false` |
 *
 * The refusal an empty payload used to stand in for did not go anywhere. "The
 * person typed nothing and attached nothing" is known in `terminalTabPayloadFor`
 * below, which returns null for it, and that is the level where it can be told
 * apart from a deliberate Enter. A builder cannot.
 *
 * Still null, fail-closed, for the two cases the builders on the Windows side
 * refuse the same way: a tty that is not a device path (it would match no tab,
 * or — worse — be a name this never verified), and a payload past the argv bound.
 */
export function buildTerminalTabWriteCommand(
  tty: string,
  payload: string,
  submits: boolean
): ProbeCommand | null {
  if (!/^\/dev\/\S+$/.test(tty)) return null
  if (Array.from(payload).length > MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS) return null
  return { command: 'osascript', args: ['-e', terminalTabWriteScript(submits), tty, payload] }
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
 * `WriteConsoleInput` call, and here they are joined into one paste, because
 * one `do script` is what a terminal can be handed at a time.
 *
 * `pressEnter` is deliberately not a parameter. The Enter chunk is asked for as
 * `false` because the submit is the script's own second call rather than
 * anything in the payload — a `\r` joined in here would be a line break inside
 * the paste, which is precisely the bug this shape had. A caller that must NOT
 * submit cannot use this tier at all, and `createDarwinConsoleInput` states
 * that refusal rather than hiding it here.
 *
 * Null when there is nothing to send: no words, no files. That is a different
 * fact from an empty payload reaching the builder, which is the deliberate
 * Enter-only write — see `buildTerminalTabWriteCommand`.
 */
export function terminalTabPayloadFor(
  text: string,
  attachments: readonly DwarfAttachment[]
): string | null {
  const chunks = consoleChunksFor(text, attachments, false)
  if (chunks === null || chunks.length === 0) return null
  return chunks.join('')
}
