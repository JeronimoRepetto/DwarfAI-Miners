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
  CodexQueueRequest,
  ConsoleAnswerRequest,
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
  buildConsoleInputSequenceCommand,
  buildConsoleInputWriteCommand,
  consoleWriteFailureFor
} from './consoleInputWrite'
import { consoleChunksFor } from './attachmentDelivery'
import { questionAnswerChunks } from './questionKeys'
import { buildGracefulExitCommand, buildSendInterruptCommand } from './sendKeys'
import { createStageTimer, type StageTimings } from './timing'

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

/**
 * Why a keystroke stops at a window the ancestor walk had to reach (#329).
 *
 * Windows Terminal and VS Code draw several sessions in tabs of ONE window and
 * expose no way to select a tab by pid, so foregrounding that window raises
 * whichever tab the person last used. A `true` from focus was read as "this
 * session's console is in front" and it is not: measured live, an Esc aimed at
 * one Claude foreman interrupted the other one, in the tab that happened to be
 * active. Nothing is sent, and `neverStarted` says nothing was.
 *
 * Since #371 this belongs to the tiers that still SYNTHESIZE A KEYSTROKE, and
 * #402 left two: the interrupt and the clean-exit Ctrl+C. Nothing else comes
 * here — a message, a permission digit and a question answer are written into
 * the console the pid names, which has no tab strip to be ambiguous about.
 */
const SHARED_TERMINAL_WINDOW =
  'This session shares its terminal window with other tabs, and the panel cannot tell ' +
  'which tab is its own.'

/** That refusal, identical for every keystroke this port can send (#329). */
function sharedWindowRefusal(stages: StageTimings): TextDeliveryOutcome {
  return { delivered: false, error: SHARED_TERMINAL_WINDOW, neverStarted: true, stages }
}

/**
 * An answer whose digits the builder would not accept (#362).
 *
 * Reachable only through a caller that resolved them itself rather than through
 * questionKeys, which refuses the same three cases first — so this is the
 * builder's guard stated rather than swallowed, not a sentence anybody is
 * expected to read. Nothing is focused and nothing is pressed, which is what
 * `neverStarted` says.
 */
const ANSWER_KEYS_UNBUILDABLE = 'That answer could not be turned into keystrokes.'

/**
 * A pid the console-write builder would not accept (#371).
 *
 * The same shape as the refusal above, and the same fail-closed reasoning as
 * the tier guard (#231): a write is addressed by process id and nothing else,
 * so a pid that cannot name a process must stop here rather than reach whatever
 * process happens to hold that number. Nothing ran, which is what
 * `neverStarted` says — the relay may still carry the message.
 */
const CONSOLE_WRITE_UNBUILDABLE = 'That console could not be addressed by process id.'

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
   * The SCOPED focus, not the boolean one click-to-focus reads (#329): a
   * keystroke may only follow a window this session is provably alone on. See
   * `FocusReach` in platform/focus.ts. Only the keystroke tiers read it since
   * #371 — text is written by pid and asks for no window.
   */
  focus?: (pid: number) => Promise<FocusOutcome>
  /**
   * Runs ONE pid write, as its own process (#371).
   *
   * Separate from `runPowerShell` because the two cannot share a shell:
   * `FreeConsole`/`AttachConsole` rebind the console of the process that CALLS
   * them, so the write must never run on the long-lived worker — see
   * `writeToConsoleByPid`. Injected for tests, and a test that replaced the
   * keystroke transport gets this replaced with it, because a unit test that
   * reached a real powershell.exe here would attach to whatever process holds
   * the pid it made up.
   */
  runConsoleWrite?: ShellRunner
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
   * `focus` and the two shell runners are so a test never spawns a real
   * taskkill; absent, this composes the Windows one itself.
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
  /**
   * Text reaches a console on Windows: by pid since #371, where it used to need
   * that console in the foreground.
   */
  readonly supportsConsoleInput = true

  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly relayModel: string
  private readonly relayTimeoutMs: number
  private readonly focus: (pid: number) => Promise<FocusOutcome>
  private readonly runPowerShell: ShellRunner
  private readonly runConsoleWrite: ShellRunner
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
    // A per-action child, never the worker below: the attach rebinds the
    // CALLER's console (see writeToConsoleByPid). An injected keystroke runner
    // stands in for it so no unit test can reach a real console.
    this.runConsoleWrite = options.runConsoleWrite ?? options.runPowerShell ?? runPowerShellCommand
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
   * Text into the console the session's own pid is attached to (#371, step 2).
   *
   * What this used to do — focus the window, then type into whatever held the
   * foreground — is the defect #371 reported: under the Windows 11
   * default-terminal handoff every session's console window is a phantom owned
   * by a Windows Terminal window, so raising it raises whichever TAB was last
   * used, and the keystrokes went there. #376 made that case refuse rather than
   * misdeliver, which left every multi-tab user's words travelling over the
   * relay, framed to the receiving agent as a peer's request (#378).
   *
   * `AttachConsole(pid)` + `WriteConsoleInput` removes the question instead of
   * answering it: the console is addressed by the pid the panel already
   * verifies, so no window is raised, no clipboard is borrowed, and which tab is
   * in front stops being something anybody has to know. Measured on the
   * non-active tab of a two-tab window, with the foreground unmoved
   * [docs/console-hosting.md §6].
   *
   * Both callers land here — a message and #203's permission digit — because
   * both are plain text and the difference between them was only ever the
   * mechanism. #362's picker keys take the same write since #402, through the
   * sequence builder rather than this two-chunk wrapper.
   */
  async sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    return this.writeToConsoleByPid(request)
  }

  /**
   * The runtime's MESSAGE route, which since #371 is the same write.
   *
   * The name is the port's rather than this mechanism's: nothing is pasted any
   * more, and the two methods are kept apart only because renaming the port's
   * message tier reaches the runtime, which this change stays out of. Anything
   * true of `sendToConsole` above is true here, and a test pins that they build
   * the identical script.
   */
  async pasteToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    return this.writeToConsoleByPid(request)
  }

  /**
   * One write into the console at `pid`, in a child of its own.
   *
   * **The child is the mechanism, not an implementation detail.** `FreeConsole`
   * and `AttachConsole` rebind the console of the process that CALLS them, and a
   * process may hold at most one — so this cannot run on the long-lived console
   * worker (consoleWorker.ts), which is one powershell.exe kept alive across
   * every console action: the first write would detach that shell from its own
   * console and leave it bound to a stranger's for every action after it, and
   * the queue in front of it would serialize the write against keystrokes it has
   * nothing to do with. `windowsHide` is load-bearing for the same family of
   * reasons — without it the child gets a console window, which the
   * default-terminal handoff turns into a Windows Terminal window that takes the
   * foreground, reintroducing on the delivery path the exact theft this removes.
   *
   * The builder refusing is a fail-closed guard, not an error path: a script
   * built around a pid that cannot name a process would attach to whatever
   * process happens to hold that number.
   *
   * `neverStarted` is carried from the exit code rather than inferred, exactly
   * as the paste path carried it from the focus step, so the runtime's relay
   * fallback keeps working on the same terms: only a failure that provably
   * reached no console may be sent again by another tier. See
   * `consoleWriteFailureFor`.
   */
  private async writeToConsoleByPid(request: ConsoleTextRequest): Promise<TextDeliveryOutcome> {
    // With files, the message is a longer chunk list rather than a different
    // mechanism (#408): each path inside bracketed-paste markers, the words
    // after them, Enter last and alone. The two-chunk wrapper below is still
    // what a text-only message takes, so nothing that worked before this change
    // takes a new path to reach the same script.
    const attachments = request.attachments ?? []
    const command =
      attachments.length === 0
        ? buildConsoleInputWriteCommand(request.pid, request.text, request.pressEnter)
        : buildConsoleInputSequenceCommand(
            request.pid,
            consoleChunksFor(request.text, attachments, request.pressEnter)
          )
    if (command === null) {
      return { delivered: false, error: CONSOLE_WRITE_UNBUILDABLE, neverStarted: true }
    }
    return this.runConsoleWriteScript(command)
  }

  /**
   * Run one built write script in a hidden child of its own, and turn what it
   * exits with into an outcome (#371, and #402's answer path).
   *
   * Shared by the two callers rather than written twice, because everything
   * below the builder is the same act: one child, one attach, and three exit
   * codes that mean three different things to the person whose session it is.
   * `neverStarted` is carried from the exit code rather than inferred, so the
   * runtime's relay fallback keeps working on the same terms — only a failure
   * that provably reached no console may be sent again by another tier.
   */
  private async runConsoleWriteScript(command: string): Promise<TextDeliveryOutcome> {
    const timer = createStageTimer(this.now)
    try {
      const result = await timer.measure('spawn', () => this.runConsoleWrite(command))
      if (result.exitCode !== 0) {
        const failure = consoleWriteFailureFor(result.exitCode)
        return {
          delivered: false,
          error: failure.error,
          ...(failure.wroteNothing ? { neverStarted: true } : {}),
          stages: timer.timings()
        }
      }
      return { delivered: true, stages: timer.timings() }
    } catch {
      // A shell that would not start wrote nothing, and one killed by the
      // timeout may have written everything: the two are indistinguishable from
      // here, so this takes the cautious reading and sets no `neverStarted`.
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
   * A bare ESC into the console at `pid`: bring it forward, then synthesize the
   * one keystroke the Claude Code TUI interrupts a turn on.
   *
   * Still a foreground act, and now by choice rather than for want of a
   * measurement: #402's pass wrote `0x1b` as a single text record into a live
   * Claude Code session's console and the running turn stopped, so this could
   * follow the picker's keys off the foreground. It did not move in that change
   * because a key that ends a turn — and the clean exit's Ctrl+C behind it,
   * which the same pass measured as `0x03` — is worth its own change and its own
   * test, not a passenger on one [docs/console-hosting.md §6].
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
   * Answer the AskUserQuestion picker this console is drawing: the chosen
   * options' digits, then the confirmation a multi-select needs (#362), written
   * into that console by pid with no window raised at all (#402).
   *
   * **This was the last tier that focused a window to press a key, and what
   * kept it there was a misreading.** A multi-select confirms with the right
   * arrow, and an arrow was taken to be a virtual key carrying no character —
   * the one record shape nothing had measured. ConPTY hands the hosted process
   * VT input, so the arrow the picker actually reads is `ESC [ C`, three
   * ordinary characters, and those the write path could always carry. Measured
   * live on 2026-09-16 against real single- and multi-select pickers, with the
   * transcript's `tool_result` proving the chosen options
   * [docs/console-hosting.md §6].
   *
   * So #329's shared-window refusal is gone from this path rather than
   * loosened: there is no foreground to be wrong about, which matters more here
   * than anywhere else — a digit in the wrong tab does not merely interrupt a
   * stranger's turn, it CHOOSES an option in it.
   *
   * The digits arrive already resolved to option positions (see questionKeys.ts
   * for the measurement and for the chunks), so nothing agent-authored reaches
   * the script and there is nothing here to escape. Two fail-closed guards in
   * front of the write, each with its own sentence: keys nothing may press — no
   * digits, a tenth option, a "digit" that is not one — and a pid that cannot
   * name a process.
   *
   * One child process for the whole sequence, on purpose: the toggles and their
   * confirmation are one act, and the attach they share is what keeps them
   * aimed at one console. Inside it each key is its own `WriteConsoleInputW`
   * call, because a key arriving inside another's call is read as pasted
   * content rather than as a keystroke (#404).
   */
  async answerQuestionAtConsole(request: ConsoleAnswerRequest): Promise<TextDeliveryOutcome> {
    const chunks = questionAnswerChunks(request.digits, request.submit)
    if (chunks === null) {
      return { delivered: false, error: ANSWER_KEYS_UNBUILDABLE, neverStarted: true }
    }
    const command = buildConsoleInputSequenceCommand(request.pid, chunks)
    if (command === null) {
      return { delivered: false, error: CONSOLE_WRITE_UNBUILDABLE, neverStarted: true }
    }
    return this.runConsoleWriteScript(command)
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
