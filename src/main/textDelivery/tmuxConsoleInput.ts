import { buildPidTtyCommand, parsePidTty } from '../platform/darwinTabReach'
import type { CommandRunner } from '../platform/unixFocus'
import { consoleChunksFor } from './attachmentDelivery'
import type {
  ConsoleInputAdapter,
  ConsoleMessageOutcome,
  ConsoleMessageRequest
} from './osascriptInput'
import {
  TMUX_NOT_RUNNING,
  TMUX_SUBMIT_SPLIT_DELAY_MS,
  buildTmuxKeyCommand,
  buildTmuxListPanesCommand,
  buildTmuxLoadBufferCommand,
  buildTmuxPasteBufferCommand,
  buildTmuxSubmitCommand,
  parseTmuxPanes,
  tmuxPaneReachFor,
  type TmuxPaneReach
} from './tmuxPaneWrite'

/**
 * The `ConsoleInputAdapter` over the tmux pane tier (#471) — the one adapter on
 * this path that belongs to no platform.
 *
 * `darwinConsoleInput.ts` is the model and the differences are all in one
 * direction: a pane is addressed by id rather than a tab by tty, the payload
 * travels on STDIN rather than through an argv, and the submit is a call this
 * adapter makes rather than a Return `do script` appends. Everything else —
 * the reach verdict first, the refusal that carries `neverStarted` so the relay
 * may carry the same words, the `null` for a key that is not this route's — is
 * held identically, because the port above reads both the same way.
 *
 * **Why it is not a Linux adapter.** tmux addresses a pane the same way
 * wherever it runs, so a macOS session in iTerm2 or in any host under tmux
 * reaches this too — see `tmuxPaneWrite.ts`, and `darwinConsoleInput.ts`, which
 * offers this tier an act its Terminal.app tab could not carry.
 *
 * **Unmeasured.** No command here has been run against a live tmux; the shapes
 * come from tmux's documented interface and the payloads from what #404/#485
 * measured about the receiving TUI. `docs/console-hosting.md` holds the
 * checklist a Linux desktop owes.
 */

/**
 * The message had no words and no files, or one attachment path past the bound
 * a console chunk may not exceed (#425). Nothing ran.
 */
export const TMUX_MESSAGE_UNBUILDABLE = 'That message could not be prepared for the tmux pane.'

/**
 * `load-buffer` failed, which is the one failure on this path that PROVES the
 * console received nothing: the paste that would have delivered it reads the
 * buffer this call was supposed to fill, and it never ran.
 */
export const TMUX_WRITE_NEVER_STARTED = 'tmux would not take that message, so nothing was written.'

/**
 * `paste-buffer` or the submit behind it failed.
 *
 * Deliberately says nothing about whether the words arrived. tmux may have
 * pasted part of the buffer before it failed, and a submit that failed leaves
 * the whole message sitting in the composer — neither licenses a second tier to
 * send it again, which is the cautious reading the Windows port takes.
 */
export const TMUX_PASTE_FAILED = 'The message could not be written into that tmux pane.'

/** An unexplained `send-keys` failure on the key route: the row may have been pressed. */
export const TMUX_KEY_WRITE_FAILED = 'The key could not be written into that tmux pane.'

/**
 * Why the two keystroke-only acts are refused here rather than attempted.
 *
 * `sendText` and `sendInterrupt` mean "put this key into whatever window holds
 * the foreground" on every port above — that is what System Events and SendKeys
 * do, and it is the whole of the precondition they carry. tmux has no such act:
 * it writes into a pane it was given the id of, and it cannot see a window
 * server at all. Answering `false` sends the caller to its own refusal, which
 * is what a platform without a keystroke tier already produced.
 */
export const TMUX_CARRIES_NO_KEYSTROKES =
  'tmux can write into a pane but cannot press a key at the foreground window, ' +
  'so this gesture was not sent.'

/**
 * The one key shape this route carries, the same bound `darwinConsoleInput.ts`
 * holds and for the same reason: `1`-`9` number a row in the permission dialog
 * and in a single-select picker, and `0` numbers none. Kept here rather than
 * read off the builder so a key that is not ours costs no command at all.
 */
const ADDRESSABLE_KEY = /^[1-9]$/

/** Injected for tests; the real one is a timer, as it is on every other tier. */
export interface TmuxConsoleInputOptions {
  sleep?: (ms: number) => Promise<void>
}

/**
 * Resolve a pid to the tmux pane hosting it, or to the reason there is none.
 *
 * Two commands, in the order `createDarwinConsoleReach` runs its own: the tty
 * first because it is cheap, then every pane. Unlike that one, the second
 * command is NOT skipped when the first fails — telling "tmux is not running"
 * apart from "your session is not in one of its panes" needs both answers, and
 * the first is the sentence a person without tmux must see.
 *
 * `buildPidTtyCommand` and `parsePidTty` come from `darwinTabReach.ts` and are
 * POSIX-generic despite the file they live in: `ps -o tty= -p <pid>` prints
 * `ttys001` on macOS and `pts/4` on Linux, and the same normalisation turns
 * both into the device path tmux reports.
 */
export function createTmuxPaneReach(run: CommandRunner) {
  return async function reach(pid: number): Promise<TmuxPaneReach> {
    const ttyCommand = buildPidTtyCommand(pid)
    let tty: string | null = null
    if (ttyCommand !== null) {
      try {
        tty = parsePidTty(await run(ttyCommand))
      } catch {
        // An unreadable process list is not a tty, and no pane can match one.
        tty = null
      }
    }
    try {
      return tmuxPaneReachFor(tty, parseTmuxPanes(await run(buildTmuxListPanesCommand())))
    } catch {
      // No tmux binary, or no server to talk to. Both are the ordinary state of
      // a machine that does not use tmux, and both read the same way.
      return { reach: 'terminal-host', error: TMUX_NOT_RUNNING }
    }
  }
}

/** The tmux console input adapter, for any platform tmux runs on (#471). */
export function createTmuxConsoleInput(
  run: CommandRunner,
  options: TmuxConsoleInputOptions = {}
): ConsoleInputAdapter & {
  sendMessage: NonNullable<ConsoleInputAdapter['sendMessage']>
  sendKey: NonNullable<ConsoleInputAdapter['sendKey']>
} {
  const reachOf = createTmuxPaneReach(run)
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function sendMessage(request: ConsoleMessageRequest): Promise<ConsoleMessageOutcome> {
    const chunks = consoleChunksFor(request.text, request.attachments ?? [], false)
    if (chunks === null || chunks.length === 0) {
      return { delivered: false, error: TMUX_MESSAGE_UNBUILDABLE, neverStarted: true }
    }
    const load = buildTmuxLoadBufferCommand(chunks.join(''))
    if (load === null) {
      return { delivered: false, error: TMUX_MESSAGE_UNBUILDABLE, neverStarted: true }
    }
    const reach = await reachOf(request.pid)
    if (reach.reach === 'terminal-host') {
      return { delivered: false, error: reach.error, neverStarted: true }
    }
    const paste = buildTmuxPasteBufferCommand(reach.paneId)
    // Unreachable through a pane id tmux itself printed — kept because both
    // builders are fail-closed and a caller that swallowed a null would report
    // a success nothing had performed.
    if (paste === null) {
      return { delivered: false, error: TMUX_MESSAGE_UNBUILDABLE, neverStarted: true }
    }
    try {
      await run(load)
    } catch {
      return { delivered: false, error: TMUX_WRITE_NEVER_STARTED, neverStarted: true }
    }
    try {
      await run(paste)
    } catch {
      return { delivered: false, error: TMUX_PASTE_FAILED }
    }
    /*
     * A message that must NOT submit stops here, and this is the one act the
     * Terminal.app tab write cannot perform (`RETURN_CANNOT_BE_WITHHELD`).
     * There the Return is `do script`'s own and no caller can remove it; here
     * the submit is a separate call, so withholding it is simply not making it.
     */
    if (!request.pressEnter) return { delivered: true }
    const submit = buildTmuxSubmitCommand(reach.paneId)
    if (submit === null) return { delivered: false, error: TMUX_PASTE_FAILED }
    // The margin, not the mechanism: what submits is that the Enter is its own
    // write (#404, #485). See TMUX_SUBMIT_SPLIT_DELAY_MS for the 200.
    await sleep(TMUX_SUBMIT_SPLIT_DELAY_MS)
    try {
      await run(submit)
      return { delivered: true }
    } catch {
      return { delivered: false, error: TMUX_PASTE_FAILED }
    }
  }

  /**
   * One digit into the pane, or `null` for a key this route cannot carry.
   *
   * The shape guard is the builder's own and it comes FIRST, before the reach:
   * a key that is not ours must cost no `ps` and no `tmux`, and must leave the
   * keystroke path exactly as it found it. `pressEnter` is ignored because
   * `send-keys -l` appends nothing — a digit fires its row by itself, which is
   * the macOS measurement of 2026-09-18 and the one this tier inherits unproven.
   */
  async function sendKey(request: ConsoleMessageRequest): Promise<ConsoleMessageOutcome | null> {
    if (!ADDRESSABLE_KEY.test(request.text)) return null
    const reach = await reachOf(request.pid)
    if (reach.reach === 'terminal-host') {
      return { delivered: false, error: reach.error, neverStarted: true }
    }
    const command = buildTmuxKeyCommand(reach.paneId, request.text)
    if (command === null) return null
    try {
      await run(command)
      return { delivered: true }
    } catch {
      // Cautious: the row may have been pressed, and a row pressed twice is a
      // different answer from the one the person gave.
      return { delivered: false, error: TMUX_KEY_WRITE_FAILED }
    }
  }

  return {
    sendText: async () => false,
    sendInterrupt: async () => false,
    sendMessage,
    sendKey
  }
}
