import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { focusPid, type ShellRunner } from '../focus'
import type {
  ConsoleTextRequest,
  InterruptRequest,
  RelayTextRequest,
  TextDeliveryOutcome,
  TextDeliveryPort
} from './port'
import {
  deliverViaRelay,
  runRelayProcess,
  type RelayInvocation,
  type RelayResult,
  type RelayRunner
} from './relayRunner'
import { buildSendInterruptCommand, buildSendKeysCommand } from './sendKeys'

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
  /** Injected for tests; defaults to a real powershell.exe run. */
  runPowerShell?: ShellRunner
  /** Injected for tests; defaults to a real claude.exe spawn. */
  runRelay?: RelayRunner
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

  constructor(options: WindowsTextDeliveryOptions) {
    this.home = options.home ?? homedir()
    this.env = options.env ?? process.env
    this.relayModel = options.relayModel
    this.relayTimeoutMs = options.relayTimeoutMs
    this.focus = options.focus ?? focusPid
    this.runPowerShell = options.runPowerShell ?? runPowerShellCommand
    this.runRelay = options.runRelay ?? runRelayProcess
  }

  /**
   * Keystrokes land in whatever window holds the foreground, so the focus step
   * is a precondition, not an optimization: if the terminal will not come
   * forward, nothing is typed at all rather than typed into the wrong window.
   */
  async sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    try {
      if (!(await this.focus(request.pid))) {
        return {
          delivered: false,
          error: 'The agent terminal could not be brought to the foreground.'
        }
      }
      const result = await this.runPowerShell(
        buildSendKeysCommand(request.text, request.pressEnter)
      )
      if (result.exitCode !== 0) {
        return { delivered: false, error: 'The keystrokes could not be sent to the terminal.' }
      }
      return { delivered: true }
    } catch {
      return { delivered: false, error: 'The agent terminal could not be reached.' }
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
   * Kick's terminal path: bring the console forward, same as sendToConsole,
   * then synthesize a bare ESC — the keystroke the Claude Code TUI interrupts
   * a turn on — instead of typing anything.
   */
  async sendInterrupt(request: InterruptRequest): Promise<TextDeliveryOutcome> {
    try {
      if (!(await this.focus(request.pid))) {
        return {
          delivered: false,
          error: 'The agent terminal could not be brought to the foreground.'
        }
      }
      const result = await this.runPowerShell(buildSendInterruptCommand())
      if (result.exitCode !== 0) {
        return { delivered: false, error: 'The interrupt keystroke could not be sent.' }
      }
      return { delivered: true }
    } catch {
      return { delivered: false, error: 'The agent terminal could not be reached.' }
    }
  }
}
