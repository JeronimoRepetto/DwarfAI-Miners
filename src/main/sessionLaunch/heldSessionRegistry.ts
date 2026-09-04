import { HELDABLE_PROVIDERS } from '../domain/types'
import type {
  DwarfProvider,
  DwarfQuestionAnswerResult,
  FeedMessage,
  HeldSessionLaunchResult
} from '../domain/types'
import type { CliDetector } from '../platform/cliDetection'
import { HeldCrew, type HeldSessionSubagentSignal } from './heldCrew'
import {
  askToWireQuestion,
  heldTelemetryToWire,
  parseAskUserQuestion,
  prepareHeldPrompt,
  resolveAnswers,
  retainHeldMessage,
  type HeldAnswer,
  type HeldAsk,
  type HeldConversationState,
  type HeldCrewState,
  type HeldQuestionState,
  type HeldSessionHandle,
  type HeldSessionPort,
  type HeldSessionTelemetryUpdate,
  type HeldTelemetryState
} from './heldSession'

/**
 * Every session the panel is currently holding, and the ask-answer loop over
 * them (#86, #94).
 *
 * ## Lifetime, stated plainly
 *
 * A held session's child dies with the panel. That is the opposite bargain from
 * the detached launch mode, which hands the session over and lets go so it
 * survives a quit — and it is the price of the thing this mode exists for: a
 * question can only reach the panel live while the panel is the one holding the
 * stream. What survives either way is the session on disk: it persists to the
 * provider's own project directory and resumes by id afterwards, so quitting
 * costs the in-flight turn and nothing before it.
 *
 * The one thing that must never be papered over is an ask that was open when
 * the session went. It DISSOLVES: the blocked tool call is released with an
 * explicit "nobody answered", never with an empty answers record, because
 * telling an agent its user chose nothing is a different claim from telling it
 * nobody ever got to choose. Same rule at shutdown, and same rule when the turn
 * simply ends first.
 *
 * ## Why the id it is keyed by arrives late
 *
 * The CLI names its own session, and reports that name asynchronously after the
 * stream is up. So a record exists from the moment the port hands back a
 * handle, and its `sessionId` is filled in when the CLI says what it is — which
 * is also the id the ordinary poll will discover on disk, and therefore the one
 * link between a held stream and the dwarf drawn from it. An ask that arrives
 * before the id does is kept and becomes visible the moment it lands, rather
 * than being dropped for want of a key.
 *
 * ## What the poll actually sees, measured
 *
 * An SDK-hosted session was run once against the installed CLI (2026-09-02) to
 * check that assumption rather than assert it. It registers exactly like any
 * other: a `~/.claude/sessions/<pid>.json` entry carrying the same `sessionId`,
 * `cwd`, `pid`, `procStart` and `name` the provider reads, and a transcript at
 * `~/.claude/projects/<encoded cwd>/<session-id>.jsonl`. So there is no second
 * observation path here — the poll discovers a held session in the mine's own
 * folder, and the id above is what links the two.
 *
 * One detail worth knowing, because it engages a documented invariant: that
 * registry entry reports `kind: "interactive"`. Attendance is derived from
 * `kind`, so a held session gets the ATTENDED silence window — the long one.
 * That reading is correct rather than a leak: a human can answer a held
 * session, through this panel, which is precisely what the long window is for
 * (see contracts.ts on why the windows differ by who can answer).
 */

/* The list this enforces lives on the wire (`HELDABLE_PROVIDERS` in
 * contracts.ts), because the renderer reads the same one to decide which launch
 * channel a chip goes down. A local copy would be a second answer to "can this
 * provider be watched", and the panel would eventually offer a chip whose only
 * outcome is a refusal from here. */

/** Refusals, phrased for the panel. */
const EMPTY_PROMPT = 'Type a prompt first.'
const NOT_INSTALLED = 'Claude Code is not installed on this machine.'
const LAUNCH_FAILED = 'The agent could not be started.'
/** Fixed copy, and it names no path — the wire rule AgentProviderOption states. */
const NOT_HELDABLE = 'The panel can only hold a Claude session'
const NOT_HELD = 'That session is not one this panel is holding.'
const NO_SUCH_QUESTION = 'That question is no longer open.'
/** What a dissolved ask tells the agent. Never an answer — see the class comment. */
const DISSOLVED = 'The panel closed before this was answered.'

interface OpenAsk {
  ask: HeldAsk
  /** ISO time this host received the ask; the honest askedAt for a live one. */
  askedAt: string
  /** Releases the agent's blocked tool call. */
  release: (answer: HeldAnswer) => void
}

interface HeldRecord {
  mineId: string
  handle: HeldSessionHandle
  /** Undefined until the CLI reports the session id it chose. */
  sessionId?: string
  /**
   * Open asks by tool-use id. A map rather than one slot: the permission
   * callback documents several tool calls per assistant message, each with its
   * own id, so two asks can genuinely be open at once. The panel is shown the
   * latest, and any of them can be answered by naming its id.
   */
  openAsks: Map<string, OpenAsk>
  /**
   * Every `init`/`result` field this session's own message loop has reported
   * so far, merged as it arrives (issue #96). Starts empty rather than
   * undefined, so a merge never has to branch on "nothing reported yet".
   */
  telemetry: HeldSessionTelemetryUpdate
  /**
   * The subagents this session has out, folded from its own stream (#157).
   * Lives on the record rather than in a map keyed by session id, so it dies
   * with the session exactly as its open asks do — the crew of a session that
   * has gone is not a crew, and a later session reusing the id must start from
   * what its own stream says.
   */
  crew: HeldCrew
  /**
   * The exchange this host has watched go by on the stream (#159), oldest
   * first and bounded by `retainHeldMessage`. Seeded with the prompt this app
   * sent, which is the one message it knows first-hand without reading
   * anything: everything after it is what the stream itself carried.
   */
  conversation: FeedMessage[]
}

export interface HeldSessionRegistryOptions {
  /** Which CLIs are installed, and where (#91). */
  detector: CliDetector
  /** The Agent SDK seam. Injected in tests, which never spawn an agent. */
  start: HeldSessionPort
  /** The model held sessions run, or undefined for the CLI's own default. */
  model?: string
  /** A ceiling on agent turns, or undefined for the CLI's own default. */
  maxTurns?: number
  now?: () => number
  log?: (message: string) => void
}

export class HeldSessionRegistry {
  private readonly detector: CliDetector
  private readonly start: HeldSessionPort
  private readonly model: string | undefined
  private readonly maxTurns: number | undefined
  private readonly now: () => number
  private readonly log: (message: string) => void
  /** Keyed by an internal ordinal, because the session id arrives late. */
  private readonly held = new Map<number, HeldRecord>()
  private nextKey = 0

  constructor(options: HeldSessionRegistryOptions) {
    this.detector = options.detector
    this.start = options.start
    this.model = options.model
    this.maxTurns = options.maxTurns
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((message) => console.log(message))
  }

  /** How many sessions are held right now. A test seam, and the shutdown check. */
  count(): number {
    return this.held.size
  }

  /**
   * Start one held session in a mine's folder.
   *
   * Every failure becomes a `launched: false` verdict with a reason, never a
   * silent no-op — the discipline every delivery in this app holds. "Not
   * installed" is its own reason rather than being folded into "could not be
   * started": it is the one failure the user can act on, and detection already
   * knows how to say why.
   *
   * A successful verdict says a session started and nothing more. No dwarf is
   * returned and none is invented: the poll discovers the session in the mine's
   * folder, on its own schedule, exactly as it discovers one a human started.
   */
  async launch(request: {
    mineId: string
    provider: DwarfProvider
    minePath: string
    prompt: string
  }): Promise<HeldSessionLaunchResult> {
    // Refused before anything else, because nothing about this machine could
    // change the answer (#168). Holding a session IS an Agent SDK stream, and
    // Claude is the only provider that has one — `docs/command-surface-
    // evaluation.md` states that "Codex has no held-session engine in this app
    // (no equivalent of `sdkHeldSession.ts` exists for it)". This method used to
    // take no provider at all and detect `'claude'` unconditionally, so the only
    // thing it could do with a Codex chip was start Claude under Codex's name.
    // Naming the refused provider back is the point: the panel can say which
    // chip it was, and no session is substituted for another.
    if (!HELDABLE_PROVIDERS.includes(request.provider)) {
      return { launched: false, error: `${NOT_HELDABLE} (${request.provider})` }
    }

    const prompt = prepareHeldPrompt(request.prompt)
    // Cheapest refusal first, so an empty box never costs a disk probe.
    if (prompt === '') return { launched: false, error: EMPTY_PROMPT }

    const detection = await this.detector.detect(request.provider)
    if (!detection.installed || detection.path === undefined) {
      return {
        launched: false,
        error:
          detection.reason === undefined ? NOT_INSTALLED : `${NOT_INSTALLED} ${detection.reason}`
      }
    }

    const key = this.nextKey++
    // Built BEFORE the port is called, and written to through this reference
    // rather than through the record. `start` is awaited, so a `task_started`
    // arriving while it settles would otherwise find no record and be dropped —
    // and a launch signal dropped is a dwarf that never appears at all, for the
    // life of the session. The asks above accept that race because a dropped
    // ask is re-asked; a launch is announced once.
    const crew = new HeldCrew()
    try {
      const handle = await this.start({
        executablePath: detection.path,
        cwd: request.minePath,
        prompt,
        ...(this.model === undefined ? {} : { model: this.model }),
        ...(this.maxTurns === undefined ? {} : { maxTurns: this.maxTurns }),
        onSessionId: (sessionId) => this.recordSessionId(key, sessionId),
        onTelemetry: (update) => this.recordTelemetry(key, update),
        onMessage: (role, text) => this.recordMessage(key, role, text),
        onAsk: (toolUseId, input) => this.receiveAsk(key, toolUseId, input),
        onSubagent: (signal: HeldSessionSubagentSignal) => crew.apply(signal),
        onEnd: (reason) => this.finish(key, reason)
      })
      this.held.set(key, {
        mineId: request.mineId,
        handle,
        openAsks: new Map(),
        telemetry: {},
        crew,
        // The launch prompt is the record's first message, and the only one
        // seeded rather than watched: it is what this app sent, so it is known
        // first-hand and exactly once. Everything after it arrives through
        // recordMessage, off the stream.
        conversation: retainHeldMessage([], this.message('user', prompt))
      })
      // Length only, never the prompt — the rule every delivery log here holds.
      this.log(`[held] Session started in ${request.mineId} (${prompt.length} chars)`)
      return { launched: true }
    } catch (error) {
      console.warn(`[held] Could not start a session in ${request.mineId}`, error)
      return { launched: false, error: LAUNCH_FAILED }
    }
  }

  /**
   * Whether this panel holds a live stream into `sessionId` (#191).
   *
   * The one fact the Claude provider needs from here, and the reason it is a
   * separate question rather than `conversationState(id).held` read for its
   * flag: an SDK-hosted session's registry entry never carries a `status` —
   * the REPL writes that, and a held session has no REPL — so the provider
   * reads it as idle and would list no dwarf for the one session type this
   * app can actually type into. Holding the stream is the proof the session
   * is there. False for a session id the stream has not yet announced, which
   * is a session no dwarf could be matched to anyway.
   */
  holds(sessionId: string): boolean {
    return this.recordFor(sessionId) !== undefined
  }

  /**
   * What the panel should be told about this session's open asks.
   *
   * `held: false` for a session this panel does not hold, which is the reading
   * that leaves the provider's transcript-derived question alone. `held: true`
   * with no question is a DIFFERENT statement — this panel holds the stream and
   * knows nothing is open — and it is what clears a post-hoc question the tail
   * still carries. See stampHeldQuestions.
   */
  questionState(sessionId: string): HeldQuestionState {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { held: false }
    // The latest ask, matching the transcript parse's own rule (#94 phase 1):
    // with several open, the most recent is the one the user is looking at.
    const latest = [...record.openAsks.values()].pop()
    if (latest === undefined) return { held: true }
    return { held: true, question: askToWireQuestion(latest.ask, latest.askedAt) }
  }

  /**
   * What the panel should be told about this session's own self-reported
   * telemetry (issue #96) — `held: false` for a session this panel does not
   * hold, which leaves whatever that session's own provider derived (an
   * observed Claude session's transcript-tail `model`, above all) alone. See
   * HeldTelemetryState and stampHeldTelemetry.
   */
  telemetryState(sessionId: string): HeldTelemetryState {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { held: false }
    return { held: true, ...heldTelemetryToWire(record.telemetry) }
  }

  /**
   * What this session's own stream says about its crew (issue #157).
   *
   * `held: false` for a session this panel does not hold, which is what leaves
   * an observed session's transcript-derived subagents alone — this only ever
   * speaks for a stream it is actually reading. See stampHeldCrew and
   * stampHeldRank, which are the two things that read it.
   */
  crewState(sessionId: string): HeldCrewState {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { held: false }
    return { held: true, crew: record.crew }
  }

  /**
   * The exchange the panel may draw for this session (#159) — `held: false`
   * for one this panel does not hold, which is the reading that leaves the
   * panel to read an observed session's words off its own transcript instead.
   * See HeldConversationState and stampHeldConversation.
   */
  conversationState(sessionId: string): HeldConversationState {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { held: false }
    return { held: true, conversation: record.conversation }
  }

  /**
   * Answer one open ask, releasing the agent's blocked tool call.
   *
   * Refused rather than re-aimed when the id names an ask that is gone: the
   * question the user pressed and the question now open are two different
   * facts, and answering the second with a choice made about the first is how a
   * panel comes to put words in an agent's ear.
   *
   * A refusal leaves the call BLOCKED. That is deliberate: the ask is still
   * open, the user can answer it again, and a refusal that had released the
   * call would have spent the one answer it had on a reason instead.
   */
  answer(request: {
    sessionId: string
    toolUseId: string
    answers: unknown
  }): DwarfQuestionAnswerResult {
    const record = this.recordFor(request.sessionId)
    if (record === undefined) return { answered: false, error: NOT_HELD }
    const open = record.openAsks.get(request.toolUseId)
    if (open === undefined) return { answered: false, error: NO_SUCH_QUESTION }

    const resolved = resolveAnswers(open.ask, request.answers)
    if (!resolved.ok) return { answered: false, error: resolved.reason }

    record.openAsks.delete(request.toolUseId)
    open.release({ answered: true, answers: resolved.answers })
    this.log(`[held] Answered ${request.toolUseId} in ${record.mineId}`)
    return { answered: true }
  }

  /**
   * Put a user message onto a held session's own stream.
   *
   * The route, since #210: `sendDwarfText` resolves ownership before endpoint
   * kind, so a dwarf whose session this panel holds arrives here instead of
   * going out through the terminal and relay tiers — which for a held session
   * meant a pid owning no window followed by a relay queue no REPL drains.
   * `held-session` is the wire channel that says so.
   *
   * False means the session is not one this panel holds, or its stream would
   * not take the message. Either way the caller states the failure rather than
   * reaching for a second channel: there is no honest one here.
   */
  sendText(sessionId: string, text: string): boolean {
    const record = this.recordFor(sessionId)
    if (record === undefined) return false
    return record.handle.send(text)
  }

  /**
   * Cut the running turn short on a held session, leaving it open (#210).
   *
   * The panel's Kick, for the one session type this app can genuinely
   * interrupt. Not `closeAll`'s act and not `close`'s: a session this panel
   * ends is a session the user has to start again, and Kick has never meant
   * that on any other channel — the terminal tier sends one ESC keystroke and
   * the relay tier asks politely. This is the same request, made properly.
   *
   * False for a session this panel does not hold, and false when the stream
   * refused the interrupt. Nothing is retried and nothing else is attempted:
   * see sendText on why there is no second channel to fall back to.
   */
  async interrupt(sessionId: string): Promise<boolean> {
    const record = this.recordFor(sessionId)
    if (record === undefined) return false
    return record.handle.interrupt()
  }

  /**
   * Release every held session, dissolving whatever was open.
   *
   * Called on quit. Every ask still waiting is answered with "nobody answered"
   * rather than being left to hang, so the agent's own transcript records a
   * question that dissolved instead of a call that never returned.
   */
  closeAll(): void {
    for (const key of [...this.held.keys()]) {
      const record = this.held.get(key)!
      this.dissolve(record, DISSOLVED)
      this.held.delete(key)
      record.handle.close()
    }
  }

  private recordFor(sessionId: string): HeldRecord | undefined {
    if (sessionId === '') return undefined
    for (const record of this.held.values()) {
      if (record.sessionId === sessionId) return record
    }
    return undefined
  }

  private recordSessionId(key: number, sessionId: string): void {
    const record = this.held.get(key)
    if (record === undefined || sessionId === '') return
    record.sessionId = sessionId
  }

  /**
   * Merge one `init`/`result` update onto whatever this session has already
   * reported (issue #96). A plain merge, deliberately: every field in
   * HeldSessionTelemetryUpdate is documented as "a later value replaces the
   * one before it", including `totalCostUsd` and `usage`, whose RUNNING TOTAL
   * semantics make replacement the correct read — summing would double-count
   * the same cumulative figure across turns.
   */
  private recordTelemetry(key: number, update: HeldSessionTelemetryUpdate): void {
    const record = this.held.get(key)
    if (record === undefined) return
    record.telemetry = { ...record.telemetry, ...update }
  }

  /**
   * Keep one message the stream carried (#159). The bound, the redaction and
   * the "nothing was said" case all live in `retainHeldMessage`, so this only
   * decides WHEN a message is seen — which is the one thing the registry knows
   * and the pure helper does not.
   */
  private recordMessage(key: number, role: FeedMessage['role'], text: string): void {
    const record = this.held.get(key)
    if (record === undefined) return
    record.conversation = retainHeldMessage(record.conversation, this.message(role, text))
  }

  /** One message stamped with this host's own clock — the only honest time there is. */
  private message(role: FeedMessage['role'], text: string): FeedMessage {
    return { role, text, timestamp: new Date(this.now()).toISOString() }
  }

  /**
   * One ask reaching the permission callback. The returned promise is what
   * keeps the agent's tool call blocked, and it settles exactly once: on an
   * answer, or on the session ending.
   *
   * A malformed ask is refused rather than shown. The input is the model's own
   * output, so it is validated here as any payload crossing a boundary is — and
   * an ask this panel could not render is one it must not claim to be waiting
   * on, so the call is released with a reason instead of hanging on a question
   * nobody will ever see.
   */
  private receiveAsk(
    key: number,
    toolUseId: string,
    input: Record<string, unknown>
  ): Promise<HeldAnswer> {
    const record = this.held.get(key)
    const ask = parseAskUserQuestion(toolUseId, input)
    if (record === undefined || ask === null) {
      return Promise.resolve({
        answered: false,
        reason: 'The panel could not read that question.'
      })
    }
    const askedAt = new Date(this.now()).toISOString()
    return new Promise<HeldAnswer>((release) => {
      record.openAsks.set(toolUseId, { ask, askedAt, release })
    })
  }

  private finish(key: number, reason: string): void {
    const record = this.held.get(key)
    if (record === undefined) return
    this.dissolve(record, `${DISSOLVED} (${reason})`)
    this.held.delete(key)
  }

  private dissolve(record: HeldRecord, reason: string): void {
    for (const [toolUseId, open] of record.openAsks) {
      record.openAsks.delete(toolUseId)
      open.release({ answered: false, reason })
    }
  }
}
