import { homedir } from 'node:os'
import { NodeFs, type FsLike } from '../adapters/fsLike'
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
  CodexResumeRequest,
  ConsoleAnswerRequest,
  ConsoleTextRequest,
  EndSessionRequest,
  InterruptRequest,
  OpenCodeContinueRequest,
  RelayTextRequest,
  TextDeliveryOutcome,
  TextDeliveryPort
} from './port'
import { deliverViaCodexQueue, runCodexQueueProcess, type CodexQueueRunner } from './codexQueue'
import { deliverViaCodexResume, runCodexResumeProcess, type CodexResumeRunner } from './codexResume'
import {
  deliverViaOpenCodeContinue,
  runOpenCodeContinueProcess,
  type OpenCodeContinueRunner
} from './opencodeContinue'
import {
  GRACEFUL_EXIT_POLL_COUNT,
  GRACEFUL_EXIT_POLL_INTERVAL_MS,
  SESSION_NOT_ENDED,
  SESSION_NOT_VERIFIED
} from './endSession'
import { answerChunksPressable, questionAnswerChunks } from './questionKeys'
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
 * - Console input is the one that still differs, and since #367/#471 it is two
 *   things rather than one. SYNTHESIZING a key needs the window server: macOS
 *   does it through System Events (osascript) with Accessibility permission the
 *   app cannot check for, and Linux has no portable way at all. ADDRESSING a
 *   console needs no window — macOS writes into the Terminal.app tab a session's
 *   tty names, which is what carries a message and a single-digit answer. So the
 *   adapter is passed in: `null` means this platform can do neither, and the
 *   port says so up front through `supportsConsoleInput` instead of failing
 *   after the user has typed a message.
 *
 * Like the Windows port, nothing here logs the message: only channels and
 * verdicts, never the text.
 */

const NO_CONSOLE_INPUT = 'Typing into a terminal is not supported on this operating system yet.'
const NOT_FOREGROUNDED = 'The agent terminal could not be brought to the foreground.'
const KEYSTROKES_FAILED = 'The keystrokes could not be sent to the terminal.'
const INTERRUPT_FAILED = 'The interrupt keystroke could not be sent.'
const UNREACHABLE = 'The agent terminal could not be reached.'
/**
 * This platform's console input can synthesize keys but cannot ADDRESS a
 * console, so there is no message tier here (#367).
 *
 * Linux, and macOS with the keystroke adapter alone. A different fact about the
 * machine from NO_CONSOLE_INPUT above, and worth its own sentence: keys can be
 * pressed, and a message still cannot be delivered. Both carry `neverStarted`,
 * which is what sends the words down the relay rather than dropping them.
 */
const NO_CONSOLE_MESSAGE_TIER =
  'Writing a message into a terminal is not supported on this operating system yet.'
const MESSAGE_UNREACHABLE = 'The message could not be delivered to that terminal.'
/**
 * Digits nothing may press (#362) — no digits at all, more than the picker
 * numbers, or a "digit" that is not one.
 *
 * Reachable only through a caller that resolved them itself rather than through
 * `questionKeystrokesFor`, which refuses the same cases first. The Windows port
 * states its own guard the same way and for the same reason: swallowed, it
 * would report a picker answered that nobody touched. Nothing was focused and
 * nothing was pressed, which is what `neverStarted` says.
 */
const ANSWER_KEYS_UNBUILDABLE = 'That answer could not be turned into keystrokes.'

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
  /** Injected for tests; defaults to a real codex spawn (#450). */
  runCodexResume?: CodexResumeRunner
  /**
   * Resolves the opencode binary through the CLI detection port (#534), on
   * the same terms `codexBinary` is. Omitted, the continuation tier has no
   * binary to address and refuses with a reason.
   */
  opencodeBinary?: () => Promise<string | undefined>
  /** Injected for tests; defaults to a real opencode spawn (#534). */
  runOpenCodeContinue?: OpenCodeContinueRunner
  /**
   * Reads a `.cmd`/`.bat` shim for the program it names, the same way CLI
   * detection does (#413). Codex never ships a shim on POSIX, but the plumbing
   * is uniform across both ports rather than one of them alone knowing it can
   * skip it. Injected for tests; defaults to the real filesystem.
   */
  fs?: FsLike
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
  private readonly runCodexResume: CodexResumeRunner
  private readonly opencodeBinary: () => Promise<string | undefined>
  private readonly runOpenCodeContinue: OpenCodeContinueRunner
  private readonly fs: FsLike
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
    this.runCodexResume = options.runCodexResume ?? runCodexResumeProcess
    this.opencodeBinary = options.opencodeBinary ?? (async () => undefined)
    this.runOpenCodeContinue = options.runOpenCodeContinue ?? runOpenCodeContinueProcess
    this.fs = options.fs ?? new NodeFs()
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
   * #203's permission digit, and any other single key this port is asked for.
   *
   * TWO routes since #471, tried in this order, and the order is the whole of
   * the care here.
   *
   * The adapter is offered the key FIRST, before anything is focused. A key it
   * accepts is ADDRESSED — written into the console the pid names — so it needs
   * no foreground at all, and focusing first would steal it for an act that
   * never wanted it. That is the same mistake the `null` branch below already
   * refuses to make for a platform with no console input, one step further in.
   *
   * `null` from the adapter means "not my key", not "it failed", and only then
   * does the keystroke path run, unchanged: focus, then type, with keystrokes
   * landing in whatever window holds the foreground exactly as before. An
   * OUTCOME is an answer about the console and is carried through as it stands —
   * a key the adapter would write but could not must never be retried by typing
   * at the front window, which is #329's refusal arriving on this route.
   *
   * On a platform with no console input at all the refusal still comes first —
   * a click should not steal the foreground for a delivery that cannot land.
   */
  async sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    const input = this.consoleInput
    if (input === null) return { delivered: false, error: NO_CONSOLE_INPUT }
    try {
      const sendKey = input.sendKey
      if (sendKey !== undefined) {
        const addressed = await sendKey.call(input, {
          pid: request.pid,
          text: request.text,
          pressEnter: request.pressEnter
        })
        if (addressed !== null) return addressed
      }
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

  /**
   * The MESSAGE tier on macOS and Linux (#367), and the one place this port
   * raises no window at all.
   *
   * The precondition `sendToConsole` above carries — focus first, because
   * System Events types into the foreground — does not apply here, and that is
   * the whole point of the tier. A message is ADDRESSED: on macOS the adapter
   * writes it into the Terminal.app tab the session's tty names, so the tab
   * strip is never consulted and #329's shared-window ambiguity has nothing
   * left to be ambiguous about. That is the same thing the Windows write by pid
   * bought at #371, reached by a different mechanism.
   *
   * An absent `sendMessage` is a per-OS answer stated rather than a silent
   * no-op: this class always has the method (a class cannot conditionally have
   * one), so the refusal has to be a value, and it carries `neverStarted` so
   * the runtime's relay fallback carries the words. A throwing adapter does
   * NOT, on the cautious reading the Windows port takes — it may have written,
   * and nothing here can prove otherwise, so nothing licenses a second tier to
   * send the same words again.
   *
   * Like every other tier here, nothing logs the message: only the verdict.
   */
  async pasteToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    const input = this.consoleInput
    if (input === null) {
      return { delivered: false, error: NO_CONSOLE_INPUT, neverStarted: true }
    }
    const send = input.sendMessage
    if (send === undefined) {
      return { delivered: false, error: NO_CONSOLE_MESSAGE_TIER, neverStarted: true }
    }
    const timer = createStageTimer(this.now)
    try {
      const outcome = await timer.measure('spawn', () =>
        send.call(input, {
          pid: request.pid,
          text: request.text,
          pressEnter: request.pressEnter,
          ...(request.attachments === undefined ? {} : { attachments: request.attachments })
        })
      )
      return { ...outcome, stages: timer.timings() }
    } catch {
      return { delivered: false, error: MESSAGE_UNREACHABLE, stages: timer.timings() }
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
      run: this.runCodexQueue,
      fs: this.fs
    })
  }

  /**
   * The Codex resume tier (#450): platform-neutral for the reason the queue
   * beside it is, and reached through the same detected binary.
   */
  async resumeCodexThread(request: CodexResumeRequest): Promise<TextDeliveryOutcome> {
    return deliverViaCodexResume({
      threadId: request.threadId,
      cwd: request.cwd,
      text: request.text,
      binaryPath: await this.codexBinary(),
      run: this.runCodexResume,
      fs: this.fs,
      // Forwarded rather than defaulted (#462): an absent request.tuning must
      // reach codexTuningArgs as absent too, which is what keeps the argv
      // byte-identical to before this issue.
      ...(request.tuning === undefined ? {} : { tuning: request.tuning })
    })
  }

  /**
   * The OpenCode continuation tier (#534): platform-neutral for the reason
   * the queue and the resume beside it are, and reached through the same
   * detected binary.
   */
  async continueOpenCodeSession(request: OpenCodeContinueRequest): Promise<TextDeliveryOutcome> {
    return deliverViaOpenCodeContinue({
      sessionId: request.sessionId,
      cwd: request.cwd,
      text: request.text,
      binaryPath: await this.opencodeBinary(),
      run: this.runOpenCodeContinue,
      fs: this.fs
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

  /**
   * Answer the AskUserQuestion picker this console is drawing (#362, #471).
   *
   * **This tier used to be absent here, and the absence was true rather than a
   * gap.** `ConsoleInputAdapter` could type at the foreground and press Escape,
   * and that was all: a single-select answer is one digit and would have fit,
   * but a multi-select needs the confirmation behind its toggles, and offering
   * half a tier would have put two acts behind one label — the conflation #366
   * had to undo for the kick. So the runtime stated the whole tier as missing
   * (NO_ANSWER_KEYSTROKE_TIER) rather than answering one gesture and refusing
   * the other with nothing on the card able to say which.
   *
   * What changed is not that argument, it is one of its premises. The adapter
   * can ADDRESS a console now, so a single-select really is answerable — and
   * the split moved inside this method, where the two gestures can be told
   * apart, instead of standing between two platforms where they could not.
   *
   * ## The two routes, and why the line is where it is
   *
   * A **single-select** is one digit and no confirmation. Measured 2026-09-18,
   * it fires and confirms in ONE addressed `do script` call, so it takes the
   * key route: no window is raised and the tab strip is never consulted. That
   * matters more here than anywhere else on this port — a digit in the wrong
   * tab does not merely interrupt a stranger's turn, it CHOOSES an option in
   * it, which is the reason the Windows port moved this act off the foreground
   * at #402 and the reason a named refusal below must never fall through to
   * typing.
   *
   * A **multi-select** cannot: measured the same day, its digit toggled late
   * through the tab write and digit-plus-Return did not submit. It takes the
   * keystroke path, behind a focus, one `sendText` per key — each key its own
   * press, because a key arriving inside another's is read as pasted content
   * rather than as a keystroke (#404, #402).
   *
   * **The multi-select route is unverified on macOS**, and this is the one
   * claim here that rests on somebody else's platform. The chunks come from
   * `questionAnswerChunks`, whose confirmation is `ESC [ C` then a carriage
   * return — measured live on Windows at #402, and about what the PICKER reads
   * rather than about ConPTY, which is why it is the best available shape. But
   * 2026-09-18's own multi-select finding was that submitting through the tab
   * write needs a Tab and then a digit, a different gesture entirely, and
   * nobody has yet pressed either through System Events. A refusal from here is
   * therefore honest and a success is not yet proof.
   *
   * ## The typed answer cannot take the addressed route, and this is measured
   *
   * The "Other" answer of #481 is `[digit, words, Enter]`, and its first two
   * chunks MUST NOT submit: the digit lands on the Other row and opens its text
   * field, the words fill it, and only the Enter sends. `do script` appends a
   * Return to every call and has no form that appends none, so it cannot
   * express that sequence. Both candidate shapes were driven against a live
   * Claude Code 2.1.276 picker (three options, Other on row 4) on 2026-09-18,
   * and both were wrong — silently, which is the part that matters:
   *
   * - `do script "4"` alone moved the cursor to the Other row and its appended
   *   Return SUBMITTED the empty field. The transcript recorded
   *   `Which option do you pick? → __other__` with no words, and the agent
   *   answered that the free-text came back empty. An answer the person never
   *   gave, attributed to them.
   * - `do script "4in my words"` arrived as ONE read, so the picker took it as
   *   a paste rather than as a row key, and the trailing Return selected
   *   whatever row the cursor was on. The transcript recorded
   *   `Which option do you pick? → Alpha` — an option nobody chose. Worse than
   *   the first, because it looks like a real answer.
   *
   * So the typed form goes to the keystroke path, where System Events CAN press
   * a key without a Return, and it takes that path's preconditions with it: the
   * window in front, and Accessibility permission. It joins the multi-select
   * there rather than being refused as a special case, which is the whole shape
   * of this method — one rule for every answer the addressed tier cannot carry,
   * rather than a list of exceptions.
   *
   * The digits arrive already resolved to option positions (questionKeys.ts),
   * so nothing agent-authored reaches a command and there is nothing to escape.
   * Linux keeps its old answer through a different door: no console adapter, so
   * the refusal is a VALUE rather than this method's absence — the move
   * `pasteToConsole` already made, and for the same reason, a class cannot
   * conditionally have a method.
   */
  async answerQuestionAtConsole(request: ConsoleAnswerRequest): Promise<TextDeliveryOutcome> {
    const input = this.consoleInput
    if (input === null) {
      return { delivered: false, error: NO_CONSOLE_INPUT, neverStarted: true }
    }
    // The TYPED form (#481) is finished chunks from the caller, so it skips the
    // option builder entirely — and it skips the addressed route below with it,
    // for the measured reason in this method's header. `answerChunksPressable`
    // is #491's guard, restated here rather than trusted from the caller, on the
    // discipline every write into somebody else's console holds.
    const typed = request.chunks
    if (typed !== undefined) {
      if (!answerChunksPressable(typed)) {
        return { delivered: false, error: ANSWER_KEYS_UNBUILDABLE, neverStarted: true }
      }
      return this.pressAnswerChunks(input, request.pid, typed)
    }
    const chunks = questionAnswerChunks(request.digits, request.submit)
    if (chunks === null) {
      return { delivered: false, error: ANSWER_KEYS_UNBUILDABLE, neverStarted: true }
    }
    try {
      // One chunk is a single-select: the digit alone, with no confirmation
      // behind it. Offered to the adapter rather than shape-checked here — it
      // owns what it measured, and answers null for a key it cannot carry, so a
      // single TOGGLE awaiting confirmation never reaches it (that is two
      // chunks) and neither does anything that is not a row's digit.
      const sendKey = input.sendKey
      if (sendKey !== undefined && chunks.length === 1) {
        const addressed = await sendKey.call(input, {
          pid: request.pid,
          text: chunks[0] as string,
          pressEnter: false
        })
        if (addressed !== null) return addressed
      }
      return this.pressAnswerChunks(input, request.pid, chunks)
    } catch {
      return { delivered: false, error: UNREACHABLE }
    }
  }

  /**
   * Press a finished chunk list at the foreground, one `sendText` per chunk.
   *
   * The keystroke half of the answer tier, shared by the multi-select form and
   * the typed form because it is the same act: keys that must arrive one at a
   * time, none of them carrying a submit of its own. Each chunk goes with
   * `pressEnter` false without exception — a Return riding any chunk but the
   * last is what #404 is about, and on the typed form it is what would submit
   * an empty Other answer.
   */
  private async pressAnswerChunks(
    input: ConsoleInputAdapter,
    pid: number,
    chunks: readonly string[]
  ): Promise<TextDeliveryOutcome> {
    try {
      if (!(await this.focus(pid))) {
        return { delivered: false, error: NOT_FOREGROUNDED }
      }
      for (const chunk of chunks) {
        // Stop at the first key that will not go. Pressing the rest would leave
        // a picker half-toggled, which is a different answer from the one the
        // person gave rather than a partial version of it.
        if (!(await input.sendText(chunk, false))) {
          return { delivered: false, error: KEYSTROKES_FAILED }
        }
      }
      return { delivered: true }
    } catch {
      return { delivered: false, error: UNREACHABLE }
    }
  }

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
