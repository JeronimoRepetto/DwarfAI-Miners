import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { focusSessionConsole, type FocusOutcome, type ShellRunner } from '../platform/focus'
import { createProcessEnd, type ProcessEndPort } from '../platform/processEnd'
import {
  createProcessProbe,
  sameProcessStart,
  type ProcessProbePort
} from '../platform/processProbe'
import type {
  ClipboardPort,
  CodexQueueRequest,
  ConsoleTextRequest,
  EndSessionRequest,
  InterruptRequest,
  RelayTextRequest,
  TextDeliveryOutcome,
  TextDeliveryPort
} from './port'
import { deliverViaCodexQueue, runCodexQueueProcess, type CodexQueueRunner } from './codexQueue'
import {
  GRACEFUL_EXIT_POLL_COUNT,
  GRACEFUL_EXIT_POLL_INTERVAL_MS,
  SESSION_NOT_ENDED,
  SESSION_NOT_VERIFIED
} from './endSession'
import {
  createConsoleWorker,
  createResilientShellRunner,
  type ConsoleWorker,
  type ConsoleWorkerProcess
} from './consoleWorker'
import {
  deliverViaRelay,
  runRelayProcess,
  type RelayInvocation,
  type RelayResult,
  type RelayRunner
} from './relayRunner'
import {
  buildGracefulExitCommand,
  buildPasteCommand,
  buildSendInterruptCommand,
  buildSendKeysCommand
} from './sendKeys'
import { createStageTimer, type StageTimings } from './timing'

export type { RelayInvocation, RelayResult, RelayRunner }

/**
 * A process-local clipboard, the default when none is injected (#319).
 *
 * The real port is Electron's `clipboard`, composed at the app's root and
 * injected in — this module holds no Electron import, exactly as it holds none
 * for focus. This fallback keeps the port constructible for a build that never
 * pastes (the runtime composing adapters whose delivery it then overrides, a
 * test exercising another tier); a real paste always runs against the injected
 * system clipboard.
 */
function createInMemoryClipboard(): ClipboardPort {
  let value = ''
  return {
    read: () => value,
    write: (text: string) => {
      value = text
    }
  }
}

/**
 * Windows implementation of TextDeliveryPort.
 *
 * Nothing here logs the message: only lengths, channels and verdicts. Every
 * failure mode — a window that will not come forward, a missing binary, a
 * relay that runs long — becomes a `delivered: false` outcome with a reason
 * the panel can show, never a rejection, so one bad send can never take the
 * tray app down.
 */

/** How long the local keystroke command may run before it is abandoned. */
const CONSOLE_COMMAND_TIMEOUT_MS = 120_000

/**
 * Why a keystroke stops at a window the ancestor walk had to reach (#329).
 *
 * Windows Terminal and VS Code draw several sessions in tabs of ONE window and
 * expose no way to select a tab by pid, so foregrounding that window raises
 * whichever tab the person last used. A `true` from focus was read as "this
 * session's console is in front" and it is not: measured live, an Esc aimed at
 * one Claude foreman interrupted the other one, in the tab that happened to be
 * active. Nothing is sent, and `neverStarted` says nothing was — so the relay
 * behind the console tier carries the message instead, labelled as another
 * session, which is a price the maintainer accepted where a keystroke in the
 * wrong session is not.
 */
const SHARED_TERMINAL_WINDOW =
  'This session shares its terminal window with other tabs, and the panel cannot tell ' +
  'which tab is its own.'

/** That refusal, identical for every keystroke this port can send (#329). */
function sharedWindowRefusal(stages: StageTimings): TextDeliveryOutcome {
  return { delivered: false, error: SHARED_TERMINAL_WINDOW, neverStarted: true, stages }
}

export interface WindowsTextDeliveryOptions {
  /** Cheap model the one-shot relay turn runs on. */
  relayModel: string
  /** How long the relay may run before its verdict is "timed out". */
  relayTimeoutMs: number
  home?: string
  /** Environment the relay child inherits; defaults to this process's. */
  env?: NodeJS.ProcessEnv
  /**
   * Injected for tests; defaults to the real window-focus path.
   *
   * The SCOPED focus, not the boolean one click-to-focus reads (#329): every
   * method below sends a keystroke, and a keystroke may only follow a window
   * this session is provably alone on. See `FocusReach` in platform/focus.ts.
   */
  focus?: (pid: number) => Promise<FocusOutcome>
  /**
   * The system clipboard the paste path saves, sets and restores (#319).
   * Injected — composed from Electron's `clipboard` at the app's root — so this
   * module holds no Electron import; defaults to a process-local clipboard for a
   * build that never pastes.
   */
  clipboard?: ClipboardPort
  /**
   * The per-action fallback shell runner.
   *
   * Left alone, console actions travel through one long-lived powershell.exe
   * (see consoleWorker.ts) and only reach this runner when that shell cannot be
   * started at all. Injecting it WITHOUT `spawnConsoleWorker` replaces the
   * transport outright, which is the shape the unit tests want.
   */
  runPowerShell?: ShellRunner
  /** Injected for tests; defaults to a real long-lived powershell.exe. */
  spawnConsoleWorker?: () => ConsoleWorkerProcess
  /** Injected for tests; defaults to a real claude.exe spawn. */
  runRelay?: RelayRunner
  /**
   * Resolves the codex binary through the CLI detection port (#91), or
   * undefined when it is not installed. Omitted, the queue tier has no binary
   * to address and refuses with a reason — never a second hardcoded path.
   */
  codexBinary?: () => Promise<string | undefined>
  /** Injected for tests; defaults to a real codex.exe spawn. */
  runCodexQueue?: CodexQueueRunner
  /**
   * Ends a process and everything below it — Kick's terminal tier (#329).
   *
   * The same per-OS port a launched session's exit uses (#217), injected the way
   * `focus` and `clipboard` are so a test never spawns a real taskkill; absent,
   * this composes the Windows one itself.
   */
  processEnd?: ProcessEndPort
  /**
   * Reads a pid's real creation time — the re-verification before the kill
   * (#231). The same port the Claude provider's pid-reuse guard uses, composed
   * once in platformAdapters; absent, this composes the Windows one itself.
   */
  processProbe?: ProcessProbePort
  /** Injected for tests; defaults to Date.now. Only ever reads durations. */
  now?: () => number
  /**
   * Waits `ms` and resolves — the delay between grace-window polls of a
   * cleanly-asked session (#358). Injected the way `now` is so a unit test drives
   * the poll to completion instantly instead of waiting out the real window;
   * defaults to a real `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>
}

function runPowerShellCommand(command: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: CONSOLE_COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error) // spawn failure, not a non-zero exit
          return
        }
        resolve({ stdout, exitCode: error === null ? 0 : (error.code as number) })
      }
    )
  })
}

export class WindowsTextDelivery implements TextDeliveryPort {
  /** user32 SendKeys can type into any foreground console on Windows. */
  readonly supportsConsoleInput = true

  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly relayModel: string
  private readonly relayTimeoutMs: number
  private readonly focus: (pid: number) => Promise<FocusOutcome>
  private readonly clipboard: ClipboardPort
  private readonly runPowerShell: ShellRunner
  private readonly runRelay: RelayRunner
  private readonly codexBinary: () => Promise<string | undefined>
  private readonly runCodexQueue: CodexQueueRunner
  private readonly processEnd: ProcessEndPort
  private readonly processProbe: ProcessProbePort
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** Null when the transport was replaced outright and there is nothing to keep alive. */
  private readonly consoleWorker: ConsoleWorker | null

  constructor(options: WindowsTextDeliveryOptions) {
    this.home = options.home ?? homedir()
    this.env = options.env ?? process.env
    this.relayModel = options.relayModel
    this.relayTimeoutMs = options.relayTimeoutMs
    this.focus = options.focus ?? focusSessionConsole
    this.clipboard = options.clipboard ?? createInMemoryClipboard()
    this.runRelay = options.runRelay ?? runRelayProcess
    this.codexBinary = options.codexBinary ?? (async () => undefined)
    this.runCodexQueue = options.runCodexQueue ?? runCodexQueueProcess
    // Pinned to 'win32' rather than asked of the machine: this class IS the
    // Windows port, and reading process.platform here would be a fourth call
    // site for an answer the composition already made (see platform-ports).
    this.processEnd = options.processEnd ?? createProcessEnd({ platform: 'win32' })
    this.processProbe = options.processProbe ?? createProcessProbe({ platform: 'win32' })
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

    // An injected runner with no worker spawn is a test replacing the whole
    // transport; anything else keeps one shell alive and falls back to a
    // per-action spawn only when that shell cannot be started (issue #21).
    const perActionRun = options.runPowerShell ?? runPowerShellCommand
    if (options.runPowerShell !== undefined && options.spawnConsoleWorker === undefined) {
      this.consoleWorker = null
      this.runPowerShell = options.runPowerShell
    } else {
      this.consoleWorker = createConsoleWorker({
        spawn: options.spawnConsoleWorker,
        commandTimeoutMs: CONSOLE_COMMAND_TIMEOUT_MS
      })
      this.runPowerShell = createResilientShellRunner(this.consoleWorker, perActionRun)
    }
  }

  /** Ends the long-lived console shell; safe on a port that never started one. */
  dispose(): void {
    this.consoleWorker?.dispose()
  }

  /**
   * Keystrokes land in whatever window holds the foreground, so the focus step
   * is a precondition, not an optimization: if the terminal will not come
   * forward, nothing is typed at all rather than typed into the wrong window.
   *
   * A window that DID come forward is not the end of that precondition (#329):
   * it also has to be one this session is alone on, or the keystroke goes to
   * whichever tab of a shared terminal is active. Both refusals type nothing.
   */
  async sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    try {
      const focus = await timer.measure('focus', () => this.focus(request.pid))
      if (!focus.focused) {
        return {
          delivered: false,
          error: 'The agent terminal could not be brought to the foreground.',
          stages: timer.timings()
        }
      }
      if (focus.reach === 'terminal-host') return sharedWindowRefusal(timer.timings())
      const result = await timer.measure('spawn', () =>
        this.runPowerShell(buildSendKeysCommand(request.text, request.pressEnter))
      )
      if (result.exitCode !== 0) {
        return {
          delivered: false,
          error: 'The keystrokes could not be sent to the terminal.',
          stages: timer.timings()
        }
      }
      return { delivered: true, stages: timer.timings() }
    } catch {
      return {
        delivered: false,
        error: 'The agent terminal could not be reached.',
        stages: timer.timings()
      }
    }
  }

  /**
   * Deliver a MESSAGE by PASTING it, not typing it (#319): put the text on the
   * clipboard, bring the window forward, press Ctrl+V (and Enter unless
   * `pressEnter` is false), then restore the clipboard. A 441-char message that
   * took ~16 s to type lands at once, and the window in which a mid-typing focus
   * change could steal the rest of it nearly disappears.
   *
   * The console-paste tier is the PRIMARY channel again for a named observed
   * session, the relay its fallback — the reverse of #315 — because pasting
   * lands the message as the person's own prompt rather than as another
   * session's, and does it in under a second. `sendToConsole` above still types,
   * for the one caller that still needs a measured single keystroke (#203).
   */
  async pasteToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    // Save/restore race (#319): anything that sets the clipboard between the
    // read here and the restore in `finally` loses its value to the restore.
    // The window is one focus plus one keystroke command, and not restoring at
    // all would be worse — the person's clipboard would silently become their
    // last sent message — so the race is accepted and stated rather than closed.
    //
    // Awaited because the installed Electron clipboard is promise-based; a sync
    // in-memory fake awaits to itself.
    const previousClipboard = await this.clipboard.read()
    await this.clipboard.write(request.text)
    try {
      const focus = await timer.measure('focus', () => this.focus(request.pid))
      if (!focus.focused) {
        // The focus precondition it always was: nothing is pasted into a window
        // that would not come forward. Nothing was handed over, so this is the
        // one send failure that licenses the relay behind it — `neverStarted`
        // says so, the mirror of a relay that never started falling back to the
        // console (#308). The clipboard the finally restores was only ever this
        // method's own write, never a paste into the session.
        return {
          delivered: false,
          error: 'The agent terminal could not be brought to the foreground.',
          neverStarted: true,
          stages: timer.timings()
        }
      }
      // The same statement about the same thing (#329): a window came forward
      // and it is a terminal HOST, so the message would be pasted into whichever
      // of its tabs is active — Enter included. `neverStarted` for the reason
      // above, and the relay is then the honest channel: a message labelled as
      // another session beats a message typed into one.
      if (focus.reach === 'terminal-host') return sharedWindowRefusal(timer.timings())
      const result = await timer.measure('spawn', () =>
        this.runPowerShell(buildPasteCommand(request.pressEnter))
      )
      if (result.exitCode !== 0) {
        // NOT neverStarted: Ctrl+V may already have pasted before the command
        // reported a non-zero exit, so the runtime must not relay the same text
        // behind it — the mirror of a relay that ran and then failed.
        return {
          delivered: false,
          error: 'The paste keystroke could not be sent to the terminal.',
          stages: timer.timings()
        }
      }
      return { delivered: true, stages: timer.timings() }
    } catch {
      // Also not neverStarted, and for the same reason: a throw can land after
      // the paste. The finally still restores the clipboard.
      return {
        delivered: false,
        error: 'The agent terminal could not be reached.',
        stages: timer.timings()
      }
    } finally {
      await this.clipboard.write(previousClipboard)
    }
  }

  async relayToClaudeSession(request: RelayTextRequest): Promise<TextDeliveryOutcome> {
    return deliverViaRelay({
      sessionName: request.sessionName,
      text: request.text,
      home: this.home,
      env: this.env,
      platform: 'win32',
      model: this.relayModel,
      timeoutMs: this.relayTimeoutMs,
      run: this.runRelay
    })
  }

  /**
   * The Codex queue tier — the one channel a Codex session has ever had (#97),
   * and the one proven on this platform. No PowerShell, no window, no pid: it
   * spawns the detected codex binary with the thread UUID and the message as
   * argv, so the payload is never text a shell re-parses.
   */
  async queueToCodexThread(request: CodexQueueRequest): Promise<TextDeliveryOutcome> {
    return deliverViaCodexQueue({
      threadId: request.threadId,
      text: request.text,
      binaryPath: await this.codexBinary(),
      run: this.runCodexQueue
    })
  }

  /**
   * A bare ESC into the console at `pid`: bring it forward, same as
   * sendToConsole, then synthesize the one keystroke the Claude Code TUI
   * interrupts a turn on instead of typing anything.
   *
   * Kick's terminal path until #329, and no longer — a kick ends the session's
   * process now, which needs no window and cannot miss. What still presses Esc
   * through here is the permission DENY of #203, a keystroke aimed at the dialog
   * that terminal is drawing; the shared-window refusal below is what stops it
   * cancelling the turn of whichever tab happened to be active.
   */
  async sendInterrupt(request: InterruptRequest): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    try {
      const focus = await timer.measure('focus', () => this.focus(request.pid))
      if (!focus.focused) {
        return {
          delivered: false,
          error: 'The agent terminal could not be brought to the foreground.',
          stages: timer.timings()
        }
      }
      if (focus.reach === 'terminal-host') return sharedWindowRefusal(timer.timings())
      const result = await timer.measure('spawn', () =>
        this.runPowerShell(buildSendInterruptCommand())
      )
      if (result.exitCode !== 0) {
        return {
          delivered: false,
          error: 'The interrupt keystroke could not be sent.',
          stages: timer.timings()
        }
      }
      return { delivered: true, stages: timer.timings() }
    } catch {
      return {
        delivered: false,
        error: 'The agent terminal could not be reached.',
        stages: timer.timings()
      }
    }
  }

  /**
   * Kick's terminal tier: ask the session to exit cleanly, then force it if it
   * will not (#358, over #329).
   *
   * #329 made this a pure tree kill — no window, no keystroke — because a pid
   * cannot be the wrong session the way a foreground window can. But `taskkill
   * /F` gives the Claude Code TUI no chance to run its exit path, so the DECSET
   * modes it turned on (mouse tracking above all) are never reset and the shell
   * that inherits the console prints an SGR mouse report on every pointer move
   * afterwards. So the kick now asks the CLI to exit the way its own /exit would
   * FIRST — Ctrl+C twice, which the maintainer measured the Claude TUI exits
   * cleanly on — and only force-kills if the process survives a bounded grace.
   *
   * The clean exit is attempted only where a keystroke is safe: the console must
   * come forward AND be one this session is alone on (#329's `terminal-host`
   * refusal stays — a key into a shared tab strip lands in the wrong session),
   * and the pid must re-verify against `expectedStartMs` before a key is sent
   * (#231's fail-closed guard, so a key never reaches a recycled pid). Anything
   * short of that skips the keystroke and falls straight through to the kill.
   *
   * The forced fallback is unchanged: re-probe the pid at the moment of the act,
   * `taskkill /T` only on agreement, and refuse on a mismatch or an unreadable
   * process list alike — see SESSION_NOT_VERIFIED for why this guard, alone in
   * this app, fails closed. The graceful attempt and the kill behind it are one
   * `spawn` stage, because they are the one act a person waits through.
   *
   * `delivered: true` is a fact this process observed — the TUI's own exit took,
   * or the platform reported the tree gone — never a message handed to somebody
   * who may act on it. Every other answer is a failure with a reason.
   */
  async endConsoleSession(request: EndSessionRequest): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    try {
      const outcome = await timer.measure('spawn', async () => {
        // The clean path: the terminal was handed back by the TUI's own exit, so
        // no force kill is reached at all (#358).
        if (await this.attemptGracefulExit(request)) return { delivered: true }
        return this.forceEndSession(request)
      })
      return { ...outcome, stages: timer.timings() }
    } catch {
      // A throwing probe is an unreadable process list by another name, and a
      // throwing kill did not kill: neither may report a session ended.
      return { delivered: false, error: SESSION_NOT_ENDED, stages: timer.timings() }
    }
  }

  /**
   * Ask the session's CLI to exit cleanly and wait a bounded grace for it to go
   * (#358). True means it is gone and the terminal was restored; false means
   * nothing was tried, or it did not go, and the forced kill behind this is what
   * ends it.
   *
   * Every reason to skip returns false rather than throwing, so a failed clean
   * exit is never anything but a fall-through to the guaranteed kill: a console
   * that will not come forward, a shared terminal window (#329), a pid that no
   * longer verifies (#231), a keystroke command that would not run, or a focus
   * that threw.
   */
  private async attemptGracefulExit(request: EndSessionRequest): Promise<boolean> {
    try {
      const focus = await this.focus(request.pid)
      // Only a console this session is provably alone on may receive a key; a
      // shared tab strip's active tab is unknowable from here (#329).
      if (!focus.focused || focus.reach === 'terminal-host') return false
      // Never a keystroke to a pid the OS may have recycled onto another
      // process — the same fail-closed guard the kill re-checks below (#231).
      const probedMs = await this.processProbe.processStartTimeMs(request.pid)
      if (probedMs === null || !sameProcessStart(probedMs, request.expectedStartMs)) return false
      const result = await this.runPowerShell(buildGracefulExitCommand())
      // The keystroke command failed to run, so the Ctrl+C never landed; there
      // is nothing to wait for, and the forced kill takes over.
      if (result.exitCode !== 0) return false
      return this.pollForExit(request)
    } catch {
      return false
    }
  }

  /**
   * Poll the pid until the cleanly-asked session is gone or the grace window
   * runs out (#358). Gone is `processStartTimeMs` reporting null, or a start
   * time that no longer matches the one we verified — the pid we knew is no
   * longer that process, so this session exited.
   *
   * Note the deliberate asymmetry with the keystroke guard above: null there is
   * "cannot verify, do not type" and null here is "gone", because after asking a
   * verified pid to exit, a pid that stops answering has done what we asked.
   */
  private async pollForExit(request: EndSessionRequest): Promise<boolean> {
    for (let attempt = 0; attempt < GRACEFUL_EXIT_POLL_COUNT; attempt++) {
      await this.sleep(GRACEFUL_EXIT_POLL_INTERVAL_MS)
      const probedMs = await this.processProbe.processStartTimeMs(request.pid)
      if (probedMs === null || !sameProcessStart(probedMs, request.expectedStartMs)) return true
    }
    return false
  }

  /**
   * The forced kill, unchanged from #329/#231: re-probe the pid at the moment of
   * the act, `taskkill /T` only on agreement, and refuse on a mismatch or an
   * unreadable process list alike. This is the one guard in the app that fails
   * closed. A throwing probe or kill propagates to `endConsoleSession`'s catch,
   * which reports SESSION_NOT_ENDED rather than a session ended.
   */
  private async forceEndSession(request: EndSessionRequest): Promise<TextDeliveryOutcome> {
    const probedMs = await this.processProbe.processStartTimeMs(request.pid)
    if (probedMs === null || !sameProcessStart(probedMs, request.expectedStartMs)) {
      return { delivered: false, error: SESSION_NOT_VERIFIED }
    }
    const ended = await this.processEnd.endProcessTree(request.pid)
    return ended ? { delivered: true } : { delivered: false, error: SESSION_NOT_ENDED }
  }
}
