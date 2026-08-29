import type { FsLike } from '../../adapters/fsLike'
import { isCodexProcessRunning as defaultIsCodexProcessRunning } from '../../adapters/processProbe'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import type { Provider } from '../provider'
import {
  extractCodexFeed,
  parseCodexRolloutContext,
  parseCodexRolloutHead,
  parseCodexRolloutTail
} from './parse'

const HEAD_BYTES = 64 * 1024
/** Tail size used to answer the click-to-focus feed(); a short human-readable window is enough. */
const FEED_TAIL_BYTES = 256 * 1024
/**
 * Tail size used for busy detection. A verbose in-progress turn (tool
 * output, reasoning) can push its own task_started event out of a small
 * tail read before task_complete ever arrives, making a genuinely busy
 * session look idle. On a real machine rollout the observed gap between
 * task_started and its matching task_complete was 347,167 bytes; 4MiB keeps
 * a wide margin while staying a single bounded read per scan.
 */
const BUSY_TAIL_BYTES = 4 * 1024 * 1024
const ROLLOUT_RE = /^rollout-.*\.jsonl$/

export interface CodexProviderOptions {
  fs: FsLike
  /** The ~/.codex/sessions directory. */
  sessionsRoot: string
  /** A rollout counts as live while its mtime is at most this many seconds old. */
  livenessWindowS: number
  /**
   * How many day-directories (today back N-1 days) to scan. A rollout lives
   * in its START-date directory forever, so a session opened days ago and
   * still active today would be invisible without this.
   */
  scanDays: number
  /**
   * A rollout past livenessWindowS still counts as live for this many extra
   * seconds while isCodexProcessRunning() reports true. Codex writes nothing
   * to the rollout while its CLI is open but idle, so mtime alone can't
   * distinguish "open but quiet" from "closed".
   */
  idleRetentionS: number
  /** Injected for tests; defaults to a real process-list probe. */
  isCodexProcessRunning?: () => Promise<boolean>
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
  private readonly scanDays: number
  private readonly idleRetentionS: number
  private readonly isCodexProcessRunning: () => Promise<boolean>
  private readonly now: () => number
  /** dwarfId -> rollout path, rebuilt on every scan (used by feed()). */
  private readonly feedSources = new Map<string, string>()

  constructor(options: CodexProviderOptions) {
    this.fs = options.fs
    this.sessionsRoot = options.sessionsRoot
    this.livenessWindowS = options.livenessWindowS
    this.scanDays = options.scanDays
    this.idleRetentionS = options.idleRetentionS
    this.isCodexProcessRunning = options.isCodexProcessRunning ?? defaultIsCodexProcessRunning
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    this.feedSources.clear()
    const nowMs = this.now()
    const freshAfter = nowMs - this.livenessWindowS * 1_000
    // Retention is ADDITIVE to the liveness window (as documented for
    // CODEX_IDLE_RETENTION_S): retainAfter is always at or before freshAfter,
    // so no configuration can silently shrink the liveness window itself.
    const retainAfter = nowMs - (this.livenessWindowS + this.idleRetentionS) * 1_000
    // Only probed once per scan, and only when a rollout actually needs the
    // extended window — most ticks never touch the process list at all.
    let codexProcessRunning: boolean | undefined

    const discovered: DiscoveredCodexSnapshot[] = []
    const seenSessions = new Set<string>()
    for (let daysAgo = 0; daysAgo < this.scanDays; daysAgo++) {
      const dir = `${this.sessionsRoot}\\${datePath(new Date(nowMs - daysAgo * 24 * 60 * 60 * 1_000))}`
      for (const entry of await this.fs.listDir(dir)) {
        if (entry.isDirectory || !ROLLOUT_RE.test(entry.name)) continue
        const path = `${dir}\\${entry.name}`
        const stat = await this.fs.stat(path)
        if (stat === null || stat.mtimeMs < retainAfter) continue
        if (stat.mtimeMs < freshAfter) {
          codexProcessRunning ??= await this.isCodexProcessRunning()
          if (!codexProcessRunning) continue
        }
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
    return extractCodexFeed(await this.fs.readTextTail(path, FEED_TAIL_BYTES), limit)
  }

  private async snapshotRollout(
    path: string,
    mtimeMs: number
  ): Promise<DiscoveredCodexSnapshot | null> {
    const headText = await this.fs.readTextHead(path, HEAD_BYTES)
    const head = parseCodexRolloutHead(headText)
    if (head === null) return null
    const headContext = parseCodexRolloutContext(headText)
    const tailInfo = parseCodexRolloutTail(await this.fs.readTextTail(path, BUSY_TAIL_BYTES))
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
      status: info.busy ? 'working' : 'waiting',
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
