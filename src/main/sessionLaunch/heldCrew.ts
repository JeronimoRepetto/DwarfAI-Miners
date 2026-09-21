import { redactSecrets } from '../domain/redactSecrets'
import {
  boundTurnText,
  type Dwarf,
  type DwarfRole,
  type TurnOutcome,
  type TurnOutcomeKind
} from '../domain/types'
import type { TextDeliveryTarget } from '../textDelivery/port'

/**
 * The crew of a session this panel is HOLDING, derived from that session's own
 * message stream (#157).
 *
 * ## Why this exists at all, measured rather than reasoned
 *
 * A held session's subagents were invisible: the maintainer launched an agent,
 * it spawned two of its own, and the mine kept showing one dwarf. The cause is
 * not in this file's absence but in what the observed-session path can see.
 * `parseClaudeTranscriptTail` derives its in-flight agents from a
 * `toolUseResult.status == "async_launched"` record — the ack a BACKGROUNDED
 * launch writes — and a held session's agents run in the FOREGROUND, with the
 * spawning tool call blocking on them. Measured against a real SDK-hosted
 * session on 2026-09-03: three subagents launched, three `subagents/agent-*`
 * transcripts and sidecars written, and in the parent transcript ZERO
 * `async_launched` records, ZERO `<task-notification>` blobs and no
 * `pendingBackgroundAgentCount` line whatsoever. So there is nothing on disk
 * for the poll to read, and — by the invariant this codebase states three times
 * over — the absence of a count is not a count of zero. Nothing was broken;
 * that path was simply never told.
 *
 * The stream carries all of it, live and already labelled. `task_started` gives
 * the task id, its description, the tool call it came from, and `spawn_depth`,
 * which the SDK's own types define as "1 for a top-level spawn, N+1 when
 * spawned from inside a depth-N agent". That is the maintainer's taxonomy in
 * the CLI's own words, so nothing here has to infer a depth.
 *
 * ## Count honesty
 *
 * The stream names WHICH task started and WHICH ended, so this never has to
 * reconcile a headcount against a crew. Two rules carry the same discipline the
 * transcript path holds:
 *
 * - An ending is recorded only from an explicit terminal signal, and it is
 *   permanent: an ended task can never be re-adopted, whatever a later message
 *   says. That is `terminalAgents` (#28) in this stream's own currency, and it
 *   is what stops a resumed or re-announced task mining forever.
 * - Silence is never an ending. A stream that has said nothing for an hour has
 *   said nothing; the crew stands until a terminal signal arrives or the
 *   session itself ends and takes the whole record with it.
 *
 * `background_tasks_changed` is deliberately NOT read, though it would look
 * like the authoritative both-directions headcount this codebase prefers. It
 * enumerates every live BACKGROUND task, and a held session's agents are
 * foreground — so swapping the crew for its payload, as its REPLACE semantics
 * ask, would evict every dwarf it was never speaking for. A count may only ever
 * judge what it can speak for; that is the same boundary `enforcePendingCeiling`
 * holds when it exempts a launch the count line predates.
 */

/**
 * The four ways a task can be over, exactly as `TERMINAL_TASK_STATUSES`
 * (`sdkHeldSession.ts`) names them (#510). `'pending' | 'running' | 'paused'`
 * never reach a `task-ended` signal at all — that Set is what keeps them out
 * before one is ever built.
 */
export type HeldTaskEndStatus = 'completed' | 'failed' | 'killed' | 'stopped'

/**
 * One thing a held session's stream said that bears on its crew.
 *
 * Deliberately raw. The SDK seam translates messages into these and decides
 * nothing; every rule — what counts as an agent, what a depth means, who
 * launched whom — is applied here, where a test can reach it. That seam is the
 * one module in this app with no unit test coming through it, so nothing that
 * can be got wrong is allowed to live there.
 */
export type HeldSessionSubagentSignal =
  | {
      kind: 'task-started'
      taskId: string
      /** The tool call this task came from; the far half of the parent join. */
      toolUseId?: string
      description?: string
      /** 1 for a top-level spawn, N+1 from inside a depth-N agent. */
      spawnDepth?: number
      /** 'local_agent' for a spawned agent; a bash job or MCP call is not one. */
      taskType?: string
      model?: string
      /** Housekeeping the CLI itself asks hosts not to surface. */
      ambient?: boolean
    }
  /**
   * A task has reached one of the four ways a task can be over (#510).
   * `status` is the provider's OWN word for which — carried verbatim from
   * `task_updated`'s patch or `task_notification`, whichever reported it —
   * never reworded into this app's own taxonomy at this layer; see
   * `apply()`'s own mapping onto `TurnOutcomeKind` for where that happens,
   * under test. `subagentSignals()` only ever builds one of these after
   * checking the status it read is already one `TERMINAL_TASK_STATUSES`
   * names, so this signal never arrives with anything else.
   */
  | { kind: 'task-ended'; taskId: string; status: HeldTaskEndStatus }
  /**
   * A tool call made from INSIDE another task's turn. The near half of the
   * parent join: the assistant turn that wrote the call carries the tool-use id
   * of the task it belongs to, and the `task-started` that follows names the
   * call. Neither says who the parent is on its own.
   */
  | { kind: 'tool-call'; toolUseId: string; insideToolUseId: string }
  /**
   * The model an assistant turn made from INSIDE a task reported running on
   * (#447).
   *
   * `task_started` announces a subagent without ever naming its model — id,
   * description, depth, task type and the call it came from are the whole
   * message — so the only place a held subagent's model is stated is the turns
   * the agent itself writes. Those carry the tool-use id of the task they
   * belong to, which is the identity `tool-call` already joins the topology on,
   * so the model rides the same proven join rather than a second one.
   *
   * This exists only for tasks: the root session's own turns carry no parent
   * tool-use id at all, and its model has its own writer (`init`, issue #96).
   */
  | { kind: 'agent-model'; insideToolUseId: string; model: string }
  /**
   * The text a task's own turn just wrote (#510) — read the SAME way
   * `agent-model` already is, and for the same reason: a task's own
   * completion messages carry no result text of their own. `task_updated`'s
   * own patch is documented as excluding `result` outright, and
   * `task_notification`'s `summary` sits among fields shaped for a progress
   * readout rather than documented as the subagent's own final words — so
   * this app reaches for the one place a subagent's own conclusion is
   * unambiguously stated: the text blocks of the turns it actually wrote,
   * the same evidence `heldMessageEntries` already draws a ROOT session's
   * conversation from. Overwritten rather than accumulated — `HeldCrew`
   * keeps only the LAST one — so a task that ends without ever writing text
   * of its own simply has nothing to seal.
   */
  | { kind: 'task-text'; insideToolUseId: string; text: string }

/** One live subagent of a held session. */
export interface HeldCrewMember {
  taskId: string
  /** What the panel calls it: its description, or a name built from its id. */
  name: string
  /** The description as given, absent when the stream carried none. */
  description?: string
  spawnDepth?: number
  model?: string
  /** The task that launched it, when the stream established one. */
  parentTaskId?: string
}

/** The task type a spawned agent is announced under; everything else is a tool. */
const SPAWNED_AGENT_TASK_TYPE = 'local_agent'

/**
 * How many ended tasks' conclusions one crew keeps at once (#510).
 *
 * Unlike every other per-session map here, this one never shrinks back down
 * once a task leaves `live` — that is the whole point of it surviving the
 * departure at all (see `HeldCrew`'s own comment on `endedConclusions`) — so
 * a session that spawns hundreds of short-lived subagents over a long run
 * must not be allowed to grow it forever. Sized generously against an
 * ordinary session's crew (#157's own measured session launched three) while
 * still bounding a pathological one.
 */
export const MAX_ENDED_CONCLUSIONS = 50

/**
 * Which rank a spawned agent's depth makes it (#157).
 *
 * Depth 1 is a direct subagent of the root and is a `worker`. Everything deeper
 * is a `worker2`, at every level: the tree keeps going and the rank does not,
 * because a rank per level would be a drawing nobody could read.
 *
 * A depth this app was never told — an older CLI, or a task announced without
 * one — reads as `worker`. `worker2` is the stronger claim, since it asserts
 * the thing was spawned BY a worker, and the claim needs the proof. It is the
 * direction every unproven reading falls in here.
 */
export function rankForSpawnDepth(spawnDepth: number | undefined): DwarfRole {
  return spawnDepth !== undefined && Number.isFinite(spawnDepth) && spawnDepth >= 2
    ? 'worker2'
    : 'worker'
}

/**
 * Every subagent one held session has out right now, and whether it has ever
 * coordinated at all.
 *
 * Mutable and per-session, like the registry's own open-ask map: it is fed by a
 * stream and read by a poll, and a record dies with the session that owns it.
 */
export class HeldCrew {
  /** Live members, in launch order — Map.set keeps a re-set key in place. */
  private readonly live = new Map<string, HeldCrewMember>()
  /**
   * Every task id ever seen ending. Remembered for the life of the session
   * rather than consumed, because the ending can arrive twice and can arrive
   * BEFORE a start this panel had not heard yet — and because an ended agent
   * that could be re-adopted is the ghost dwarf (#28), one stream removed.
   */
  private readonly ended = new Set<string>()
  /** tool-use id -> the task started from it; the far half of the parent join. */
  private readonly taskByCall = new Map<string, string>()
  /** tool-use id -> the tool-use id of the task whose turn made that call. */
  private readonly callOwner = new Map<string, string>()
  /**
   * tool-use id -> the model the task started from it last reported. Kept for
   * the life of the session rather than consumed, because the turn that proves
   * a model can reach this panel before the `task_started` it belongs to — the
   * same ordering the parent join already has to survive — and because the
   * newest turn supersedes the one before it.
   */
  private readonly modelByCall = new Map<string, string>()
  /**
   * tool-use id -> the last text that call's own turns have written (#510).
   * Overwritten rather than appended to, like `modelByCall` — see the
   * `task-text` signal's own comment — and dropped the moment the task it
   * belongs to ends, whether or not anything was ever sealed from it:
   * nothing here needs to outlive the ending it exists to seal onto a
   * member.
   */
  private readonly textByCall = new Map<string, string>()
  /**
   * What a task's own ending concluded, once this crew has sealed it (#510)
   * — keyed by taskId and kept APART from `live`/`members()` on purpose. A
   * subagent leaves the board the instant its task ends, exactly as it
   * always has: a concluded dwarf that lingered there instead, still
   * reading `status: 'working'` forever, would be the false presence
   * AGENTS.md's crew invariants exist to prevent, and it would change
   * `heldCrewDwarfs()`'s own output — out of this issue's scope. This map is
   * where the conclusion survives that departure for whoever reads it
   * afterwards (#511); nothing on the wire reads it in T2.
   *
   * Bounded by MAX_ENDED_CONCLUSIONS, unlike the rest of this crew's
   * per-session state — see that constant's own comment for why.
   */
  private readonly endedConclusions = new Map<string, TurnOutcome>()
  /** Whether a subagent has ever been live. Latches; see heldRootRole. */
  private coordinated = false

  /**
   * `now` is injected, never `Date.now()` read directly, so a conclusion's
   * `endedAt` can be pinned in a test the same way every other clock in this
   * codebase is (#510). Defaulted rather than required: every existing
   * caller of `new HeldCrew()` — this file's own tests among them — predates
   * a conclusion ever needing a timestamp at all.
   */
  constructor(private readonly now: () => number = Date.now) {}

  apply(signal: HeldSessionSubagentSignal): void {
    if (signal.kind === 'tool-call') {
      this.callOwner.set(signal.toolUseId, signal.insideToolUseId)
      return
    }
    if (signal.kind === 'agent-model') {
      this.modelByCall.set(signal.insideToolUseId, signal.model)
      const taskId = this.taskByCall.get(signal.insideToolUseId)
      if (taskId === undefined) return
      const member = this.live.get(taskId)
      // A call this crew cannot resolve to a live member touches nobody.
      // Stamping the nearest one would be inheritance arrived at sideways, and
      // a model is the one field on a subagent that must be its own or absent.
      if (member === undefined) return
      this.live.set(taskId, { ...member, model: signal.model })
      return
    }
    if (signal.kind === 'task-text') {
      this.textByCall.set(signal.insideToolUseId, signal.text)
      return
    }
    if (signal.kind === 'task-ended') {
      // A repeat report of the SAME ending changes nothing (#510):
      // task_updated and task_notification both report one ending, and
      // re-sealing on the second would re-run the text lookup below and find
      // nothing left — textByCall was already drained by the first — quietly
      // overwriting a real conclusion with a textless one. `ended` already
      // has to be permanent for the membership rule below it; this reuses
      // the exact same fact to make sealing idempotent too.
      if (this.ended.has(signal.taskId)) return
      this.ended.add(signal.taskId)
      // Leaves `live` (and therefore `members()`/`heldCrewDwarfs()`)
      // unconditionally, whether or not anything is sealed below — a
      // subagent's departure is not this crew's to delay for the sake of a
      // wire field #511 will read a different way.
      this.live.delete(signal.taskId)
      const callId = this.callFor(signal.taskId)
      const rawText = callId === undefined ? undefined : this.textByCall.get(callId)
      if (callId !== undefined) this.textByCall.delete(callId)
      const bound = rawText === undefined ? undefined : boundTurnText(rawText)
      // The provider's own word for the ending IS the fact, whether or not
      // this task ever wrote text of its own — `completed` still seals a
      // conclusion with no text field when none was ever attributed to it
      // (absence of text is not a fact, but the ending always is), and
      // `failed`/`killed`/`stopped` seal one exactly as honestly.
      const kind: TurnOutcomeKind =
        signal.status === 'completed'
          ? 'concluded'
          : signal.status === 'failed'
            ? 'errored'
            : 'interrupted'
      this.sealConclusion(signal.taskId, {
        kind,
        ...(bound === undefined
          ? {}
          : { text: bound.text, ...(bound.truncated ? { truncated: true } : {}) }),
        detail: signal.status,
        endedAt: this.now()
      })
      return
    }
    if (!isSpawnedAgent(signal)) return
    // Ended memory outranks launch memory, everywhere and permanently.
    if (this.ended.has(signal.taskId)) return
    if (signal.toolUseId !== undefined) this.taskByCall.set(signal.toolUseId, signal.taskId)
    this.coordinated = true
    // Whatever the announcement itself said, or — since it never says one — the
    // model this task's own turns have already reported. Both are the agent's
    // own evidence; nothing here falls back to the session or the agent above.
    const model = signal.model ?? this.modelOf(signal.toolUseId)
    this.live.set(signal.taskId, {
      taskId: signal.taskId,
      name: signal.description ?? `agent-${signal.taskId.slice(0, 7)}`,
      ...(signal.description === undefined ? {} : { description: signal.description }),
      ...(signal.spawnDepth === undefined ? {} : { spawnDepth: signal.spawnDepth }),
      ...(model === undefined ? {} : { model }),
      ...this.parentField(signal.toolUseId)
    })
  }

  /** Everyone out right now, oldest launch first. */
  members(): HeldCrewMember[] {
    return [...this.live.values()]
  }

  /**
   * Has this session ever actually coordinated? A different question from
   * "has it anyone out now", and the one the rank turns on — see heldRootRole.
   */
  hasCoordinated(): boolean {
    return this.coordinated
  }

  /**
   * Who launched this one, as a spreadable field. Absent when the stream
   * established nothing — "I was spawned" and "here is who by" are different
   * facts, and the first survives the second going missing.
   */
  /** The model already reported for the task started from this call, if any. */
  private modelOf(toolUseId: string | undefined): string | undefined {
    return toolUseId === undefined ? undefined : this.modelByCall.get(toolUseId)
  }

  private parentField(toolUseId: string | undefined): { parentTaskId?: string } {
    if (toolUseId === undefined) return {}
    const ownerCall = this.callOwner.get(toolUseId)
    if (ownerCall === undefined) return {}
    const parentTaskId = this.taskByCall.get(ownerCall)
    return parentTaskId === undefined ? {} : { parentTaskId }
  }

  /**
   * The call (tool-use id) a task was itself started from, given only its id
   * (#510) — the reverse of `taskByCall`. A `task-ended` signal names only
   * the task, never the call, so this is how sealing a conclusion finds the
   * text that task's own turns wrote. A linear scan, deliberately: a live
   * session's own crew never holds more than a handful of members at once.
   */
  private callFor(taskId: string): string | undefined {
    for (const [callId, ownTaskId] of this.taskByCall) {
      if (ownTaskId === taskId) return callId
    }
    return undefined
  }

  /**
   * Record one task's sealed conclusion, evicting the OLDEST one once the
   * cap is reached (#510). `Map` iteration order is insertion order, so
   * `.keys().next()` names it directly — the newest conclusions are the
   * ones still actionable, not a full history of a long session's whole
   * life. `taskId` is a fresh key every time (the `ended.has` guard in
   * `apply()` stops a repeat from reaching here at all), so this always
   * inserts rather than moving an existing entry.
   */
  private sealConclusion(taskId: string, outcome: TurnOutcome): void {
    this.endedConclusions.set(taskId, outcome)
    if (this.endedConclusions.size <= MAX_ENDED_CONCLUSIONS) return
    const oldest = this.endedConclusions.keys().next().value
    if (oldest !== undefined) this.endedConclusions.delete(oldest)
  }

  /**
   * What a task's own ending concluded (#510), once sealed — undefined for a
   * task still live, one this crew never heard of, or one whose conclusion
   * the cap above has since evicted. The read surface #511 is built on;
   * nothing on the wire reads this in T2.
   */
  conclusionOf(taskId: string): TurnOutcome | undefined {
    return this.endedConclusions.get(taskId)
  }

  /** Every conclusion this crew still holds, oldest ended first (#510). */
  conclusions(): ReadonlyMap<string, TurnOutcome> {
    return this.endedConclusions
  }
}

/**
 * Is this task a spawned agent, or one of the other things that arrive on the
 * same channel?
 *
 * `local_agent` is the answer when the CLI gave a type. When it did not, a
 * `spawn_depth` is proof in its own right: the SDK documents it as set on a
 * spawned agent and "not set on other tasks", so a task carrying one has said
 * what it is even if it did not say so by name. A task that proves neither is
 * refused rather than guessed into the crew — a dwarf drawn for a shell command
 * is the panel inventing labour nobody asked for.
 *
 * `ambient` is excluded on the CLI's own instruction: it marks the housekeeping
 * tasks it "does not surface as user work", live-update watchers among them.
 */
function isSpawnedAgent(
  signal: Extract<HeldSessionSubagentSignal, { kind: 'task-started' }>
): boolean {
  if (signal.ambient === true) return false
  if (signal.taskType !== undefined) return signal.taskType === SPAWNED_AGENT_TASK_TYPE
  return signal.spawnDepth !== undefined
}

/**
 * What rank the held session's own dwarf is drawn at (#157).
 *
 * A launched session digs alone until it actually coordinates something; the
 * moment it has a subagent out it is the foreman. That much is the maintainer's
 * ruling, and it is derived from reality on every poll rather than stamped at
 * launch — nothing here scripts a rank.
 *
 * What happens when the last subagent finishes is answered by the OBSERVED
 * sessions' rule, so that both paths say the same thing about the same session:
 * claudeProvider makes a session "the foreman whether or not it currently has
 * agents out", because deriving the rank from the headcount made the same dwarf
 * swap identity mid-session. So the promotion LATCHES. Having coordinated is a
 * fact about this session, and the crew finishing does not undo it — the same
 * reading that keeps an observed root a foreman between two batches of agents.
 */
export function heldRootRole(crew: HeldCrew): DwarfRole {
  return crew.hasCoordinated() ? 'foreman' : 'worker'
}

/** The dwarf id one crew member is drawn under, named after the session's own. */
function crewDwarfId(root: Dwarf, taskId: string): string {
  return `${root.id}:${taskId}`
}

/**
 * The held session's crew as dwarfs, ready to join the snapshot beside the
 * session's own.
 *
 * Every string the model wrote passes `redactSecrets` HERE, at the boundary,
 * before any renderer can truncate it — a truncated prefix can still contain a
 * whole key (#59), and a description reaches the panel twice, as this dwarf's
 * name and as its tooltip.
 *
 * No `silentForMs`. This is a stream, not a per-agent transcript, so there is
 * no mtime to publish; the absent field means "nothing is known about this
 * agent's output", where a 0 would claim it had just spoken.
 */
export function heldCrewDwarfs(root: Dwarf, crew: HeldCrew): Dwarf[] {
  return crew.members().map((member) => {
    const description = redactSecrets(member.description)
    return {
      id: crewDwarfId(root, member.taskId),
      provider: root.provider,
      role: rankForSpawnDepth(member.spawnDepth),
      // Its own fact, never inherited from the session above: nothing outside
      // this subagent's parent session can address it at all, so no human is
      // typing into it whatever kind of session launched it (#68).
      attendance: 'unattended',
      name: redactSecrets(member.name),
      ...(member.model === undefined ? {} : { model: member.model }),
      // Deliberately conservative, the same reading claudeProvider takes for a
      // transcript-derived worker: this stream carries no per-subagent blocked
      // signal, so an agent that is out is never guessed into waiting.
      status: 'working',
      ...(description === undefined ? {} : { description }),
      // The parent edge, carried onto the wire so a worker2's prompt can be
      // attributed to the agent that actually wrote it (#189). `parentTaskId`
      // is a task id and means nothing to the board, so it is published as the
      // dwarf id that task is drawn under — the same id crewDwarfId gives the
      // parent itself, which is what makes the two ends meet.
      //
      // Absent stays absent. A depth-1 member has no parent task and needs
      // none: messageIssuer derives its session's root from its own fields.
      // A deeper one whose parent the stream never named keeps no issuer at
      // all, because naming the session there would be a guess.
      ...(member.parentTaskId === undefined
        ? {}
        : { parentId: crewDwarfId(root, member.parentTaskId) }),
      sessionId: root.sessionId,
      ...(root.pid === undefined ? {} : { pid: root.pid })
    } satisfies Dwarf
  })
}

/**
 * How each crew member can be handed a typed message.
 *
 * A running subagent has no channel of its own — nothing outside its parent
 * session can address it — so every one of them relays. WHERE it relays is the
 * one thing #157 had to decide: a `worker2`'s parent is another worker, which
 * is exactly what `MAX_FOREMAN_HOPS` was built to allow and what nothing had
 * yet produced.
 *
 * It relays to its PARENT, and the parent relays on to the session, so
 * `followForemanHops` accumulates `[for agent A] [for agent B] `. Both routes
 * put the text in the same place — the session's own queue, since the
 * intermediate worker has no queue to put anything in — so the choice is purely
 * about what the session is told, and a session that never launched the
 * worker2 has no idea who it is. Naming the whole path is the only phrasing it
 * can act on.
 *
 * A parent that is not on the board — one that finished first, or one no signal
 * ever named — relays straight to the session instead. That is the honest
 * degradation: the session is the only addressable node in the tree either way,
 * and a hop to a dwarf that is not there would resolve to no channel at all and
 * lose the send entirely.
 */
export function heldCrewTargets(root: Dwarf, crew: HeldCrew): Map<string, TextDeliveryTarget> {
  const members = crew.members()
  const live = new Set(members.map((member) => member.taskId))
  const targets = new Map<string, TextDeliveryTarget>()
  for (const member of members) {
    const relayThroughParent = member.parentTaskId !== undefined && live.has(member.parentTaskId)
    targets.set(crewDwarfId(root, member.taskId), {
      kind: 'foreman-relay',
      foremanDwarfId: relayThroughParent ? crewDwarfId(root, member.parentTaskId!) : root.id,
      // The SAME redacted string the dwarf is named with, deliberately: this
      // becomes the '[for agent <name>] ' prefix a human reads back, and a
      // routing key the panel cannot show is a route nobody can ask for.
      workerName: redactSecrets(member.name)
    })
  }
  return targets
}
