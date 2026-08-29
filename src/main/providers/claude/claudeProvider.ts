import { join } from 'node:path'
import type { FsLike } from '../../adapters/fsLike'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import type { TextDeliveryTarget } from '../../textDelivery/port'
import type { Provider } from '../provider'
import {
  claudeSessionDeliveryTarget,
  encodeClaudeProjectDir,
  extractClaudeFeed,
  parseClaudeSessionEntry,
  parseClaudeTranscriptTail,
  type ClaudeSessionEntry,
  type ClaudeTranscriptInfo
} from './parse'

/** Read at most this many bytes from the end of a transcript per scan. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
const SUBAGENT_TAIL_BYTES = 64 * 1024

export interface ClaudeProviderOptions {
  fs: FsLike
  /**
   * Claude config roots to scan (e.g. ~/.claude and ~/.claude-multitec —
   * multiple accounts keep separate sessions/ dirs). Missing roots are skipped.
   */
  roots: string[]
  /** Injected for tests; defaults to a real process.kill(pid, 0) probe. */
  isPidAlive?: (pid: number) => boolean
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
  private readonly now: () => number
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
        if (!this.isPidAlive(session.pid)) continue
        seenSessions.add(session.sessionId)
        snapshots.push(await this.snapshotSession(root, session, feedSources, deliveryTargets))
      }
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
    return extractClaudeFeed(await this.fs.readTextTail(path, TRANSCRIPT_TAIL_BYTES), limit)
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

  private async snapshotSession(
    root: string,
    session: ClaudeSessionEntry,
    feedSources: Map<string, string>,
    deliveryTargets: Map<string, TextDeliveryTarget>
  ): Promise<ProviderSnapshot> {
    const projectDir = join(root, 'projects', encodeClaudeProjectDir(session.cwd))
    const transcriptPath = join(projectDir, `${session.sessionId}.jsonl`)
    const transcriptStat = await this.fs.stat(transcriptPath)
    const info =
      transcriptStat === null
        ? parseClaudeTranscriptTail('')
        : parseClaudeTranscriptTail(
            await this.fs.readTextTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)
          )

    for (const agentId of info.terminalAgentIds) this.terminalAgents.add(agentId)
    const inFlightAgents = info.inFlightAgents.filter(
      (agent) => !this.terminalAgents.has(agent.agentId)
    )

    const mainDwarfId = `claude:${session.sessionId}`
    feedSources.set(mainDwarfId, transcriptPath)
    const sessionTarget = claudeSessionDeliveryTarget(session)
    if (sessionTarget !== null) deliveryTargets.set(mainDwarfId, sessionTarget)
    // Tracked unconditionally, even when the foreman isn't listed below (idle,
    // no agents out), so an idle-then-busy session never loses its total.
    const mainTokens = this.trackTokens(mainDwarfId, info.tokensObserved)

    const dwarfs: Dwarf[] = []
    if (inFlightAgents.length > 0 || session.status === 'busy') {
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
        status: session.status === 'busy' ? 'working' : 'waiting',
        lastMessage: info.lastAssistantText,
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
        status: 'working',
        description: agent.description,
        lastMessage: workerInfo.lastAssistantText,
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
