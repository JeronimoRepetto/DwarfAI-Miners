import { join } from 'node:path'
import type { FsLike } from '../../adapters/fsLike'
import { filetimeToEpochMs } from '../../adapters/processProbe'
import { redactSecrets } from '../../domain/redactSecrets'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import type { TextDeliveryTarget } from '../../textDelivery/port'
import type { Provider } from '../provider'
import {
  claudeSessionDeliveryTarget,
  encodeClaudeProjectDir,
  extractClaudeFeed,
  parseClaudeSessionEntry,
  parseClaudeTranscriptTail,
  type ClaudeInFlightAgent,
  type ClaudeSessionEntry,
  type ClaudeTranscriptInfo
} from './parse'

/** Read at most this many bytes from the end of a transcript per scan. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
const SUBAGENT_TAIL_BYTES = 64 * 1024
/**
 * How far back the ONE deeper read on first sight of a session reaches
 * (see rememberedLaunches). Poll-to-poll memory can only remember what some
 * poll actually saw, so an app started mid-turn — after a launch record
 * already scrolled past TRANSCRIPT_TAIL_BYTES — would never learn about the
 * agent at all. 16x the regular bound covers even an extreme write burst for
 * the cost of one bounded read per session per app run. Known limit: a launch
 * further back than even this window stays invisible until the agent's next
 * observable event (its terminal notification arriving in a later tail).
 */
const FIRST_SIGHT_TAIL_BYTES = 4 * 1024 * 1024
/**
 * How far back the ONE escalated read reaches when a session's own pending
 * count proves launches are missing (see unexplainedShortfalls, issue #36).
 *
 * Deliberately larger than FIRST_SIGHT_TAIL_BYTES, because the case this
 * exists for is exactly the one both cheaper reads already lost: a transcript
 * that outgrew the first-sight window — the reported occurrence reached 4MB in
 * a single night — where every launch older than that boundary is otherwise
 * unrecoverable for the life of the session. Cost is bounded by the shortfall
 * key, not by this number: one read per distinct unexplained count per
 * session, never one per 2s poll.
 */
const RECOVERY_TAIL_BYTES = 16 * 1024 * 1024

/**
 * How far a probed process creation time may sit from the registry's procStart
 * before the pid is declared recycled. The POSIX probes answer in whole
 * seconds (ps lstart) or 10ms ticks (/proc starttime), and the FILETIME
 * conversion truncates — 2s absorbs every unit-rounding artifact while still
 * being orders of magnitude tighter than any real pid-recycling interval.
 */
const PROC_START_TOLERANCE_MS = 2_000

/** What one (pid, procStart) probe concluded; 'unknown' means the guard stands aside. */
type ProcStartVerdict = 'match' | 'mismatch' | 'unknown'

export interface ClaudeProviderOptions {
  fs: FsLike
  /**
   * Claude config roots to scan (e.g. ~/.claude and ~/.claude-work —
   * multiple accounts keep separate sessions/ dirs). Missing roots are skipped.
   */
  roots: string[]
  /** Injected for tests; defaults to a real process.kill(pid, 0) probe. */
  isPidAlive?: (pid: number) => boolean
  /**
   * When the process that owns a pid was created, as epoch ms, from the
   * platform ProcessProbePort. Omitted (or answering null) the pid-reuse guard
   * stands aside and liveness stays exactly what isPidAlive says — the guard
   * may only ever remove sessions kill(pid, 0) would wrongly keep.
   */
  processStartTimeMs?: (pid: number) => Promise<number | null>
  now?: () => number
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Detects live Claude Code sessions via the ~/.claude/sessions/<pid>.json
 * registry, then reads each session's transcript tail for model, effort,
 * in-flight subagents and the latest assistant text.
 */
export class ClaudeProvider implements Provider {
  readonly kind = 'claude' as const

  private readonly fs: FsLike
  private readonly roots: string[]
  private readonly isPidAlive: (pid: number) => boolean
  private readonly processStartTimeMs?: (pid: number) => Promise<number | null>
  private readonly now: () => number
  /**
   * "pid|procStart" -> what probing that exact pair concluded.
   *
   * The poller runs every 2s and the probe spawns a process, so a probe per
   * session per tick is not affordable: each pair is probed once and the
   * verdict trusted for as long as kill(pid, 0) keeps succeeding. 'unknown'
   * (an errored probe) is cached too — retrying a broken process list every
   * 2s would be the per-tick spawn again, and fail-open is the required
   * reading either way. Entries for a pid are evicted the moment kill fails
   * (see scan), because after a death the same pair can name a NEW process:
   * a stale 'match' would resurrect the dead session on the recycled pid —
   * the exact bug this guard exists to prevent.
   */
  private readonly procStartVerdicts = new Map<string, ProcStartVerdict>()
  /**
   * dwarfId -> transcript path, used by feed()/transcriptPath().
   *
   * Rebuilt on every scan into a SEPARATE map that replaces this reference in
   * one assignment at the end (issue #12). Clearing and repopulating the live
   * map across awaits let a click landing mid-scan read a half-rebuilt map and
   * resolve to another dwarf's transcript.
   */
  private feedSources: ReadonlyMap<string, string> = new Map()
  /**
   * dwarfId -> how that dwarf can be handed a typed message, used by
   * textDelivery(). Rebuilt and swapped in atomically alongside feedSources,
   * for the same reason: a click landing mid-scan must never read a
   * half-rebuilt map and resolve to another session's console or name.
   */
  private deliveryTargets: ReadonlyMap<string, TextDeliveryTarget> = new Map()
  /**
   * Every agent id ever seen reaching a terminal status, remembered for the
   * life of the process.
   *
   * A completion notification can scroll out of the transcript tail while the
   * `async_launched` record that started the agent is still inside it, and then
   * a finished agent looks in flight again forever — the ghost dwarf. Agent ids
   * are globally unique, so one flat set is enough, and it only grows by one
   * short string per agent actually launched on this machine.
   */
  private readonly terminalAgents = new Set<string>()
  /**
   * sessionId -> (agentId -> launch info captured while the `async_launched`
   * record was still inside a tail read), the exact mirror of terminalAgents
   * (issue #28).
   *
   * A single long turn can write more than TRANSCRIPT_TAIL_BYTES of tool
   * output, pushing the launch record out of the window while the agent is
   * still working — deriving in-flight agents from the tail alone made the
   * worker dwarf silently leave mid-run. A launch stays remembered until a
   * terminal notification for its agent id is seen (terminalAgents always
   * wins), a turn ends with zero background agents pending while the launch
   * is older than the whole tail (see snapshotSession), or the session itself
   * leaves the registry (evicted in scan). Keyed per session — unlike the
   * deliberately tiny flat terminal id set — so ended sessions cannot leak
   * launch records for the life of the process.
   */
  private readonly rememberedLaunches = new Map<string, Map<string, ClaudeInFlightAgent>>()
  /**
   * sessionId -> the pendingBackgroundAgentCount whose shortfall one escalated
   * read already failed to explain (issue #36).
   *
   * This is the rate limit on RECOVERY_TAIL_BYTES, and it is keyed on the
   * REPORTED COUNT rather than on a per-session "already escalated" flag on
   * purpose. A flag would spend a session's single recovery on its first
   * discrepancy and stay blind to every later one for the life of the process;
   * no key at all would put a 16MB read on a 2s poll for as long as the
   * discrepancy lasts. Keyed on the count: an identical unexplained count
   * settles after one attempt, a count that climbs is fresh evidence of an
   * agent this provider has never heard of and escalates again, and the entry
   * is dropped the moment a poll sees no shortfall — so a later discrepancy
   * that happens to report the same number is judged new, not dismissed as the
   * settled one. Evicted with the session in scan(), like rememberedLaunches.
   */
  private readonly unexplainedShortfalls = new Map<string, number>()
  /**
   * dwarfId -> highest tokensObserved reading seen for it so far, remembered
   * for the life of the process.
   *
   * Each poll only reads a bounded transcript tail, so this is not a sum
   * across turns (see usageTokens in parse.ts) — it is the latest usage block
   * a tail happened to contain, taken as a floor. Tracking the running max
   * turns that floor into a monotonic runtime-lifetime counter per dwarf: it
   * only ever grows, even if a context reset or a scrolled-tail poll reads a
   * smaller number than a previous poll already saw.
   */
  private readonly tokenTotals = new Map<string, number>()

  constructor(options: ClaudeProviderOptions) {
    this.fs = options.fs
    this.roots = options.roots
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive
    if (options.processStartTimeMs !== undefined) {
      this.processStartTimeMs = options.processStartTimeMs
    }
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    // Built off to the side; swapped in atomically once the scan completes so
    // concurrent feed()/transcriptPath() calls always see a whole generation.
    const feedSources = new Map<string, string>()
    const deliveryTargets = new Map<string, TextDeliveryTarget>()
    const snapshots: ProviderSnapshot[] = []
    const seenSessions = new Set<string>()

    for (const root of this.roots) {
      const sessionsDir = join(root, 'sessions')
      if (!(await this.fs.exists(sessionsDir))) continue
      for (const entry of await this.fs.listDir(sessionsDir)) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue
        const session = await this.readSessionEntry(join(sessionsDir, entry.name))
        if (session === null) continue
        if (seenSessions.has(session.sessionId)) continue
        if (!this.isPidAlive(session.pid)) {
          this.evictProcStartVerdicts(session.pid)
          continue
        }
        // kill(pid, 0) proves SOME process owns the pid, not that it is the
        // one this registry entry was written about. A stale entry over a
        // recycled pid would render as a live dwarf whose focus/Send/Kick
        // land in an unrelated application, so a procStart mismatch is a
        // dead session exactly as if the kill probe had failed.
        if ((await this.procStartVerdict(session)) === 'mismatch') continue
        seenSessions.add(session.sessionId)
        snapshots.push(await this.snapshotSession(root, session, feedSources, deliveryTargets))
      }
    }
    // A session that left the registry takes its launch memory with it: the
    // agents died with their parent process, and a future session that happens
    // to reuse the id must start from what its transcript says, never from
    // stale memory. Only on success, like the swap below — a throwing scan
    // must not evict sessions it never got to look at.
    for (const sessionId of [...this.rememberedLaunches.keys()]) {
      if (!seenSessions.has(sessionId)) this.rememberedLaunches.delete(sessionId)
    }
    // Same reasoning for the shortfall rate limit: a returning session id must
    // be free to escalate again rather than inherit a settled verdict about a
    // transcript that is no longer the one it was measured against.
    for (const sessionId of [...this.unexplainedShortfalls.keys()]) {
      if (!seenSessions.has(sessionId)) this.unexplainedShortfalls.delete(sessionId)
    }
    // Only reached on success: a throwing scan leaves the previous generation
    // in place rather than stripping it.
    this.feedSources = feedSources
    this.deliveryTargets = deliveryTargets
    return snapshots
  }

  /** How this dwarf can be handed a typed message; null when there is no way in. */
  textDelivery(dwarfId: string): TextDeliveryTarget | null {
    return this.deliveryTargets.get(dwarfId) ?? null
  }

  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    const path = this.feedSources.get(dwarfId)
    if (path === undefined) return null
    if (!(await this.fs.exists(path))) return []
    // Redacted here — user text included, since pasting a key into one's own
    // session is exactly how secrets enter transcripts — so preload/renderer
    // never hold the raw string (see domain/redactSecrets).
    return extractClaudeFeed(await this.fs.readTextTail(path, TRANSCRIPT_TAIL_BYTES), limit).map(
      (message) => ({ ...message, text: redactSecrets(message.text) })
    )
  }

  /** Path backing feed(), used to open a terminal that tails the transcript live. */
  transcriptPath(dwarfId: string): string | undefined {
    return this.feedSources.get(dwarfId)
  }

  private async readSessionEntry(path: string): Promise<ClaudeSessionEntry | null> {
    try {
      return parseClaudeSessionEntry(await this.fs.readJson(path))
    } catch {
      return null
    }
  }

  /**
   * Does the process that owns this entry's pid look like the one the entry
   * was written about? 'unknown' whenever any prerequisite is missing (no
   * procStart recorded, no probe wired, unparseable value, probe errored or
   * answered null) — the guard must only ever act on positive evidence of a
   * recycled pid, never degrade liveness below today's kill(pid, 0) behavior.
   */
  private async procStartVerdict(session: ClaudeSessionEntry): Promise<ProcStartVerdict> {
    if (session.procStart === undefined || this.processStartTimeMs === undefined) return 'unknown'
    const registryStartMs = filetimeToEpochMs(session.procStart)
    if (registryStartMs === null) return 'unknown'

    const key = `${session.pid}|${session.procStart}`
    const cached = this.procStartVerdicts.get(key)
    if (cached !== undefined) return cached

    let probedStartMs: number | null
    try {
      probedStartMs = await this.processStartTimeMs(session.pid)
    } catch {
      probedStartMs = null
    }
    const verdict: ProcStartVerdict =
      probedStartMs === null
        ? 'unknown'
        : Math.abs(probedStartMs - registryStartMs) <= PROC_START_TOLERANCE_MS
          ? 'match'
          : 'mismatch'
    this.procStartVerdicts.set(key, verdict)
    return verdict
  }

  /** Forget every verdict for `pid`: after a death the same pair can name a new process. */
  private evictProcStartVerdicts(pid: number): void {
    const prefix = `${pid}|`
    for (const key of [...this.procStartVerdicts.keys()]) {
      if (key.startsWith(prefix)) this.procStartVerdicts.delete(key)
    }
  }

  private async snapshotSession(
    root: string,
    session: ClaudeSessionEntry,
    feedSources: Map<string, string>,
    deliveryTargets: Map<string, TextDeliveryTarget>
  ): Promise<ProviderSnapshot> {
    const projectDir = join(root, 'projects', encodeClaudeProjectDir(session.cwd))
    const transcriptPath = join(projectDir, `${session.sessionId}.jsonl`)
    const transcriptStat = await this.fs.stat(transcriptPath)
    // First sight of a session (fresh app start, or a session that just
    // appeared): one deeper read, so a launch that scrolled past the regular
    // window BEFORE this process could ever remember it is still recovered.
    // Whatever it finds lives on in rememberedLaunches, so every later poll
    // goes back to the cheap bound.
    const firstSight = !this.rememberedLaunches.has(session.sessionId)
    const tailBytes = firstSight ? FIRST_SIGHT_TAIL_BYTES : TRANSCRIPT_TAIL_BYTES
    const info =
      transcriptStat === null
        ? parseClaudeTranscriptTail('')
        : parseClaudeTranscriptTail(await this.fs.readTextTail(transcriptPath, tailBytes))

    for (const agentId of info.terminalAgentIds) this.terminalAgents.add(agentId)
    // Merge this tail's launches into the session's launch memory, then let
    // the two evictions prune it. Map.set keeps first-seen insertion order, so
    // the dwarf list stays stable across polls instead of reshuffling with
    // whatever the current window happens to contain.
    const remembered =
      this.rememberedLaunches.get(session.sessionId) ?? new Map<string, ClaudeInFlightAgent>()
    this.rememberedLaunches.set(session.sessionId, remembered)
    for (const agent of info.inFlightAgents) remembered.set(agent.agentId, agent)
    // Terminal memory always wins: a remembered launch whose termination was
    // also remembered stays gone, even when neither record is in the tail.
    this.forgetTerminal(remembered)
    // Cross-check against the transcript's own bookkeeping: turn_duration
    // lines carry the count of background agents still running at end of
    // turn. Zero pending proves every launch OLDER than this whole tail has
    // finished — its notification just scrolled out unseen (a sleep/wake gap)
    // — so those remembered launches are evicted here instead of mining
    // forever. Launches still inside the tail are exempt: they may postdate
    // the turn the count was written for, and contradictory evidence must
    // resolve toward keeping (a false departure is the bug this memory fixes).
    if (info.pendingBackgroundAgentCount === 0) {
      const launchedInTail = new Set(info.inFlightAgents.map((agent) => agent.agentId))
      for (const agentId of [...remembered.keys()]) {
        if (!launchedInTail.has(agentId)) remembered.delete(agentId)
      }
    }
    // The same count read the other way (issue #36). Zero pending proves
    // launches ENDED; a count HIGHER than everything known proves launches
    // were MISSED — their `async_launched` records were never in any window
    // this run read, so no amount of poll-to-poll memory can hold them.
    await this.recoverMissingLaunches({
      sessionId: session.sessionId,
      transcriptPath,
      transcriptBytes: transcriptStat?.size ?? 0,
      alreadyReadBytes: tailBytes,
      reportedPending: info.pendingBackgroundAgentCount,
      remembered
    })
    const inFlightAgents = [...remembered.values()]

    const mainDwarfId = `claude:${session.sessionId}`
    feedSources.set(mainDwarfId, transcriptPath)
    const sessionTarget = claudeSessionDeliveryTarget(session)
    if (sessionTarget !== null) deliveryTargets.set(mainDwarfId, sessionTarget)
    // Tracked unconditionally, even when the foreman isn't listed below (idle,
    // no agents out), so an idle-then-busy session never loses its total.
    const mainTokens = this.trackTokens(mainDwarfId, info.tokensObserved)

    const dwarfs: Dwarf[] = []
    // The foreman is on scene while its session is busy, has agents out, or is
    // provably blocked — registry status 'waiting', written when the session is
    // alive but stopped on user input, an open dialog, or a long tool, with
    // waitingFor naming the condition (issue #34). Only a truly idle session
    // with no agents lists no dwarfs, so leaving behavior is unchanged.
    if (inFlightAgents.length > 0 || session.status !== 'idle') {
      dwarfs.push({
        id: mainDwarfId,
        provider: 'claude',
        // The main session is the orchestrator: it is the foreman whether or
        // not it currently has agents out. Deriving the role from the headcount
        // instead made the same dwarf swap identity mid-session.
        role: 'foreman',
        name: session.name ?? session.sessionId.slice(0, 8),
        model: info.model,
        effort: info.effort,
        // 'busy' is the only registry state that proves active work; both
        // 'waiting' (blocked mid-flow) and idle-with-agents-out render a
        // resting foreman. The registry is re-read every poll, so transitions
        // are prompt in both directions (issue #34).
        status: session.status === 'busy' ? 'working' : 'waiting',
        // Redacted BEFORE the renderer's 70-char bubble truncation can ever
        // slice it: a truncated prefix can still contain a whole key.
        lastMessage: redactSecrets(info.lastAssistantText),
        sessionId: session.sessionId,
        pid: session.pid,
        startedAt: session.startedAt,
        ...(mainTokens !== undefined ? { tokensObserved: mainTokens } : {})
      })
    }
    for (const agent of inFlightAgents) {
      const workerId = `${mainDwarfId}:${agent.agentId}`
      const subagentPath = join(
        projectDir,
        session.sessionId,
        'subagents',
        `agent-${agent.agentId}.jsonl`
      )
      feedSources.set(workerId, subagentPath)
      const workerName = agent.description ?? `agent-${agent.agentId.slice(0, 7)}`
      // A running subagent has no channel of its own: nothing outside its
      // parent session can address it. Its foreman reads the message and
      // routes it, which is exactly how a real crew works.
      deliveryTargets.set(workerId, {
        kind: 'foreman-relay',
        foremanDwarfId: mainDwarfId,
        workerName
      })
      // Attributed to the worker when its own subagent tail cheaply carries
      // usage (the common case); when it doesn't, trackTokens simply returns
      // whatever total was already known for this worker id instead of
      // fabricating one, so nothing is double-counted against the foreman.
      const workerInfo = await this.subagentTranscriptInfo(subagentPath)
      const workerTokens = this.trackTokens(workerId, workerInfo.tokensObserved)
      dwarfs.push({
        id: workerId,
        provider: 'claude',
        role: 'worker',
        name: workerName,
        model: agent.resolvedModel,
        effort: info.effort,
        // Deliberately conservative (issue #34): transcript tails carry no
        // structured per-subagent blocked signal — the registry status above
        // describes only the main session — so an in-flight worker is never
        // guessed into waiting. It works until its terminal notification.
        status: 'working',
        description: agent.description,
        lastMessage: redactSecrets(workerInfo.lastAssistantText),
        sessionId: session.sessionId,
        pid: session.pid,
        ...(workerTokens !== undefined ? { tokensObserved: workerTokens } : {})
      })
    }

    return {
      provider: 'claude',
      sessionId: session.sessionId,
      cwd: session.cwd,
      status: session.status,
      dwarfs,
      updatedAt: transcriptStat?.mtimeMs ?? session.updatedAt ?? this.now()
    }
  }

  /** Terminal memory outranks launch memory everywhere; both paths prune with this. */
  private forgetTerminal(remembered: Map<string, ClaudeInFlightAgent>): void {
    for (const agentId of [...remembered.keys()]) {
      if (this.terminalAgents.has(agentId)) remembered.delete(agentId)
    }
  }

  /**
   * Close the gap between what the transcript says is pending and what this
   * provider actually knows, by looking further back exactly once per distinct
   * unexplained count (issue #36). Mutates `remembered` in place with whatever
   * the deeper window recovers.
   */
  private async recoverMissingLaunches(options: {
    sessionId: string
    transcriptPath: string
    transcriptBytes: number
    alreadyReadBytes: number
    reportedPending: number | undefined
    remembered: Map<string, ClaudeInFlightAgent>
  }): Promise<void> {
    const { sessionId, reportedPending, remembered } = options
    // No count to compare, or every reported agent already accounted for.
    // Either way this session has no shortfall right now, so any settled one
    // is over: forget it, or a later discrepancy reporting the same number
    // would be dismissed as this one and never chased.
    if (reportedPending === undefined || reportedPending <= remembered.size) {
      this.unexplainedShortfalls.delete(sessionId)
      return
    }
    // This exact count already cost one deep read that explained nothing.
    // Repeating it every 2s tick is the unbounded scan this key exists to
    // prevent, so the shortfall settles here until the count itself moves.
    if (this.unexplainedShortfalls.get(sessionId) === reportedPending) return
    // Reading further only helps when there IS more file behind what this poll
    // already read. When the read covered the whole transcript, the missing
    // launch is in no part of it and the same bytes cannot yield it twice.
    if (options.transcriptBytes > options.alreadyReadBytes) {
      const deep = parseClaudeTranscriptTail(
        await this.fs.readTextTail(options.transcriptPath, RECOVERY_TAIL_BYTES)
      )
      // Terminations first, then adoption: a count line can be older than the
      // notification that answered it, so a stale count must never re-adopt an
      // agent already known to have finished. Without this ordering the deep
      // read becomes a resurrection machine for the ghost dwarf that
      // terminalAgents exists to bury.
      for (const agentId of deep.terminalAgentIds) this.terminalAgents.add(agentId)
      for (const agent of deep.inFlightAgents) {
        if (!this.terminalAgents.has(agent.agentId)) remembered.set(agent.agentId, agent)
      }
      this.forgetTerminal(remembered)
    }
    // Still short after the one deep look. The count can legitimately describe
    // background work with no `async_launched` record of its own, so this is
    // not an error and nothing is fabricated to match it — a headcount is not
    // an identity. Record it so the next poll recognizes the attempt; leave it
    // absent when explained, so a future shortfall escalates immediately.
    if (remembered.size < reportedPending) {
      this.unexplainedShortfalls.set(sessionId, reportedPending)
    } else {
      this.unexplainedShortfalls.delete(sessionId)
    }
  }

  private async subagentTranscriptInfo(path: string): Promise<ClaudeTranscriptInfo> {
    if (!(await this.fs.exists(path))) return parseClaudeTranscriptTail('')
    return parseClaudeTranscriptTail(await this.fs.readTextTail(path, SUBAGENT_TAIL_BYTES))
  }

  /**
   * Fold one new usage reading into id's running total and return it.
   * Monotonic (Math.max): see tokenTotals above for why. `undefined` when
   * neither this reading nor any previous one has ever reported tokens.
   */
  private trackTokens(id: string, observed: number | undefined): number | undefined {
    if (observed === undefined) return this.tokenTotals.get(id)
    const next = Math.max(this.tokenTotals.get(id) ?? 0, observed)
    this.tokenTotals.set(id, next)
    return next
  }
}
