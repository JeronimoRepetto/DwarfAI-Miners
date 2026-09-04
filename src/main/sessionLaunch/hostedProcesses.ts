import type { FeedMessage } from '../domain/types'
import { prepareHeldPrompt, retainHeldMessage } from './heldSession'
import { parseHostedCommand } from './hostedCommand'

/**
 * Every process the panel is HOLDING over stdio, and what it may honestly say
 * about one (#194).
 *
 * ## What this is, in one sentence
 *
 * A command the person typed into Add > Other, started as a child of this
 * process, with the first prompt on its stdin, its output captured as plain
 * text, and its dwarf drawn from the fact that THIS PANEL is holding it. It is
 * not a session anybody observed.
 *
 * ## Why it needs no session store, which is the reversal
 *
 * `docs/custom-launch-command.md` refused this feature on the ground that a
 * custom process writes no session store, so no provider could read one and no
 * dwarf could ever be drawn. Every fact in that argument is still true. The
 * conclusion is not, and the maintainer reversed it on 2026-09-04: the panel
 * observes terminals AND is a terminal itself, and a process the panel holds
 * does not need a session FILE to be observed, because the panel is its stdio.
 * There is still exactly one observation path per dwarf; for these dwarfs the
 * observer is this class.
 *
 * ## Slice 1 is pipes, not a pty
 *
 * Stdio pipes, and nothing else. The maintainer's decision on #194 splits a
 * real pty (`node-pty`, a terminal view, this project's first native module and
 * a per-platform build matrix) into its own later issue with its own decision.
 * So this serves any CLI with a non-interactive mode and buys no native
 * module — and a program that only draws a TUI will produce escape sequences
 * here rather than a screen. That is a stated limit, not a bug to work around
 * by parsing them: `docs/console-hosting.md`'s reason against a pty stands for
 * FACTS ("owning the bytes is not understanding them"), and #60's refusal to
 * infer a blocked state from rendered output is untouched by anything here.
 *
 * ## What a hosted dwarf can and cannot say about itself
 *
 * It can say: which mine it is in, which program it is, whether that process is
 * still running, and the exchange this panel watched go by on its pipes. That
 * is the complete list, and `HostedProcessState` is deliberately no wider —
 * tier, subagents, model, effort, tokens, blocked reasons and reactions all
 * come from a transcript, and there is no transcript. Absent is the honest
 * reading everywhere else in this app (`absent beats guessed`), and it is the
 * honest reading here.
 *
 * ## Lifetime, stated plainly
 *
 * A hosted process dies with the panel, exactly as a held session's child does
 * and for a stronger reason: the panel IS its stdio, so a process that outlived
 * it would have nobody reading its output or writing its input. That is the
 * opposite bargain from the detached launch mode (#112, #217), which hands the
 * session over on purpose so it survives a quit. Both belong; this is the one
 * whose whole point is being held.
 *
 * ## Why LaunchedSessionRegistry is not what holds these
 *
 * It looks like the same job and is not. That register's entire subject is
 * CLAIMING which observed session a detached launch became — the folder, the
 * provider, the session ids already on the board, "the first session root of
 * that provider to appear in that mine". A hosted process is never observed and
 * never appears in anybody's storage, so there is nothing to claim and no
 * evidence to claim it from. What is genuinely reused is the seam under it:
 * `platform/processEnd.ts`'s tree kill (#230), which is the per-OS half.
 */

/** Refusals and failures, phrased for the panel. Fixed copy, and never a path. */
const EMPTY_PROMPT = 'Type a prompt first.'
const COULD_NOT_START = 'That command could not be started.'

/** The handle the holder keeps on one running child. */
export interface HostedProcessHandle {
  /**
   * The process this panel spawned, or undefined when it reported none.
   *
   * Undefined means there is no exit to offer: ending a tree needs a pid, and
   * a remembered number for a process that never reported one is how an
   * unrelated process gets killed (the guard #217 states).
   */
  readonly pid?: number
  /**
   * Write one message onto the child's stdin. False when the stream refused
   * it, which the caller states rather than retries — there is no second
   * channel into a process whose only channel is this pipe.
   */
  send(text: string): boolean
}

/**
 * One request to start a held child. The prompt is a FIELD rather than part of
 * `args` on purpose: the argv/stdin split is the privacy rule at the top of
 * launch.ts, and putting it in the shape is what stops a caller undoing it.
 */
export interface HostedProcessStartRequest {
  program: string
  args: readonly string[]
  /** The mine's folder. This, and nothing else, is what puts the dwarf in the right mine. */
  cwd: string
  env: NodeJS.ProcessEnv
  /** The first prompt, written to the child's stdin and never placed in argv. */
  prompt: string
  /** One chunk of stdout or stderr, as it arrives. */
  onOutput(text: string): void
  /** The process is gone, by its own exit or by our kill. */
  onEnd(reason: string): void
}

/** The spawn seam. Injected in tests, which never start a real process. */
export type HostedProcessPort = (request: HostedProcessStartRequest) => Promise<HostedProcessHandle>

/**
 * What the panel may be told about one hosted process.
 *
 * Every field here is something this panel knows FIRST-HAND, and that is the
 * whole of the shape: see the class comment on what a hosted dwarf cannot say.
 */
export interface HostedProcessState {
  hostedId: string
  /** The mine the launch named. */
  mineId: string
  /** That mine's folder, kept so a mine nobody is working can still be drawn. */
  minePath: string
  /** The program, as it was parsed out of what the person typed. Never the full argv. */
  program: string
  /** False once that process is gone — by its own exit or by our kill. */
  running: boolean
  /** The exchange this panel watched go by on its pipes, oldest first. */
  conversation: FeedMessage[]
}

/**
 * What ending a hosted process actually did. The same three verdicts
 * `EndLaunchVerdict` carries, and for the same reason: 'already-ended' covers
 * a process that exited on its own AND a second kick after a successful one —
 * nothing was signalled either way, and saying "ended" twice would be claiming
 * an act this did not perform.
 */
export type EndHostedVerdict = 'ended' | 'already-ended' | 'refused'

export interface HostedLaunchOutcome {
  started: boolean
  /** The id of the process now being held, when one is. */
  hostedId?: string
  /** Human-readable reason shown in the panel when started is false. */
  error?: string
}

interface HostedRecord {
  hostedId: string
  mineId: string
  minePath: string
  program: string
  handle: HostedProcessHandle
  gone: boolean
  conversation: FeedMessage[]
}

export interface HostedProcessRegistryOptions {
  /** The spawn seam; see nodeHostedProcess.ts for the real one. */
  start: HostedProcessPort
  /** Ends a process and everything below it; see platform/processEnd.ts (#230). */
  endProcessTree: (pid: number) => Promise<boolean>
  /** The environment the child inherits. Passed in rather than read, like every other engine here. */
  env: NodeJS.ProcessEnv
  now?: () => number
  log?: (message: string) => void
}

export class HostedProcessRegistry {
  private readonly start: HostedProcessPort
  private readonly endProcessTree: (pid: number) => Promise<boolean>
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly held = new Map<string, HostedRecord>()
  private sequence = 0

  constructor(options: HostedProcessRegistryOptions) {
    this.start = options.start
    this.endProcessTree = options.endProcessTree
    this.env = options.env
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((message) => console.log(message))
  }

  /** How many processes are held right now. A test seam, and the shutdown check. */
  count(): number {
    return this.held.size
  }

  /**
   * Start one command in a mine's folder and keep hold of it.
   *
   * Every failure becomes a `started: false` verdict with a reason, never a
   * silent no-op — the discipline every delivery and both launch engines in
   * this app hold, and the specific thing #194 reported: "nothing happens" was
   * a refusal nobody could see, and a refusal that is not seen is a freeze.
   *
   * The refusals are ordered by how cheap they are to be sure of, so a
   * malformed command or an empty box never costs a spawn.
   */
  async launch(request: {
    mineId: string
    minePath: string
    command: string
    prompt: string
  }): Promise<HostedLaunchOutcome> {
    const parsed = parseHostedCommand(request.command)
    if (!parsed.ok) return { started: false, error: parsed.reason }

    const prompt = prepareHeldPrompt(request.prompt)
    if (prompt === '') return { started: false, error: EMPTY_PROMPT }

    this.sequence += 1
    const hostedId = `hosted:${this.sequence}`
    try {
      const handle = await this.start({
        program: parsed.program,
        args: parsed.args,
        cwd: request.minePath,
        env: this.env,
        prompt,
        onOutput: (text) => this.recordOutput(hostedId, text),
        onEnd: (reason) => this.finish(hostedId, reason)
      })
      this.held.set(hostedId, {
        hostedId,
        mineId: request.mineId,
        minePath: request.minePath,
        program: parsed.program,
        handle,
        gone: false,
        // The prompt is the record's first message, and the only one seeded
        // rather than watched: it is what this app sent, so it is known
        // first-hand and exactly once. It is also the receipt the panel adopts
        // this launch by — see launchedDwarfIn, which recognises a launch by
        // the first message of its conversation and nothing else.
        conversation: retainHeldMessage([], this.message('user', prompt))
      })
      // Length only, never the prompt — the rule every delivery log here holds.
      this.log(`[hosted] ${parsed.program} started in ${request.mineId} (${prompt.length} chars)`)
      return { started: true, hostedId }
    } catch (error) {
      console.warn(`[hosted] Could not start a command in ${request.mineId}`, error)
      return { started: false, error: COULD_NOT_START }
    }
  }

  /**
   * Every process this panel is holding, for the stamp that draws them.
   *
   * A process that has GONE is still reported, on purpose: the board gives
   * every departing dwarf the same leaving grace and walks it out to a spawn
   * point, and one that vanished from this list would blink off instead.
   * `finish` is what forgets it, once that grace has been served.
   */
  states(): HostedProcessState[] {
    return [...this.held.values()].map((record) => ({
      hostedId: record.hostedId,
      mineId: record.mineId,
      minePath: record.minePath,
      program: record.program,
      running: !record.gone,
      conversation: record.conversation
    }))
  }

  /**
   * Put a user message onto a hosted process's own stdin.
   *
   * The thing a DETACHED launch structurally cannot do, and half of why this
   * mode exists: `launchRunner` closes stdin straight after the prompt, so
   * there is no inbox behind one (#217's launchedNoInboxReason says so in the
   * panel). Here the pipe is still open and this panel is still holding it.
   *
   * False for a process this panel does not hold, one that has ended, or a
   * stream that refused the write. The caller states the failure rather than
   * reaching for a second channel: there is no honest one — this pipe is the
   * only way in that ever existed for this process.
   */
  sendText(hostedId: string, text: string): boolean {
    const record = this.held.get(hostedId)
    if (record === undefined || record.gone) return false
    if (!record.handle.send(text)) return false
    // Kept only once the stream took it, so the panel never shows a message
    // as sent that the pipe refused.
    record.conversation = retainHeldMessage(record.conversation, this.message('user', text))
    return true
  }

  /**
   * End one hosted process's tree.
   *
   * A tree rather than a pid because a hosted process may have started tools of
   * its own that no job object of ours holds — the measured reasoning in
   * `platform/processEnd.ts`, whose port this is.
   *
   * Never signals a process already gone: once it has exited its number can
   * belong to anything on this machine (#217's pid-reuse guard). Never claims
   * success the platform did not report either — a refused kill leaves the
   * process held, because it really may still be running and a second attempt
   * is honest.
   */
  async end(hostedId: string): Promise<EndHostedVerdict> {
    const record = this.held.get(hostedId)
    if (record === undefined || record.gone) return 'already-ended'
    const pid = record.handle.pid
    // No pid is no exit, not a guess at one. See HostedProcessHandle.pid.
    if (pid === undefined) return 'refused'
    const ended = await this.endProcessTree(pid)
    if (!ended) return 'refused'
    record.gone = true
    this.log(`[hosted] ${hostedId} ended`)
    return 'ended'
  }

  /**
   * End every hosted process, and forget them.
   *
   * Called on quit, and it is where the lifetime bargain in the class comment
   * is actually paid: a hosted process dies with the panel because the panel is
   * its stdio, so leaving one running would leave a child nobody can read from
   * or write to.
   */
  async closeAll(): Promise<void> {
    const ids = [...this.held.keys()]
    for (const id of ids) {
      await this.end(id)
      this.held.delete(id)
    }
  }

  /**
   * Forget a process whose departure the board has finished drawing.
   *
   * Separate from `end` because they are different acts: `end` kills, this
   * only stops reporting. The runtime calls it once the dwarf has left, for
   * the reason `states()` keeps a gone process in the first place.
   */
  forget(hostedId: string): void {
    const record = this.held.get(hostedId)
    if (record === undefined || !record.gone) return
    this.held.delete(hostedId)
  }

  private recordOutput(hostedId: string, text: string): void {
    const record = this.held.get(hostedId)
    if (record === undefined) return
    // Bounded and redacted by retainHeldMessage, which is the same rule a held
    // session's own words go through: redaction happens on the way IN, so a
    // secret never lives in this process's memory waiting for a future caller
    // to remember to strip it.
    record.conversation = retainHeldMessage(record.conversation, this.message('assistant', text))
  }

  private finish(hostedId: string, reason: string): void {
    const record = this.held.get(hostedId)
    if (record === undefined) return
    record.gone = true
    this.log(`[hosted] ${hostedId} is gone (${reason})`)
  }

  /** One message stamped with this host's own clock — the only honest time there is. */
  private message(role: FeedMessage['role'], text: string): FeedMessage {
    return { role, text, timestamp: new Date(this.now()).toISOString() }
  }
}
