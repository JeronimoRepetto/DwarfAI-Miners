import type { LaunchTuning } from '../domain/launchTuning'
import { notInstalledReason } from '../domain/launchProviders'
import { HELDABLE_PROVIDERS } from '../domain/types'
import type {
  DwarfPermissionDecision,
  DwarfProvider,
  DwarfQuestionAnswerResult,
  DwarfTuningChange,
  DwarfTuningResult,
  FeedActivity,
  FeedMessage,
  HeldSessionLaunchResult
} from '../domain/types'
import type { CliDetector } from '../platform/cliDetection'
import { HeldCrew, type HeldSessionSubagentSignal } from './heldCrew'
import {
  askToWireQuestion,
  HELD_CONTEXT_USAGE_TIMEOUT_MS,
  HELD_TUNING_TIMEOUT_MS,
  heldTelemetryToWire,
  parseAskUserQuestion,
  permissionToWire,
  prepareHeldPrompt,
  resolveAnswers,
  retainHeldMessage,
  type HeldActivityState,
  type HeldAnswer,
  type HeldAsk,
  type HeldConversationState,
  type HeldCrewState,
  type HeldPermission,
  type HeldPermissionAnswer,
  type HeldQuestionState,
  type HeldSessionHandle,
  type HeldSessionPorts,
  type HeldSessionTelemetryUpdate,
  type HeldTelemetryState,
  type HeldTuningState
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
 * The one thing that must never be papered over is an ask or a permission
 * prompt that was open when the session went. Both DISSOLVE, and the two
 * dissolutions are not the same shape. An ask is released with an explicit
 * "nobody answered", never with an empty answers record, because telling an
 * agent its user chose nothing is a different claim from telling it nobody
 * ever got to choose. A permission prompt is released with `{ decision:
 * 'deny', reason: ... }` — a DENIAL with a stated reason, never an approval:
 * the tool call is still blocked on a decision, and the only decision this
 * registry may hand back on its own is the one that leaves nothing running
 * unattended. Same rule at shutdown, and same rule when the turn simply ends
 * first.
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
const LAUNCH_FAILED = 'The agent could not be started.'
/**
 * Fixed copy, and it names no path — the wire rule AgentProviderOption states.
 *
 * AMENDED for #237, step 5 (was: 'The panel can only hold a Claude session').
 * Two providers can be held now, so a sentence naming one of them would be
 * wrong for a chip refused while the other was the reason. The refused
 * provider's own name is appended by the caller below, which is what #168 made
 * this refusal for in the first place.
 */
const NOT_HELDABLE = 'The panel cannot hold a session for that agent'
const NOT_HELD = 'That session is not one this panel is holding.'
const NO_SUCH_QUESTION = 'That question is no longer open.'
const NO_SUCH_PERMISSION = 'That permission request is no longer open.'
/**
 * What a dissolved ask, or a dissolved permission prompt, tells the agent —
 * the same fixed sentence for both, and for a permission prompt it is a
 * DENIAL with this reason, never an approval. See the class comment.
 */
const DISSOLVED = 'The panel closed before this was answered.'
/** What a user-declined permission prompt tells the agent. */
const DECLINED_PERMISSION = 'The user declined this from the DwarfAI-Miners panel.'

/*
 * The four fixed sentences a refused tuning change is reported with (issue
 * #96). EXPORTED, unlike the copy above, and for one reason: the panel's
 * session strip draws these words, so what they say is part of the contract
 * rather than an implementation detail — a strip that cannot word a refusal
 * is a control that quietly did nothing, which is the outcome this whole
 * surface exists to avoid. Each names a different fact, because collapsing
 * them would tell the reader "it did not work" and nothing they could act on.
 */
/** The session is not one this panel holds; there is no stream to ask on. */
export const TUNING_NOT_HELD = 'The panel is not holding this session.'
/** The engine behind this session has no such act at all — see HeldSessionHandle. */
export const TUNING_UNSUPPORTED = 'This session cannot change that while it runs.'
/** The session was asked and said no: one already closing, above all. */
export const TUNING_REFUSED = 'The session would not take that change.'
/** The deadline elapsed with no answer. Never retried — see HELD_TUNING_TIMEOUT_MS. */
export const TUNING_TIMED_OUT = 'The session did not answer in time.'

interface OpenAsk {
  ask: HeldAsk
  /** ISO time this host received the ask; the honest askedAt for a live one. */
  askedAt: string
  /** Releases the agent's blocked tool call. */
  release: (answer: HeldAnswer) => void
}

/**
 * One tool call blocked on a permission decision (#203) — the same shape as
 * OpenAsk, and deliberately a SEPARATE map on the record rather than a shared
 * one: an ask and a permission prompt answer through different verdict
 * shapes, and `decidePermission` must never be able to reach into `openAsks`
 * however the ids happen to line up.
 */
interface OpenPermission {
  prompt: HeldPermission
  /** ISO time this host received the prompt; the honest askedAt for a live one. */
  askedAt: string
  /** Releases the agent's blocked tool call. */
  release: (answer: HeldPermissionAnswer) => void
}

interface HeldRecord {
  mineId: string
  /**
   * The mine's folder, kept because one provider's own store cannot recover it
   * (#237, step 5).
   *
   * An Antigravity conversation started in stream-json print mode writes NO
   * `history.jsonl` record — measured on CLI 1.1.26, 2026-09-07 — and that file
   * is the only thing in its store that says which folder a conversation
   * belongs to, so its observer drops a held conversation outright. This is the
   * one fact that recovers it, and it is first-hand rather than inferred: this
   * app chose the folder, started the process in it, and the CLI's own `init`
   * message echoed the same path back. See heldWorkspace.
   */
  minePath: string
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
   * Open permission prompts by tool-use id (#203) — the same map shape as
   * `openAsks`, and the same reason for being one: several tool calls can
   * genuinely be blocked at once. The panel is shown the latest, and any of
   * them can be decided by naming its id.
   */
  openPermissions: Map<string, OpenPermission>
  /**
   * Every `init`/`result` field this session's own message loop has reported
   * so far, merged as it arrives (issue #96). Starts with `{ turn: 'started'
   * }` rather than empty (issue #245) — the launch prompt sent before this
   * record exists IS the first turn's start — so a merge never has to branch
   * on "nothing reported yet".
   */
  telemetry: HeldSessionTelemetryUpdate
  /**
   * The context-usage pull in flight for this session, if any (issue #96) —
   * so a mine reopened twice in a second, or a turn ending while the last
   * pull is still on the wire, JOINS that same control request rather than
   * putting a second one on the stream (the maintainer's "no retry storm"
   * ruling). Cleared the moment this settles, whether with a real answer or
   * this app's own timeout — never left pointing at a pull that can no longer
   * change anything.
   */
  contextUsagePull?: Promise<void>
  /**
   * The model this panel asked for and nothing has confirmed yet (issue #96).
   *
   * Held here rather than merged straight onto `telemetry.model`, because the
   * two are different claims: `telemetry` is what the CLI SAID, and this is
   * what it was ASKED. Writing a request into the reported field would make
   * the panel show a change on the strength of having requested it — the one
   * thing the maintainer's verification rule forbids. Cleared the moment any
   * report from the session (a context reading, or the next `init`) names
   * this same model, which is what turns the request into a fact.
   */
  requestedModel?: string
  /**
   * The effort this panel asked for, on the same terms (issue #96) — with one
   * difference that matters: this one may never clear. Nothing about
   * `applyFlagSettings` resolving proves an effect, and the only report that
   * could confirm it is the next `init`'s own `effort`, which arrives at the
   * start of the next turn or not at all. A field left standing forever is
   * the honest reading of a setting nothing echoed back.
   */
  requestedEffort?: string
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

/**
 * What ending a held turn actually did (#237, step 5).
 *
 * A verdict rather than a boolean, because a boolean answered two different
 * questions with one word. `'refused'` is a session that HAS an interrupt and
 * did not take it — already ending, or a control request that failed — and
 * `'unsupported'` is a protocol with no cancellation in it at all
 * (Antigravity's stream-json input side documents user text events and
 * nothing else). The panel says different things about the two, and telling a
 * person their kick "didn't take" when nothing could ever take it is the kind
 * of near-miss sentence this app treats as a lie.
 */
export type HeldInterruptVerdict = 'interrupted' | 'refused' | 'unsupported' | 'not-held'

export interface HeldSessionRegistryOptions {
  /** Which CLIs are installed, and where (#91). */
  detector: CliDetector
  /**
   * One held-session engine per provider that has one (#237, step 5) —
   * injected in tests, which never spawn an agent.
   *
   * AMENDED for #237, step 5 (was: a single `HeldSessionPort`, which could
   * only ever be Claude's). A table because there are two engines now and the
   * registry has to pick; see HeldSessionPorts on why a name in
   * `HELDABLE_PROVIDERS` with no row here is refused rather than started
   * under whichever engine happened to be injected.
   */
  start: HeldSessionPorts
  /** The model held sessions run, or undefined for the CLI's own default. */
  model?: string
  /** A ceiling on agent turns, or undefined for the CLI's own default. */
  maxTurns?: number
  now?: () => number
  log?: (message: string) => void
}

export class HeldSessionRegistry {
  private readonly detector: CliDetector
  private readonly start: HeldSessionPorts
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
  async launch(
    request: {
      mineId: string
      provider: DwarfProvider
      minePath: string
      prompt: string
      /**
       * The permission mode this launch asked for (#239), already checked at
       * the boundary against `HELD_PERMISSION_MODES` — never `'bypassPermissions'`.
       * Absent leaves the SDK on its own `'default'`.
       */
      permissionMode?: string
    } & LaunchTuning
  ): Promise<HeldSessionLaunchResult> {
    // Refused before anything else, because nothing about this machine could
    // change the answer (#168). Holding a session IS an Agent SDK stream, and
    // Claude is the only provider that has one — `docs/command-surface-
    // evaluation.md` states that "Codex has no held-session engine in this app
    // (no equivalent of `sdkHeldSession.ts` exists for it)". This method used to
    // take no provider at all and detect `'claude'` unconditionally, so the only
    // thing it could do with a Codex chip was start Claude under Codex's name.
    // Naming the refused provider back is the point: the panel can say which
    // chip it was, and no session is substituted for another.
    // AMENDED for #237, step 5: the wire list is still the authority on
    // WHETHER a provider may be held, and the engine table says which
    // implementation answers when it is. Both are checked here, and a name in
    // the list with no engine behind it is refused exactly as an unheldable
    // one is — never started under whichever engine happened to be composed,
    // which is the substitution #168 removed from this method.
    const engine = HELDABLE_PROVIDERS.includes(request.provider)
      ? this.start[request.provider]
      : undefined
    if (engine === undefined) {
      return { launched: false, error: `${NOT_HELDABLE} (${request.provider})` }
    }

    const prompt = prepareHeldPrompt(request.prompt)
    // Cheapest refusal first, so an empty box never costs a disk probe.
    if (prompt === '') return { launched: false, error: EMPTY_PROMPT }

    const detection = await this.detector.detect(request.provider)
    if (!detection.installed || detection.path === undefined) {
      // Named per provider since #237, step 5: "Claude Code is not installed"
      // shown for an Antigravity chip would send somebody to install the wrong
      // program at the one moment the sentence was supposed to help.
      const notInstalled = notInstalledReason(request.provider)
      return {
        launched: false,
        error: detection.reason === undefined ? notInstalled : `${notInstalled} ${detection.reason}`
      }
    }

    // The request's model wins over the configured one (#239). The configured
    // value is kept rather than dropped: it is what a launch that names no
    // model still gets, so an installation that set one goes on getting it and
    // the Add Panel's row is an override rather than a replacement. Effort has
    // no configured layer at all — there is nowhere for a stale default to
    // live, so its only two answers are this launch's and the CLI's own.
    const model = request.model ?? this.model

    const key = this.nextKey++
    // Built BEFORE the port is called, and written to through this reference
    // rather than through the record. `start` is awaited, so a `task_started`
    // arriving while it settles would otherwise find no record and be dropped —
    // and a launch signal dropped is a dwarf that never appears at all, for the
    // life of the session. The asks above accept that race because a dropped
    // ask is re-asked; a launch is announced once.
    const crew = new HeldCrew()
    try {
      const handle = await engine({
        executablePath: detection.path,
        cwd: request.minePath,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
        ...(this.maxTurns === undefined ? {} : { maxTurns: this.maxTurns }),
        onSessionId: (sessionId) => this.recordSessionId(key, sessionId),
        onTelemetry: (update) => this.recordTelemetry(key, update),
        onMessage: (role, text, activity) => this.recordMessage(key, role, text, activity),
        onAsk: (toolUseId, input) => this.receiveAsk(key, toolUseId, input),
        onPermission: (prompt) => this.receivePermission(key, prompt),
        onSubagent: (signal: HeldSessionSubagentSignal) => crew.apply(signal),
        onEnd: (reason) => this.finish(key, reason)
      })
      this.held.set(key, {
        mineId: request.mineId,
        minePath: request.minePath,
        handle,
        openAsks: new Map(),
        openPermissions: new Map(),
        // Seeded 'started' rather than empty (issue #245): the launch prompt
        // IS the first turn's start, and it is sent above before this record
        // even exists — there is no `init` message to wait for, so a held
        // dwarf would otherwise read idle for the gap between launch and the
        // CLI's first reported message.
        telemetry: { turn: 'started' },
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
   * What the panel should be told about this session's open asks and open
   * permission prompts.
   *
   * `held: false` for a session this panel does not hold, which is the reading
   * that leaves the provider's transcript-derived question alone. `held: true`
   * with neither field is a DIFFERENT statement — this panel holds the stream
   * and knows nothing is open — and it is what clears a post-hoc question the
   * tail still carries. See stampHeldQuestions.
   *
   * `question` and `permission` are read independently and may both be
   * present: an ask and a permission prompt are unrelated tool calls, so
   * neither's presence says anything about the other's (#203).
   */
  questionState(sessionId: string): HeldQuestionState {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { held: false }
    // The latest of each, matching the transcript parse's own rule (#94 phase
    // 1): with several open, the most recent is the one the user is looking at.
    const latestAsk = [...record.openAsks.values()].pop()
    const latestPermission = [...record.openPermissions.values()].pop()
    return {
      held: true,
      ...(latestAsk === undefined
        ? {}
        : { question: askToWireQuestion(latestAsk.ask, latestAsk.askedAt) }),
      ...(latestPermission === undefined
        ? {}
        : { permission: permissionToWire(latestPermission.prompt, latestPermission.askedAt) })
    }
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
   * What the panel should draw for this session's status and waiting reason,
   * live (issue #245) — `held: false` for a session this panel does not
   * hold, which leaves the provider's own idle reading alone (see
   * `holds` on why that reading is wrong for every held session). See
   * HeldActivityState and stampHeldStatus.
   *
   * Precedence, in the order checked below: an open ask or open permission
   * prompt means the session cannot move until a human decides, which
   * outranks whether a turn is nominally still running — being blocked on
   * one IS a kind of turn still running, and the more informative fact is
   * what it is blocked ON. An ask outranks a permission prompt when both are
   * open, matching WAITING_ON_HUMAN_REASON's own precedence. With neither
   * open, a turn still running (nothing has ended it since the last thing
   * that started one — the launch prompt, a sent message, or an `init`) reads
   * `working`; anything else is idle between turns.
   */
  activityState(sessionId: string): HeldActivityState {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { held: false }
    if (record.openAsks.size > 0) {
      return { held: true, status: 'waiting', waitingReason: 'user-input' }
    }
    if (record.openPermissions.size > 0) {
      return { held: true, status: 'waiting', waitingReason: 'approval' }
    }
    return record.telemetry.turn === 'started'
      ? { held: true, status: 'working' }
      : { held: true, status: 'waiting' }
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
   * Pull this session's own context-window reading, on demand (issue #96) —
   * the one telemetry field no stream message carries (see
   * HeldSessionHandle.contextUsage). WHEN this is called is the maintainer's
   * refresh policy, decided above this registry (the mine opening, and the
   * end of a turn) — this only decides how one pull behaves once asked for.
   *
   * A silent no-op for a session this panel does not hold, the same refusal
   * every other lookup here gives: there is no stream to ask.
   *
   * At most one control request in flight per session. A caller that asks
   * again while one is still on the wire JOINS that same pull instead of
   * starting a second — the no-retry-storm half of the policy — and every
   * joiner resolves together once it settles. Bounded by
   * HELD_CONTEXT_USAGE_TIMEOUT_MS so a session that never answers cannot hang
   * this forever: a timeout leaves the session's last known reading exactly
   * as it was, and so does the session answering that it could not say
   * (`null`) — neither is a fact worth overwriting a real reading with.
   */
  async refreshContextUsage(sessionId: string): Promise<void> {
    const record = this.recordFor(sessionId)
    if (record === undefined) return
    // A protocol with no context-window reading in it at all (#237, step 5).
    // Silently nothing, exactly as an unheld session is: there is no request
    // to put on the wire, so there is no failure to report either.
    if (record.handle.contextUsage === undefined) return
    if (record.contextUsagePull !== undefined) return record.contextUsagePull
    const pull = this.pullContextUsage(record)
    record.contextUsagePull = pull
    try {
      await pull
    } finally {
      // Only clear the slot this pull itself opened: a fresh pull started
      // after this one settled must not have its own tracking wiped out from
      // under it by a stale finally block still unwinding.
      if (record.contextUsagePull === pull) record.contextUsagePull = undefined
    }
  }

  /**
   * The pull itself, raced against the deadline. Never rejects: a session
   * whose handle throws is not this method's concern to retry or report, and
   * a rejection here would surface as an unhandled one to every joiner.
   *
   * A reading also carries the model the CLI believes is in force (issue
   * #96's mutating slice), which is merged onto the same telemetry `model`
   * an `init` writes — the same CLI saying the same thing, only later, so it
   * supersedes on exactly the terms every other field here does. That merge
   * IS the verification for a model change, and `confirmTuning` is where a
   * request stops being pending because of it.
   */
  private async pullContextUsage(record: HeldRecord): Promise<void> {
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), HELD_CONTEXT_USAGE_TIMEOUT_MS)
    })
    const pull = record.handle.contextUsage
    if (pull === undefined) return
    const usage = await Promise.race([pull.call(record.handle), timeout])
    if (usage === 'timeout' || usage === null) return
    record.telemetry = {
      ...record.telemetry,
      contextUsage: usage,
      ...(usage.model === undefined || usage.model === '' ? {} : { model: usage.model })
    }
    this.confirmTuning(record)
  }

  /**
   * Change a held session's own model or effort while it runs (issue #96).
   *
   * WHAT THIS PROMISES, precisely: `applied: true` means the session ACCEPTED
   * the request. It is not a claim the change took effect, and the difference
   * is the whole design — `applyFlagSettings({ effortLevel })` was measured
   * resolving cleanly on a model with no effort support and doing nothing at
   * all. So the request is recorded as PENDING, and only a later report from
   * the session itself promotes it to a fact:
   *
   * - a model is confirmed by the next context reading (pulled here, right
   *   after the change) or by the next `init` — both name the model the CLI
   *   believes is in force, and neither costs a paid turn;
   * - an effort is confirmed only by the next `init`'s own `effort`, which
   *   arrives at the start of the next turn or never. No reading is pulled
   *   for one: a context response says nothing about effort, so asking would
   *   be a control request that cannot answer the question it was made for.
   *
   * Every refusal is one of four fixed sentences and names a different fact
   * (see the constants above), because the strip shows it. Bounded by
   * HELD_TUNING_TIMEOUT_MS and never retried, on the same "no retry storm"
   * ruling `refreshContextUsage` holds: a deadline that elapses is reported
   * as a refusal the user can act on, not queued behind itself.
   *
   * A capability the handle does not declare is refused BEFORE anything is
   * attempted. That is the whole reason `setModel`/`setEffort` are optional on
   * the port: an engine with no such act is a fact readable without asking,
   * so the panel disables the control with a reason instead of offering one
   * that answers every click with a refusal.
   */
  async setTuning(sessionId: string, change: DwarfTuningChange): Promise<DwarfTuningResult> {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { applied: false, reason: TUNING_NOT_HELD }
    const act =
      change.kind === 'model'
        ? record.handle.setModel?.bind(record.handle)
        : record.handle.setEffort?.bind(record.handle)
    if (act === undefined) return { applied: false, reason: TUNING_UNSUPPORTED }

    const value = change.kind === 'model' ? change.model : change.effort
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), HELD_TUNING_TIMEOUT_MS)
    })
    const accepted = await Promise.race([act(value), timeout]).catch((error: unknown) => {
      console.warn(`[held] The session refused a ${change.kind} change`, error)
      return false
    })
    if (accepted === 'timeout') return { applied: false, reason: TUNING_TIMED_OUT }
    if (!accepted) return { applied: false, reason: TUNING_REFUSED }

    if (change.kind === 'model') {
      record.requestedModel = change.model
      // The verification, and the reason a model change needs no paid turn:
      // the reading names the model the CLI now believes is in force, and
      // `pullContextUsage` promotes the request the moment it agrees.
      await this.pullReadingAfterChange(sessionId)
    } else {
      record.requestedEffort = change.effort
    }
    this.log(`[held] Asked ${record.mineId} to change its ${change.kind}`)
    return { applied: true }
  }

  /**
   * A context reading that was STARTED after the change it has to verify
   * (issue #96).
   *
   * `refreshContextUsage` joins a pull already in flight rather than putting
   * a second control request on the same stream — the no-retry-storm rule,
   * and the right rule for a refresh. It is the wrong one here: a pull started
   * before the model changed cannot say anything about the change, so joining
   * it would leave the request pending until some later trigger happened to
   * fire, with the strip hedging about a change that had already taken hold.
   *
   * The fix is not a concurrent second request. It is waiting for the stale
   * one to settle — its own deadline bounds how long that is — and then asking
   * again, which is still one request on the wire at a time.
   */
  private async pullReadingAfterChange(sessionId: string): Promise<void> {
    const inFlight = this.recordFor(sessionId)?.contextUsagePull
    if (inFlight !== undefined) await inFlight
    await this.refreshContextUsage(sessionId)
  }

  /**
   * What the panel may offer to change on this session, and what it has
   * already been asked to change (issue #96).
   *
   * The two capability flags are read off the HANDLE rather than off a
   * provider name: the port declares what its engine can actually do, so a
   * held session on an engine with no mid-run model change reports
   * `canSetModel: false` without this registry knowing which engine that is.
   * `held: false` for a session this panel does not hold, the same refusal
   * every other lookup here gives.
   */
  tuningState(sessionId: string): HeldTuningState {
    const record = this.recordFor(sessionId)
    if (record === undefined) return { held: false }
    return {
      held: true,
      tuning: {
        canSetModel: record.handle.setModel !== undefined,
        canSetEffort: record.handle.setEffort !== undefined,
        ...(record.requestedModel === undefined ? {} : { pendingModel: record.requestedModel }),
        ...(record.requestedEffort === undefined ? {} : { pendingEffort: record.requestedEffort })
      }
    }
  }

  /**
   * Promote whatever the session has now reported from "asked for" to "in
   * force" (issue #96) — called on every report that could carry either
   * value, which is every context reading and every `init`.
   *
   * Cleared only on an EXACT match. A report naming something else is not a
   * confirmation of anything: it is the session saying it is running what it
   * is running, which leaves the request exactly as pending as it was. That
   * is what keeps the strip honest about an effort the CLI accepted and then
   * did not adopt — the one failure mode #96's spike actually measured.
   */
  private confirmTuning(record: HeldRecord): void {
    if (record.requestedModel !== undefined && record.telemetry.model === record.requestedModel) {
      record.requestedModel = undefined
    }
    if (
      record.requestedEffort !== undefined &&
      record.telemetry.effort === record.requestedEffort
    ) {
      record.requestedEffort = undefined
    }
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
   * Decide one open permission prompt, releasing the agent's blocked tool
   * call (#203).
   *
   * Looks ONLY at `openPermissions`, never `openAsks` — the two maps are kept
   * apart precisely so a permission decision can never release an ask that
   * happens to share its tool-use id, and `answer` above keeps the same
   * discipline in the other direction. A refusal here leaves the call
   * BLOCKED, for the same reason `answer`'s does: the prompt is still open,
   * and the panel can decide it again.
   */
  decidePermission(request: {
    sessionId: string
    toolUseId: string
    decision: DwarfPermissionDecision
  }): DwarfQuestionAnswerResult {
    const record = this.recordFor(request.sessionId)
    if (record === undefined) return { answered: false, error: NOT_HELD }
    const open = record.openPermissions.get(request.toolUseId)
    if (open === undefined) return { answered: false, error: NO_SUCH_PERMISSION }

    record.openPermissions.delete(request.toolUseId)
    open.release(
      request.decision === 'allow'
        ? { decision: 'allow' }
        : { decision: 'deny', reason: DECLINED_PERMISSION }
    )
    this.log(`[held] Decided ${request.toolUseId} (${request.decision}) in ${record.mineId}`)
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
    const sent = record.handle.send(text)
    // A message actually queued onto the stream is a new turn starting
    // (issue #245) — the same fact the launch prompt states at record
    // creation, restated here because a session can go idle between turns and
    // then be spoken to again. Not merged when the stream refused it: a
    // refused send is not a turn beginning.
    if (sent) record.telemetry = { ...record.telemetry, turn: 'started' }
    return sent
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
  async interrupt(sessionId: string): Promise<HeldInterruptVerdict> {
    const record = this.recordFor(sessionId)
    if (record === undefined) return 'not-held'
    // AMENDED for #237, step 5 (was: `Promise<boolean>`). A held session whose
    // protocol documents no cancellation offers no `interrupt` at all, and
    // that is a different answer from one that offered it and refused — see
    // HeldInterruptVerdict, and HeldSessionHandle on why the capability is
    // absent rather than a method returning false.
    const cut = record.handle.interrupt
    if (cut === undefined) return 'unsupported'
    return (await cut.call(record.handle)) ? 'interrupted' : 'refused'
  }

  /**
   * Whether a kick on this held session would reach anything (#237, step 5).
   *
   * The same fact `interrupt` above answers, asked BEFORE the act rather than
   * after it, because the panel has to disable the control the runtime is
   * bound to refuse — one rule, two readers, which is the discipline
   * `kickEndpointOf` states. False for a session this panel does not hold, for
   * the reason every other lookup here answers that way: there is no stream.
   */
  canInterrupt(sessionId: string): boolean {
    return this.recordFor(sessionId)?.handle.interrupt !== undefined
  }

  /**
   * The folder a held session was started in, for a provider whose own store
   * cannot say (#237, step 5).
   *
   * Undefined for a session this panel does not hold — the same refusal every
   * other lookup here gives, and the reading that leaves an observed
   * conversation's own `history.jsonl` record alone. See HeldRecord.minePath
   * for why this exists at all and why it is first-hand rather than a guess.
   */
  heldWorkspace(sessionId: string): string | undefined {
    return this.recordFor(sessionId)?.minePath
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
    // An `init` names the model AND the effort the session will actually use,
    // so it is the second confirmation route for a model change and the ONLY
    // one there is for an effort change (issue #96).
    this.confirmTuning(record)
  }

  /**
   * Keep one message the stream carried (#159). The bound, the redaction and
   * the "nothing was said" case all live in `retainHeldMessage`, so this only
   * decides WHEN a message is seen — which is the one thing the registry knows
   * and the pure helper does not.
   */
  private recordMessage(
    key: number,
    role: FeedMessage['role'],
    text: string,
    activity?: FeedActivity
  ): void {
    const record = this.held.get(key)
    if (record === undefined) return
    record.conversation = retainHeldMessage(record.conversation, this.message(role, text, activity))
  }

  /** One message stamped with this host's own clock — the only honest time there is. */
  private message(role: FeedMessage['role'], text: string, activity?: FeedActivity): FeedMessage {
    return {
      role,
      text,
      timestamp: new Date(this.now()).toISOString(),
      ...(activity === undefined ? {} : { activity })
    }
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

  /**
   * One tool call reaching the permission callback that is not an ask (#203).
   * The returned promise is what keeps the agent's tool call blocked, and it
   * settles exactly once: on a decision, or on the session ending.
   *
   * Unlike `receiveAsk`, there is no shape to validate here — a permission
   * prompt is not parsed out of the model's own output, it is simply
   * whatever tool call the CLI decided to prompt about, so nothing about it
   * can be malformed the way an `AskUserQuestion` block can be. A gone record
   * (the session ended between the callback firing and this running) denies
   * outright rather than hanging on a prompt nobody holds a session for
   * any more.
   */
  private receivePermission(key: number, prompt: HeldPermission): Promise<HeldPermissionAnswer> {
    const record = this.held.get(key)
    if (record === undefined) {
      return Promise.resolve({ decision: 'deny', reason: DISSOLVED })
    }
    const askedAt = new Date(this.now()).toISOString()
    return new Promise<HeldPermissionAnswer>((release) => {
      record.openPermissions.set(prompt.toolUseId, { prompt, askedAt, release })
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
    // A dissolved permission prompt is a DENIAL with a stated reason, never an
    // approval — see the class doc comment's "one thing that must never be
    // papered over".
    for (const [toolUseId, open] of record.openPermissions) {
      record.openPermissions.delete(toolUseId)
      open.release({ decision: 'deny', reason })
    }
  }
}
