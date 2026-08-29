import type { FsLike } from '../../adapters/fsLike'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import type { Provider } from '../provider'
import {
  encodeClaudeProjectDir,
  extractClaudeFeed,
  parseClaudeSessionEntry,
  parseClaudeTranscriptTail,
  type ClaudeSessionEntry
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
  /** dwarfId -> transcript path, rebuilt on every scan (used by feed()). */
  private readonly feedSources = new Map<string, string>()

  constructor(options: ClaudeProviderOptions) {
    this.fs = options.fs
    this.roots = options.roots
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    this.feedSources.clear()
    const snapshots: ProviderSnapshot[] = []
    const seenSessions = new Set<string>()

    for (const root of this.roots) {
      const sessionsDir = `${root}\\sessions`
      if (!(await this.fs.exists(sessionsDir))) continue
      for (const entry of await this.fs.listDir(sessionsDir)) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue
        const session = await this.readSessionEntry(`${sessionsDir}\\${entry.name}`)
        if (session === null) continue
        if (seenSessions.has(session.sessionId)) continue
        if (!this.isPidAlive(session.pid)) continue
        seenSessions.add(session.sessionId)
        snapshots.push(await this.snapshotSession(root, session))
      }
    }
    return snapshots
  }

  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    const path = this.feedSources.get(dwarfId)
    if (path === undefined) return null
    if (!(await this.fs.exists(path))) return []
    return extractClaudeFeed(await this.fs.readTextTail(path, TRANSCRIPT_TAIL_BYTES), limit)
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
    session: ClaudeSessionEntry
  ): Promise<ProviderSnapshot> {
    const projectDir = `${root}\\projects\\${encodeClaudeProjectDir(session.cwd)}`
    const transcriptPath = `${projectDir}\\${session.sessionId}.jsonl`
    const transcriptStat = await this.fs.stat(transcriptPath)
    const info =
      transcriptStat === null
        ? parseClaudeTranscriptTail('')
        : parseClaudeTranscriptTail(
            await this.fs.readTextTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)
          )

    const mainDwarfId = `claude:${session.sessionId}`
    this.feedSources.set(mainDwarfId, transcriptPath)

    const dwarfs: Dwarf[] = []
    const hasSubagents = info.inFlightAgents.length > 0
    if (hasSubagents || session.status === 'busy') {
      dwarfs.push({
        id: mainDwarfId,
        provider: 'claude',
        role: hasSubagents ? 'foreman' : 'worker',
        name: session.name ?? session.sessionId.slice(0, 8),
        model: info.model,
        effort: info.effort,
        status: session.status === 'busy' ? 'working' : 'waiting',
        lastMessage: info.lastAssistantText,
        sessionId: session.sessionId,
        pid: session.pid,
        startedAt: session.startedAt
      })
    }
    for (const agent of info.inFlightAgents) {
      const workerId = `${mainDwarfId}:${agent.agentId}`
      const subagentPath = `${projectDir}\\${session.sessionId}\\subagents\\agent-${agent.agentId}.jsonl`
      this.feedSources.set(workerId, subagentPath)
      dwarfs.push({
        id: workerId,
        provider: 'claude',
        role: 'worker',
        name: agent.description ?? `agent-${agent.agentId.slice(0, 7)}`,
        model: agent.resolvedModel,
        effort: info.effort,
        status: 'working',
        description: agent.description,
        lastMessage: await this.subagentLastMessage(subagentPath),
        sessionId: session.sessionId,
        pid: session.pid
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

  private async subagentLastMessage(path: string): Promise<string | undefined> {
    if (!(await this.fs.exists(path))) return undefined
    const info = parseClaudeTranscriptTail(await this.fs.readTextTail(path, SUBAGENT_TAIL_BYTES))
    return info.lastAssistantText
  }
}
