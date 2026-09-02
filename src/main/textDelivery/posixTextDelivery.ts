import { homedir } from 'node:os'
import type { Platform } from '../platform/platform'
import type { ConsoleInputAdapter } from './osascriptInput'
import type {
  CodexQueueRequest,
  ConsoleTextRequest,
  InterruptRequest,
  RelayTextRequest,
  TextDeliveryOutcome,
  TextDeliveryPort
} from './port'
import { deliverViaCodexQueue, runCodexQueueProcess, type CodexQueueRunner } from './codexQueue'
import { deliverViaRelay, runRelayProcess, type RelayRunner } from './relayRunner'

/**
 * macOS/Linux implementation of TextDeliveryPort.
 *
 * Two tiers, and only one of them is portable:
 *
 * - The relay (`claude -p` handing the text to a named session) spawns a CLI,
 *   so it works identically on every platform and is the tier a headless
 *   session uses anywhere.
 * - Console input needs the window server. macOS can do it through System
 *   Events (osascript), Linux has no portable way at all, and even the macOS
 *   path needs Accessibility permission the app cannot check for. So the
 *   adapter is passed in: `null` means this platform cannot type into a
 *   console, and the port says so up front through `supportsConsoleInput`
 *   instead of failing after the user has typed a message.
 *
 * Like the Windows port, nothing here logs the message: only channels and
 * verdicts, never the text.
 */

const NO_CONSOLE_INPUT = 'Typing into a terminal is not supported on this operating system yet.'
const NOT_FOREGROUNDED = 'The agent terminal could not be brought to the foreground.'
const KEYSTROKES_FAILED = 'The keystrokes could not be sent to the terminal.'
const INTERRUPT_FAILED = 'The interrupt keystroke could not be sent.'
const UNREACHABLE = 'The agent terminal could not be reached.'

export interface PosixTextDeliveryOptions {
  platform: Platform
  /** Cheap model the one-shot relay turn runs on. */
  relayModel: string
  /** How long the relay may run before its verdict is "timed out". */
  relayTimeoutMs: number
  home?: string
  /** Environment the relay child inherits; defaults to this process's. */
  env?: NodeJS.ProcessEnv
  /** Brings the hosting terminal forward; null-safe, defaults to never succeeding. */
  focus?: (pid: number) => Promise<boolean>
  /** null when this platform cannot synthesize keystrokes into a console. */
  consoleInput?: ConsoleInputAdapter | null
  /** Injected for tests; defaults to a real claude spawn. */
  runRelay?: RelayRunner
  /**
   * Resolves the codex binary through the CLI detection port (#91), or
   * undefined when it is not installed. Omitted, the queue tier has no binary
   * to address and refuses with a reason — never a second hardcoded path.
   */
  codexBinary?: () => Promise<string | undefined>
  /** Injected for tests; defaults to a real codex spawn. */
  runCodexQueue?: CodexQueueRunner
}

export class PosixTextDelivery implements TextDeliveryPort {
  readonly supportsConsoleInput: boolean

  private readonly platform: Platform
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly relayModel: string
  private readonly relayTimeoutMs: number
  private readonly focus: (pid: number) => Promise<boolean>
  private readonly consoleInput: ConsoleInputAdapter | null
  private readonly runRelay: RelayRunner
  private readonly codexBinary: () => Promise<string | undefined>
  private readonly runCodexQueue: CodexQueueRunner

  constructor(options: PosixTextDeliveryOptions) {
    this.platform = options.platform
    this.home = options.home ?? homedir()
    this.env = options.env ?? process.env
    this.relayModel = options.relayModel
    this.relayTimeoutMs = options.relayTimeoutMs
    this.focus = options.focus ?? (async () => false)
    this.consoleInput = options.consoleInput ?? null
    this.runRelay = options.runRelay ?? runRelayProcess
    this.codexBinary = options.codexBinary ?? (async () => undefined)
    this.runCodexQueue = options.runCodexQueue ?? runCodexQueueProcess
    this.supportsConsoleInput = this.consoleInput !== null
  }

  /**
   * Same precondition as the Windows path: keystrokes land in whatever window
   * holds the foreground, so focusing is a requirement, not an optimization.
   * On a platform with no console input at all the refusal comes first — a
   * click should not steal the foreground for a delivery that cannot land.
   */
  async sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    const input = this.consoleInput
    if (input === null) return { delivered: false, error: NO_CONSOLE_INPUT }
    try {
      if (!(await this.focus(request.pid))) {
        return { delivered: false, error: NOT_FOREGROUNDED }
      }
      return (await input.sendText(request.text, request.pressEnter))
        ? { delivered: true }
        : { delivered: false, error: KEYSTROKES_FAILED }
    } catch {
      return { delivered: false, error: UNREACHABLE }
    }
  }

  async relayToClaudeSession(request: RelayTextRequest): Promise<TextDeliveryOutcome> {
    return deliverViaRelay({
      sessionName: request.sessionName,
      text: request.text,
      home: this.home,
      env: this.env,
      platform: this.platform,
      model: this.relayModel,
      timeoutMs: this.relayTimeoutMs,
      run: this.runRelay
    })
  }

  /**
   * The Codex queue tier: platform-neutral like the relay, because it spawns a
   * CLI rather than touching a window server. macOS and Linux get it on the
   * same terms Windows does; only the detected binary path differs.
   */
  async queueToCodexThread(request: CodexQueueRequest): Promise<TextDeliveryOutcome> {
    return deliverViaCodexQueue({
      threadId: request.threadId,
      text: request.text,
      binaryPath: await this.codexBinary(),
      run: this.runCodexQueue
    })
  }

  /** Kick's terminal path: focus, then a bare Escape instead of any text. */
  async sendInterrupt(request: InterruptRequest): Promise<TextDeliveryOutcome> {
    const input = this.consoleInput
    if (input === null) return { delivered: false, error: NO_CONSOLE_INPUT }
    try {
      if (!(await this.focus(request.pid))) {
        return { delivered: false, error: NOT_FOREGROUNDED }
      }
      return (await input.sendInterrupt())
        ? { delivered: true }
        : { delivered: false, error: INTERRUPT_FAILED }
    } catch {
      return { delivered: false, error: UNREACHABLE }
    }
  }
}
