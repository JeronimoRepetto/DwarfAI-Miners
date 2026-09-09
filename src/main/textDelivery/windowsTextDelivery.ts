import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { focusPid, type ShellRunner } from '../platform/focus'
import type {
  ClipboardPort,
  CodexQueueRequest,
  ConsoleTextRequest,
  InterruptRequest,
  RelayTextRequest,
  TextDeliveryOutcome,
  TextDeliveryPort
} from './port'
import { deliverViaCodexQueue, runCodexQueueProcess, type CodexQueueRunner } from './codexQueue'
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
import { buildPasteCommand, buildSendInterruptCommand, buildSendKeysCommand } from './sendKeys'
import { createStageTimer } from './timing'

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

export interface WindowsTextDeliveryOptions {
  /** Cheap model the one-shot relay turn runs on. */
  relayModel: string
  /** How long the relay may run before its verdict is "timed out". */
  relayTimeoutMs: number
  home?: string
  /** Environment the relay child inherits; defaults to this process's. */
  env?: NodeJS.ProcessEnv
  /** Injected for tests; defaults to the real window-focus path. */
  focus?: (pid: number) => Promise<boolean>
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
  /** Injected for tests; defaults to Date.now. Only ever reads durations. */
  now?: () => number
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
  private readonly focus: (pid: number) => Promise<boolean>
  private readonly clipboard: ClipboardPort
  private readonly runPowerShell: ShellRunner
  private readonly runRelay: RelayRunner
  private readonly codexBinary: () => Promise<string | undefined>
  private readonly runCodexQueue: CodexQueueRunner
  private readonly now: () => number
  /** Null when the transport was replaced outright and there is nothing to keep alive. */
  private readonly consoleWorker: ConsoleWorker | null

  constructor(options: WindowsTextDeliveryOptions) {
    this.home = options.home ?? homedir()
    this.env = options.env ?? process.env
    this.relayModel = options.relayModel
    this.relayTimeoutMs = options.relayTimeoutMs
    this.focus = options.focus ?? focusPid
    this.clipboard = options.clipboard ?? createInMemoryClipboard()
    this.runRelay = options.runRelay ?? runRelayProcess
    this.codexBinary = options.codexBinary ?? (async () => undefined)
    this.runCodexQueue = options.runCodexQueue ?? runCodexQueueProcess
    this.now = options.now ?? Date.now

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
   */
  async sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    try {
      if (!(await timer.measure('focus', () => this.focus(request.pid)))) {
        return {
          delivered: false,
          error: 'The agent terminal could not be brought to the foreground.',
          stages: timer.timings()
        }
      }
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
      if (!(await timer.measure('focus', () => this.focus(request.pid)))) {
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
   * Kick's terminal path: bring the console forward, same as sendToConsole,
   * then synthesize a bare ESC — the keystroke the Claude Code TUI interrupts
   * a turn on — instead of typing anything.
   */
  async sendInterrupt(request: InterruptRequest): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    try {
      if (!(await timer.measure('focus', () => this.focus(request.pid)))) {
        return {
          delivered: false,
          error: 'The agent terminal could not be brought to the foreground.',
          stages: timer.timings()
        }
      }
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
}
