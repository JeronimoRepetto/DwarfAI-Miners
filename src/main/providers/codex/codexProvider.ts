import type { FsLike } from '../../adapters/fsLike'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import type { Provider } from '../provider'
import {
  extractCodexFeed,
  parseCodexRolloutContext,
  parseCodexRolloutHead,
  parseCodexRolloutTail
} from './parse'

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024
const ROLLOUT_RE = /^rollout-.*\.jsonl$/

export interface CodexProviderOptions {
  fs: FsLike
  /** The ~/.codex/sessions directory. */
  sessionsRoot: string
  /** A rollout counts as live while its mtime is at most this many seconds old. */
  livenessWindowS: number
  now?: () => number
}

interface DiscoveredCodexSnapshot {
  snapshot: ProviderSnapshot
  /** Always retained internally so an idle parent can become a foreman. */
  mainDwarf: Dwarf
  parentSessionId?: string
}

function datePath(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}\\${month}\\${day}`
}

/**
 * Detects live Codex CLI sessions from rollout files under
 * ~/.codex/sessions/YYYY/MM/DD/. Codex writes no pid/lock files, so liveness
 * is mtime-based: a rollout touched within the liveness window counts as an
 * open session; an unmatched task_started marks it busy.
 */
export class CodexProvider implements Provider {
  readonly kind = 'codex' as const

  private readonly fs: FsLike
  private readonly sessionsRoot: string
  private readonly livenessWindowS: number
  private readonly now: () => number
  /** dwarfId -> rollout path, rebuilt on every scan (used by feed()). */
  private readonly feedSources = new Map<string, string>()

  constructor(options: CodexProviderOptions) {
    this.fs = options.fs
    this.sessionsRoot = options.sessionsRoot
    this.livenessWindowS = options.livenessWindowS
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    this.feedSources.clear()
    const nowMs = this.now()
    const freshAfter = nowMs - this.livenessWindowS * 1_000
    const today = new Date(nowMs)
    const yesterday = new Date(nowMs - 24 * 60 * 60 * 1_000)

    const discovered: DiscoveredCodexSnapshot[] = []
    const seenSessions = new Set<string>()
    for (const day of [datePath(today), datePath(yesterday)]) {
      const dir = `${this.sessionsRoot}\\${day}`
      for (const entry of await this.fs.listDir(dir)) {
        if (entry.isDirectory || !ROLLOUT_RE.test(entry.name)) continue
        const path = `${dir}\\${entry.name}`
        const stat = await this.fs.stat(path)
        if (stat === null || stat.mtimeMs < freshAfter) continue
        const discoveredSnapshot = await this.snapshotRollout(path, stat.mtimeMs)
        if (discoveredSnapshot === null || seenSessions.has(discoveredSnapshot.snapshot.sessionId))
          continue
        seenSessions.add(discoveredSnapshot.snapshot.sessionId)
        discovered.push(discoveredSnapshot)
      }
    }
    this.linkSubagents(discovered)
    return discovered.map(({ snapshot }) => snapshot)
  }

  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    const path = this.feedSources.get(dwarfId)
    if (path === undefined) return null
    if (!(await this.fs.exists(path))) return []
    return extractCodexFeed(await this.fs.readTextTail(path, TAIL_BYTES), limit)
  }

  private async snapshotRollout(
    path: string,
    mtimeMs: number
  ): Promise<DiscoveredCodexSnapshot | null> {
    const headText = await this.fs.readTextHead(path, HEAD_BYTES)
    const head = parseCodexRolloutHead(headText)
    if (head === null) return null
    const headContext = parseCodexRolloutContext(headText)
    const tailInfo = parseCodexRolloutTail(await this.fs.readTextTail(path, TAIL_BYTES))
    // A newer turn_context in the tail wins; the head preserves the initial
    // context when a large turn pushed it outside the bounded tail read.
    const info = {
      ...tailInfo,
      model: tailInfo.model ?? headContext.model,
      effort: tailInfo.effort ?? headContext.effort
    }

    const dwarfId = `codex:${head.sessionId}`
    this.feedSources.set(dwarfId, path)

    const mainDwarf: Dwarf = {
      id: dwarfId,
      provider: 'codex',
      role: 'worker',
      name: head.agentName ?? `codex-${head.sessionId.slice(0, 8)}`,
      model: info.model,
      effort: info.effort,
      status: info.busy ? 'working' : 'idle',
      lastMessage: info.lastMessage,
      sessionId: head.sessionId
    }
    const dwarfs: Dwarf[] = []
    if (info.busy) {
      dwarfs.push(mainDwarf)
    }

    return {
      snapshot: {
        provider: 'codex',
        sessionId: head.sessionId,
        cwd: head.cwd,
        status: info.busy ? 'busy' : 'idle',
        dwarfs,
        updatedAt: mtimeMs
      },
      mainDwarf,
      parentSessionId: head.parentSessionId
    }
  }

  /**
   * Codex records a spawned worker's parent thread in session_meta. Promote a
   * parent only when both sessions were observed in this scan; we never infer
   * a hierarchy from shared cwd, process ancestry or transcript recency.
   */
  private linkSubagents(discovered: DiscoveredCodexSnapshot[]): void {
    const bySessionId = new Map(discovered.map((item) => [item.snapshot.sessionId, item]))
    for (const child of discovered) {
      if (child.parentSessionId === undefined || child.snapshot.status !== 'busy') continue
      const parent = bySessionId.get(child.parentSessionId)
      if (parent === undefined) continue
      parent.mainDwarf.role = 'foreman'
      if (!parent.snapshot.dwarfs.some((dwarf) => dwarf.id === parent.mainDwarf.id)) {
        parent.snapshot.dwarfs.unshift(parent.mainDwarf)
      }
    }
  }
}
