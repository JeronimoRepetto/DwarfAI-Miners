import { homedir } from 'node:os'
import type { Platform } from '../platform/platform'
import { createProcessEnd, type ProcessEndPort } from '../platform/processEnd'
import {
  createProcessProbe,
  sameProcessStart,
  type ProcessProbePort
} from '../platform/processProbe'
import type { ConsoleInputAdapter } from './osascriptInput'
import type {
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
import { deliverViaRelay, runRelayProcess, type RelayRunner } from './relayRunner'
import { createStageTimer } from './timing'

/**
 * macOS/Linux implementation of TextDeliveryPort.
 *
 * Three tiers, and the one that needs a window server is still the odd one out:
 *
 * - The relay (`claude -p` handing the text to a named session) spawns a CLI,
 *   so it works identically on every platform and is the tier a headless
 *   session uses anywhere.
 * - Ending a session needs no window either (#366): a signal is addressed to a
 *   pid, and SIGTERM is catchable, so the CLI runs its own exit path and hands
 *   the terminal back restored. That is why this tier exists here while console
 *   input does not — the two were conflated as one "can this platform reach a
 *   console" question until #366, and they are not the same question.
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
  /**
   * Signals one process — Kick's terminal tier (#366).
   *
   * The same per-OS port a launched session's exit uses (#217), injected the way
   * `focus` and `consoleInput` are so a test never signals a real process;
   * absent, this composes the one for its own platform. The tier uses the
   * DIRECT-pid signals on it and never `endProcessTree`, whose negative pid
   * addresses a process group only a launched session leads.
   */
  processEnd?: ProcessEndPort
  /**
   * Reads a pid's real creation time — the verification before the signal
   * (#231). The same port the Claude provider's pid-reuse guard uses, composed
   * once in platformAdapters; absent, this composes its platform's own.
   */
  processProbe?: ProcessProbePort
  /** Injected for tests; defaults to Date.now. Only ever reads durations. */
  now?: () => number
  /**
   * Waits `ms` and resolves — the delay between grace-window polls of a session
   * that was asked to exit (#366). Injected the way `now` is so a unit test
   * drives the poll to completion instantly instead of waiting out the real
   * window; defaults to a real `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>
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
  private readonly processEnd: ProcessEndPort
  private readonly processProbe: ProcessProbePort
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

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
    // The platform this port was CONSTRUCTED for, never asked of the machine:
    // this class is the POSIX port for whichever POSIX platform composed it, and
    // reading process.platform here would be a fourth call site for an answer
    // the composition already made (see platform-ports).
    this.processEnd = options.processEnd ?? createProcessEnd({ platform: options.platform })
    this.processProbe = options.processProbe ?? createProcessProbe({ platform: options.platform })
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
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

  /** The permission DENY of #203: focus, then a bare Escape instead of any text. */
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

  /*
   * No `answerQuestionAtConsole` here, and the absence is a per-OS answer
   * rather than a gap (#362).
   *
   * `ConsoleInputAdapter` can type text and press Escape, and that is all it
   * can press. A single-select answer is one digit and would fit — but a
   * multi-select needs the RIGHT arrow that shows its summary before the Enter
   * that accepts it, and there is no arrow key behind this adapter. Adding half
   * the tier would put two acts behind one label, exactly the conflation #366
   * had to undo for the kick: the panel's Answer control would answer a
   * multi-select on Windows and refuse it here, with nothing on the card able
   * to say which. The arrow key belongs to #367, and until it exists the
   * runtime states the whole tier as absent (NO_ANSWER_KEYSTROKE_TIER).
   */

  /**
   * Kick's terminal tier on macOS and Linux (#366): ask the session's own
   * process to exit, and force it if it will not.
   *
   * The same contract the Windows tier holds — verify the pid, ask, poll,
   * escalate, report only what was observed — reached by a strictly simpler
   * act, because SIGTERM is CATCHABLE. The signal itself is the clean ask: the
   * CLI runs its own exit path and resets the terminal modes it turned on, so
   * none of #358's Windows machinery is needed here. No window is focused, no
   * keystroke is synthesized, and #329's shared-tab ambiguity — the reason the
   * Windows clean exit may only type into a console this session is alone on —
   * cannot arise, because a signal is addressed to a pid rather than to whatever
   * holds the foreground.
   *
   * The pid is signalled DIRECTLY. `endProcessTree`'s negative pid is a process
   * GROUP, which is right for a session this panel launched as a group leader
   * (#217) and wrong for one somebody else started in their own terminal, whose
   * pid leads no group of ours — see processEnd.ts. The tree above such a pid is
   * the shell and every other tab in that window, and the terminal tab stays
   * open at its shell prompt either way.
   *
   * The verification before the signal is #231's, fail-closed: a mismatch and an
   * unreadable process list are the same refusal, and nothing is signalled on
   * either. Note the deliberate asymmetry with the poll below — before the
   * signal a null probe is "cannot verify, do not act", and after it a null probe
   * is "gone" — stated at both sites because it is the same reading with
   * opposite consequences.
   *
   * `delivered: true` is a fact this process observed: the pid stopped being
   * this session, or the platform reported an uncatchable signal delivered to a
   * pid verified a moment earlier. Every other answer is a failure with a
   * reason, and the whole act is one `spawn` stage because it is the one act a
   * person waits through.
   */
  async endConsoleSession(request: EndSessionRequest): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    try {
      const outcome = await timer.measure('spawn', async () => {
        // Fail closed: nothing is signalled at a pid nothing can vouch for.
        if (!(await this.stillThisProcess(request))) {
          return { delivered: false, error: SESSION_NOT_VERIFIED }
        }
        // A signal the platform would not deliver is not an ended session, and
        // it is not escalated either: both signals travel the same `kill`, so a
        // TERM that never arrived says the escalation would not arrive too. The
        // escalation is for a process that DECLINED the signal.
        if (!(await this.processEnd.terminateProcess(request.pid))) {
          return { delivered: false, error: SESSION_NOT_ENDED }
        }
        if (await this.pollForExit(request)) return { delivered: true }
        return this.forceEndSession(request)
      })
      return { ...outcome, stages: timer.timings() }
    } catch {
      // A throwing probe is an unreadable process list by another name, and a
      // throwing signal did not signal: neither may report a session ended.
      return { delivered: false, error: SESSION_NOT_ENDED, stages: timer.timings() }
    }
  }

  /**
   * Whether the process at `pid` is still the one the provider verified — the
   * one reading both halves of this tier take, in opposite directions.
   *
   * False bundles "the pid is another process now" with "the process list could
   * not be read", and that is the point: neither is evidence, and what a caller
   * does with the absence of evidence depends entirely on whether it has already
   * asked this session to exit. Before the signal, false must refuse; after it,
   * false means the session went.
   */
  private async stillThisProcess(request: EndSessionRequest): Promise<boolean> {
    const probedMs = await this.processProbe.processStartTimeMs(request.pid)
    return probedMs !== null && sameProcessStart(probedMs, request.expectedStartMs)
  }

  /**
   * Poll the pid until the session that was asked to exit is gone or the grace
   * window runs out. True means gone: after asking a VERIFIED pid to exit, a pid
   * that stops answering — or that answers as a different process — has done
   * what we asked.
   */
  private async pollForExit(request: EndSessionRequest): Promise<boolean> {
    for (let attempt = 0; attempt < GRACEFUL_EXIT_POLL_COUNT; attempt++) {
      await this.sleep(GRACEFUL_EXIT_POLL_INTERVAL_MS)
      if (!(await this.stillThisProcess(request))) return true
    }
    return false
  }

  /**
   * The escalation for a session that outlasted its grace window: SIGKILL,
   * which it cannot catch.
   *
   * The pid is re-probed immediately before it, the way the Windows kill is
   * (#231) — the last look of the poll can be a whole interval old, and this is
   * the irreversible act. A pid that stopped matching in that interval went of
   * its own accord, late but gone, so it is reported as ended rather than
   * refused: the exit we asked for took. Nothing uncatchable is sent to a pid
   * nothing can vouch for any more.
   *
   * A delivered SIGKILL is an ended process — the kernel does not consult the
   * program — so the verdict is the platform's own answer about the signal, not
   * a second probe racing the reaping of the process it just destroyed.
   */
  private async forceEndSession(request: EndSessionRequest): Promise<TextDeliveryOutcome> {
    if (!(await this.stillThisProcess(request))) return { delivered: true }
    return (await this.processEnd.killProcess(request.pid))
      ? { delivered: true }
      : { delivered: false, error: SESSION_NOT_ENDED }
  }
}
