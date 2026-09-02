import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { focusPid, type ShellRunner } from '../platform/focus'
import type {
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
import { buildSendInterruptCommand, buildSendKeysCommand } from './sendKeys'
import { createStageTimer } from './timing'

export type { RelayInvocation, RelayResult, RelayRunner }

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
