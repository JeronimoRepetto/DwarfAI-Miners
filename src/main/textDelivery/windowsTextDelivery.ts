import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { focusPid, type ShellRunner } from '../focus'
import type {
  ConsoleTextRequest,
  RelayTextRequest,
  TextDeliveryOutcome,
  TextDeliveryPort
} from './port'
import {
  buildRelayArgs,
  buildRelayEnv,
  buildRelayInstruction,
  resolveClaudeBinaryPath
} from './relay'
import { buildSendKeysCommand } from './sendKeys'

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

export interface RelayInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
}

export interface RelayResult {
  exitCode: number
  timedOut: boolean
}

export type RelayRunner = (invocation: RelayInvocation) => Promise<RelayResult>

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

function runRelayProcess(invocation: RelayInvocation): Promise<RelayResult> {
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error) => {
        if (error === null) {
          resolve({ exitCode: 0, timedOut: false })
          return
        }
        // execFile reports a timeout kill through `killed`, with no exit code.
        if (error.killed === true) {
          resolve({ exitCode: 1, timedOut: true })
          return
        }
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, timedOut: false })
          return
        }
        reject(error) // the binary could not be started at all
      }
    )
  })
}

export class WindowsTextDelivery implements TextDeliveryPort {
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
    const command = resolveClaudeBinaryPath(this.home)
    try {
      const result = await this.runRelay({
        command,
        args: buildRelayArgs({
          model: this.relayModel,
          instruction: buildRelayInstruction(request.sessionName, request.text)
        }),
        env: buildRelayEnv(this.env, command),
        cwd: this.home,
        timeoutMs: this.relayTimeoutMs
      })
      if (result.timedOut) {
        return {
          delivered: false,
          error: `The relay timed out after ${Math.round(this.relayTimeoutMs / 1_000)}s.`
        }
      }
      if (result.exitCode !== 0) {
        return {
          delivered: false,
          error: `The relay could not deliver the message (exit ${result.exitCode}).`
        }
      }
      return { delivered: true }
    } catch {
      return { delivered: false, error: 'The relay could not be started.' }
    }
  }
}
