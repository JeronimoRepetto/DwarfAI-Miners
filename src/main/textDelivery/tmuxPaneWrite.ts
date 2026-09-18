import type { ProbeCommand } from '../platform/processProbe'

/**
 * Writing into a tmux pane addressed by its tty — the console tier that is not
 * one platform's (#471).
 *
 * **Why this exists at all, and why it is not a port of the macOS one.**
 * Terminal.app's AppleScript dictionary names a tab by tty and writes into it,
 * and no Linux terminal has an equivalent. Writing to `/dev/pts/N` from another
 * process reaches the SCREEN, not the program's input; the ioctl that did
 * inject input, `TIOCSTI`, has been disabled by default since kernel 6.2. So
 * Linux offers exactly two things: a multiplexer that addresses panes exactly,
 * or synthetic keystrokes into whatever window holds focus. This is the first,
 * and it is the only one that can be built without a reach verdict nobody has
 * measured — a keystroke tier without one types into the wrong window, which is
 * the whole of #329.
 *
 * **It serves both POSIX platforms, not just Linux.** A tmux pane is addressed
 * the same way wherever tmux runs, so a macOS session in iTerm2, or in any host
 * under tmux, reaches this tier when no Terminal.app tab carries its tty. That
 * is why it lives here rather than in a `linux*` module.
 *
 * **Unmeasured.** Nothing in this file has been run against a live tmux: there
 * is no Linux machine yet and the maintainer's Mac was measured through
 * Terminal.app instead. The command shapes come from tmux's documented
 * interface and the payload shapes from what #404/#485 measured about the
 * receiving TUI, which is the part that is platform-independent. The
 * measurement checklist the Linux day owes is in `docs/console-hosting.md`.
 *
 * ## The three calls a message takes, and why it is three
 *
 * 1. `load-buffer -b <name> -` puts the payload in a NAMED tmux buffer, read
 *    from stdin. Named so it never disturbs the person's own paste stack, and
 *    stdin so the payload never touches an argv — the ceiling this project has
 *    already met twice (#433, #437), and here it would be met by an ordinary
 *    long message rather than by a script.
 * 2. `paste-buffer -p -d -b <name> -t <pane>` pastes it. `-p` wraps it in
 *    BRACKETED PASTE, which is the shape #408 measured a CLI to accept a file
 *    path in and the shape a multi-line message must arrive as to stay one
 *    prompt. `-d` deletes the buffer afterwards, so nothing of the person's
 *    message is left sitting in tmux for the next `paste-buffer` to find.
 * 3. `send-keys -t <pane> Enter` submits, in a call of its OWN. That is #404
 *    and #485: a carriage return arriving inside a paste is line content, not a
 *    submit gesture, so it has to be a separate write. `-p`'s bracketing makes
 *    this MORE certain rather than less — the receiving TUI is being told
 *    explicitly that the first write is a paste.
 *
 * A key answer is one call and no Enter, exactly as the darwin key route is
 * (#471): `send-keys -l <digit>` sends the digit literally, and the digit fires
 * its row by itself.
 */

/** One pane as `-F '#{pane_id} #{pane_tty} #{pane_pid}'` prints it. */
export interface TmuxPane {
  paneId: string
  tty: string
  pid: number
}

/** A matched pane, or the named reason there is none — the shape `darwinTabReach` uses. */
export type TmuxPaneReach =
  { reach: 'own-console'; paneId: string } | { reach: 'terminal-host'; error: string }

/** No panes came back at all, so tmux is not running (or not ours to see). */
export const TMUX_NOT_RUNNING =
  'This session is not running inside tmux, which is the only terminal the panel can write into on this system.'

/**
 * tmux is running and no pane is on that tty.
 *
 * One sentence for two facts the panel cannot tell apart and the person acts on
 * the same way: the session is in a terminal outside tmux, or its pane has gone.
 */
export const TMUX_NO_PANE_FOR_TTY =
  'That session is not in a tmux pane this panel can address, so the message went by relay.'

/**
 * The buffer this app pastes through.
 *
 * NAMED rather than the default stack on purpose. `load-buffer` with no `-b`
 * pushes onto the same stack the person's own copies live on, so an unnamed
 * write would shuffle their paste history every time the panel sent a message —
 * and `-d` would then delete a buffer that might not be ours. A fixed name is
 * safe because `-d` removes it at the end of the same paste, so two sends can
 * only ever overwrite this app's own buffer.
 */
export const TMUX_BUFFER_NAME = 'dwarfai-miners'

/**
 * The margin between the paste and the Enter, in milliseconds.
 *
 * The same family as darwin's `SUBMIT_SPLIT_DELAY_SECONDS` and the same 200 ms,
 * for the same reason and with the same caveat: it is a MARGIN, not the
 * mechanism. What submits is that the Enter is a separate write; the pause only
 * insures against the two being coalesced into one read while the receiving
 * process is busy. 200 rather than 50 because macOS measured 50 to be too thin
 * exactly where the target was slower to reach (#367) — an untested tier should
 * start at the value the tested one had to be corrected to, not at the value it
 * was corrected from.
 *
 * Milliseconds here and seconds there because each is the unit its own runner
 * takes; the two are deliberately named for their units so nobody reads one as
 * a thousandth of the other.
 */
export const TMUX_SUBMIT_SPLIT_DELAY_MS = 200

/**
 * The largest payload this puts in a buffer, in CODE POINTS.
 *
 * Generous because stdin has no argv ceiling to meet — the bound is here so an
 * unbounded caller cannot hand tmux an unbounded buffer, not because anything
 * near it is expected. The runtime truncates a message to 4 000 characters well
 * below it.
 */
export const MAX_TMUX_PAYLOAD_CODE_POINTS = 32_768

/**
 * A tmux pane id: `%` and digits, which is the whole grammar tmux uses.
 *
 * Validated rather than trusted even though it comes from tmux's own output,
 * for the reason every builder on this path validates: a pane id reaches a
 * command line, and the one place a malformed one could go is somewhere nobody
 * intended.
 */
const PANE_ID = /^%\d+$/

/** The one key shape this tier carries, matching the darwin key route (#471). */
const ADDRESSABLE_KEY = /^[1-9]$/

/** Every pane in every session, with the three fields the match needs. */
export function buildTmuxListPanesCommand(): ProbeCommand {
  return {
    command: 'tmux',
    args: ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty} #{pane_pid}']
  }
}

/**
 * Parse `list-panes -F '#{pane_id} #{pane_tty} #{pane_pid}'`.
 *
 * A row that does not read is SKIPPED rather than thrown on, the discipline
 * `parseUnixProcessRows` already holds: one pane in an unexpected shape must
 * not cost the panes beside it, and a pane that cannot be read simply cannot be
 * matched.
 */
export function parseTmuxPanes(stdout: string): TmuxPane[] {
  const panes: TmuxPane[] = []
  for (const line of stdout.split('\n')) {
    const match = /^(%\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line)
    if (match === null) continue
    panes.push({ paneId: match[1] as string, tty: match[2] as string, pid: Number(match[3]) })
  }
  return panes
}

/**
 * The pane on `tty`, or null.
 *
 * Matched on the TTY rather than on the pid, and the difference matters: the
 * pane's `#{pane_pid}` is the process tmux started in it — the shell — while
 * the session we are addressing is a descendant of that shell. The tty is the
 * one field both of them share.
 */
export function selectTmuxPaneId(panes: readonly TmuxPane[], tty: string): string | null {
  return panes.find((pane) => pane.tty === tty)?.paneId ?? null
}

/**
 * The verdict for one session's tty against the panes tmux reported — the same
 * shape and the same two answers as `darwinConsoleReachFor`.
 *
 * No panes at all is told apart from no MATCHING pane on purpose. They are
 * different facts about the person's machine and they read differently: one
 * says tmux is not running, the other says this session is not in it.
 */
export function tmuxPaneReachFor(tty: string | null, panes: readonly TmuxPane[]): TmuxPaneReach {
  if (panes.length === 0) return { reach: 'terminal-host', error: TMUX_NOT_RUNNING }
  if (tty === null) return { reach: 'terminal-host', error: TMUX_NO_PANE_FOR_TTY }
  const paneId = selectTmuxPaneId(panes, tty)
  if (paneId === null) return { reach: 'terminal-host', error: TMUX_NO_PANE_FOR_TTY }
  return { reach: 'own-console', paneId }
}

/**
 * Put `payload` in this app's named buffer, read from STDIN.
 *
 * Null for an empty payload — `paste-buffer` on an empty buffer pastes nothing
 * and the Enter behind it would then submit whatever the composer already held
 * — and null past the bound.
 */
export function buildTmuxLoadBufferCommand(payload: string): ProbeCommand | null {
  if (payload === '') return null
  if (Array.from(payload).length > MAX_TMUX_PAYLOAD_CODE_POINTS) return null
  return { command: 'tmux', args: ['load-buffer', '-b', TMUX_BUFFER_NAME, '-'], stdin: payload }
}

/** Paste this app's buffer into `paneId` as a bracketed paste, then delete it. */
export function buildTmuxPasteBufferCommand(paneId: string): ProbeCommand | null {
  if (!PANE_ID.test(paneId)) return null
  return {
    command: 'tmux',
    args: ['paste-buffer', '-p', '-d', '-b', TMUX_BUFFER_NAME, '-t', paneId]
  }
}

/** The submit: Enter as a key, in a write of its own (#404, #485). */
export function buildTmuxSubmitCommand(paneId: string): ProbeCommand | null {
  if (!PANE_ID.test(paneId)) return null
  return { command: 'tmux', args: ['send-keys', '-t', paneId, 'Enter'] }
}

/**
 * One digit into `paneId`, sent LITERALLY and with no Enter behind it.
 *
 * `-l` is what stops tmux reading the payload as a key NAME, which is the guard
 * that matters here: without it a key argument is interpreted, and the set of
 * things tmux interprets includes far more than digits. With it, and with the
 * shape guard below, the only thing this command can carry is one of nine
 * characters.
 *
 * No Enter, because a digit fires its row by itself — measured on macOS
 * 2026-09-18 for the permission dialog and the single-select picker (#471), and
 * a property of the TUI rather than of the transport, which is why it is
 * expected to hold here. Expected, not measured: the Linux day owes this one.
 */
export function buildTmuxKeyCommand(paneId: string, key: string): ProbeCommand | null {
  if (!PANE_ID.test(paneId)) return null
  if (!ADDRESSABLE_KEY.test(key)) return null
  return { command: 'tmux', args: ['send-keys', '-t', paneId, '-l', key] }
}
