import type { FsLike } from '../../adapters/fsLike'
import { isCodexProcessRunning as defaultIsCodexProcessRunning } from '../../adapters/processProbe'
import type { SqliteLike } from '../../adapters/sqliteLike'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import type { Provider } from '../provider'
import {
  extractCodexFeed,
  parseCodexRolloutContext,
  parseCodexRolloutHead,
  parseCodexRolloutTail
} from './parse'
import {
  readCodexHeartbeats,
  readCodexSpawnEdges,
  readCodexThreads,
  type CodexThread
} from './state'

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
  /** A session counts as live while its newest activity is at most this many seconds old. */
  livenessWindowS: number
  /**
   * How many day-directories (today back N-1 days) to scan. A rollout lives
   * in its START-date directory forever, so a session opened days ago and
   * still active today would be invisible without this.
   */
  scanDays: number
  /**
   * A session past livenessWindowS still counts as live for this many extra
   * seconds while isCodexProcessRunning() reports true. An open-but-quiet
   * Codex writes nothing, so timestamps alone can't distinguish "open but
   * quiet" from "closed".
   */
  idleRetentionS: number
  /**
   * How recent a logs_2.sqlite row must be to count as a liveness heartbeat,
   * in seconds. Codex appends log rows continuously while a turn runs.
   */
  heartbeatWindowS?: number
  /**
   * Read-only access to Codex's SQLite registry. Omitted (or pointed at
   * databases that do not exist) the provider falls back to rollout-only
   * detection, which is what older Codex installs need.
   */
  sqlite?: SqliteLike
  /** CODEX_HOME/state_5.sqlite — the authoritative thread registry. */
  stateDbPath?: string
  /** CODEX_HOME/logs_2.sqlite — the liveness heartbeat stream. */
  logsDbPath?: string
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

/** What the SQLite registry contributed to one scan. */
interface CodexRegistry {
  /** threadId -> registry row. */
  threads: Map<string, CodexThread>
  /** childThreadId -> parentThreadId. */
  edges: Map<string, string>
  /** threadId -> newest log timestamp within the heartbeat window, in ms. */
  heartbeats: Map<string, number>
}

const EMPTY_REGISTRY: CodexRegistry = {
  threads: new Map(),
  edges: new Map(),
  heartbeats: new Map()
}

/** One rollout considered by a scan, with whatever the registry knows about it. */
interface CodexCandidate {
  path: string
  thread?: CodexThread
}

/**
 * Windows paths are case-insensitive, and the registry's rollout_path and the
 * day-directory walk can spell the same file differently. Keyed this way a
 * rollout is read once per scan instead of twice.
 */
function candidateKey(path: string): string {
  return path.replaceAll('/', '\\').toLowerCase()
}

function datePath(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}\\${month}\\${day}`
}

/**
 * Detects live Codex sessions, covering both products that share CODEX_HOME:
 * the classic CLI/TUI and the OpenAI Codex desktop app (`codex.exe app-server`).
 *
 * Sessions come from two places that are merged and de-duplicated by thread id:
 * Codex's SQLite registry (state_5.sqlite `threads`, authoritative for cwd,
 * model and reasoning effort) and the rollout files under
 * ~/.codex/sessions/YYYY/MM/DD/, which remain the content source for
 * open-turn detection and the latest assistant message.
 *
 * Liveness deliberately never trusts a rollout's mtime. Windows freezes the
 * mtime of a file held open across a long session — verified at 5.3 hours of
 * frozen mtime on a rollout that was still being appended to (issue #1) — so
 * the provider keys on, in order: file-size growth since the previous scan
 * (proof of writes happening now), a recent logs_2.sqlite heartbeat for the
 * thread, the registry's own activity timestamp, and only then the mtime.
 * An unmatched task_started still marks a session busy, and the process probe
 * still governs the extended idle-retention window.
 */
export class CodexProvider implements Provider {
  readonly kind = 'codex' as const

  private readonly fs: FsLike
  private readonly sessionsRoot: string
  private readonly livenessWindowS: number
  private readonly scanDays: number
  private readonly idleRetentionS: number
  private readonly heartbeatWindowS: number
  private readonly sqlite?: SqliteLike
  private readonly stateDbPath?: string
  private readonly logsDbPath?: string
  private readonly isCodexProcessRunning: () => Promise<boolean>
  private readonly now: () => number
  /**
   * Rollout path -> size at the previous scan. Growth between two scans is the
   * only liveness signal a frozen mtime cannot contradict.
   */
  private readonly lastSeenSizes = new Map<string, number>()
  /**
   * dwarfId -> rollout path, used by feed()/transcriptPath().
   *
   * Rebuilt on every scan into a SEPARATE map that replaces this reference in
   * one assignment at the end (issue #12). Clearing and repopulating the live
   * map across awaits let a click landing mid-scan read a half-rebuilt map and
   * resolve to another dwarf's transcript.
   */
  private feedSources: ReadonlyMap<string, string> = new Map()

  constructor(options: CodexProviderOptions) {
    this.fs = options.fs
    this.sessionsRoot = options.sessionsRoot
    this.livenessWindowS = options.livenessWindowS
    this.scanDays = options.scanDays
    this.idleRetentionS = options.idleRetentionS
    this.heartbeatWindowS = options.heartbeatWindowS ?? options.livenessWindowS
    this.sqlite = options.sqlite
    this.stateDbPath = options.stateDbPath
    this.logsDbPath = options.logsDbPath
    this.isCodexProcessRunning = options.isCodexProcessRunning ?? defaultIsCodexProcessRunning
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    // Built off to the side; swapped in atomically once the scan completes so
    // concurrent feed()/transcriptPath() calls always see a whole generation.
    const feedSources = new Map<string, string>()
    const nowMs = this.now()
    const freshAfter = nowMs - this.livenessWindowS * 1_000
    // Retention is ADDITIVE to the liveness window (as documented for
    // CODEX_IDLE_RETENTION_S): retainAfter is always at or before freshAfter,
    // so no configuration can silently shrink the liveness window itself.
    const retainAfter = nowMs - (this.livenessWindowS + this.idleRetentionS) * 1_000
    // Only probed once per scan, and only when a session actually needs the
    // extended window — most ticks never touch the process list at all.
    let codexProcessRunning: boolean | undefined

    const registry = await this.readRegistry(nowMs, retainAfter)
    const candidates = await this.collectCandidates(nowMs, registry)

    const discovered: DiscoveredCodexSnapshot[] = []
    const seenSessions = new Set<string>()
    // Sizes are only useful for rollouts still in the scan window; anything
    // else is pruned below so a long-running tray session cannot leak entries.
    const sizesThisScan = new Map<string, number>()
    for (const { path, thread } of candidates) {
      const stat = await this.fs.stat(path)
      const size = stat?.size
      const previousSize = this.lastSeenSizes.get(path)
      if (size !== undefined) sizesThisScan.set(path, size)
      // Growth between two scans is proof of writes happening right now, and
      // is the one signal a frozen mtime cannot contradict.
      const grew = previousSize !== undefined && size !== undefined && size > previousSize

      const heartbeatMs =
        thread === undefined ? undefined : registry.heartbeats.get(thread.threadId)
      const activityMs = Math.max(stat?.mtimeMs ?? 0, heartbeatMs ?? 0, thread?.updatedAtMs ?? 0)

      if (!grew) {
        if (activityMs < retainAfter) continue
        if (activityMs < freshAfter) {
          codexProcessRunning ??= await this.isCodexProcessRunning()
          if (!codexProcessRunning) continue
        }
      }

      const discoveredSnapshot = await this.snapshotSession(
        { path, thread },
        { activityMs: Math.max(activityMs, grew ? nowMs : 0), grew, feedSources }
      )
      if (discoveredSnapshot === null || seenSessions.has(discoveredSnapshot.snapshot.sessionId)) {
        continue
      }
      seenSessions.add(discoveredSnapshot.snapshot.sessionId)
      discovered.push(discoveredSnapshot)
    }

    this.linkSubagents(discovered, registry.edges)
    this.lastSeenSizes.clear()
    for (const [path, size] of sizesThisScan) this.lastSeenSizes.set(path, size)
    // Only reached on success: a throwing scan leaves the previous generation
    // in place rather than stripping it.
    this.feedSources = feedSources
    return discovered.map(({ snapshot }) => snapshot)
  }

  /**
   * Read Codex's SQLite registry for this scan. Every failure mode — no
   * SqliteLike injected, missing database, unknown schema — degrades to an
   * empty registry so rollout-only detection keeps working on older installs.
   */
  private async readRegistry(nowMs: number, retainAfter: number): Promise<CodexRegistry> {
    if (this.sqlite === undefined) return EMPTY_REGISTRY

    const threads = new Map<string, CodexThread>()
    let edges = new Map<string, string>()
    let heartbeats = new Map<string, number>()

    if (this.stateDbPath !== undefined) {
      const db = await this.sqlite.openReadOnly(this.stateDbPath)
      if (db !== null) {
        try {
          for (const thread of readCodexThreads(db, retainAfter)) {
            threads.set(thread.threadId, thread)
          }
          edges = readCodexSpawnEdges(db)
        } finally {
          db.close()
        }
      }
    }
    if (this.logsDbPath !== undefined) {
      const db = await this.sqlite.openReadOnly(this.logsDbPath)
      if (db !== null) {
        try {
          heartbeats = readCodexHeartbeats(db, nowMs - this.heartbeatWindowS * 1_000)
        } finally {
          db.close()
        }
      }
    }
    return { threads, edges, heartbeats }
  }

  /**
   * Every rollout worth examining this scan: the registry's own rollout_path
   * for each live-enough thread, plus a walk of the day directories so a
   * rollout Codex never registered (or an older install with no registry at
   * all) is still found. De-duplicated case-insensitively by path.
   */
  private async collectCandidates(
    nowMs: number,
    registry: CodexRegistry
  ): Promise<CodexCandidate[]> {
    const byPath = new Map<string, CodexCandidate>()
    for (const thread of registry.threads.values()) {
      byPath.set(candidateKey(thread.rolloutPath), { path: thread.rolloutPath, thread })
    }

    for (let daysAgo = 0; daysAgo < this.scanDays; daysAgo++) {
      const dir = `${this.sessionsRoot}\\${datePath(new Date(nowMs - daysAgo * 24 * 60 * 60 * 1_000))}`
      for (const entry of await this.fs.listDir(dir)) {
        if (entry.isDirectory || !ROLLOUT_RE.test(entry.name)) continue
        const path = `${dir}\\${entry.name}`
        const key = candidateKey(path)
        // A registry thread already claimed this rollout (and carries richer
        // metadata than the file does), so it is not added twice.
        if (!byPath.has(key)) byPath.set(key, { path })
      }
    }
    return [...byPath.values()]
  }

  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    const path = this.feedSources.get(dwarfId)
    if (path === undefined) return null
    if (!(await this.fs.exists(path))) return []
    return extractCodexFeed(await this.fs.readTextTail(path, FEED_TAIL_BYTES), limit)
  }

  /** Path backing feed(), used to open a terminal that tails the transcript live. */
  transcriptPath(dwarfId: string): string | undefined {
    return this.feedSources.get(dwarfId)
  }

  /**
   * Build one session snapshot from its rollout, its registry row, or both.
   *
   * The rollout stays the content source (open-turn detection and the latest
   * assistant message); the registry row wins for identity and settings, which
   * it records authoritatively and keeps current without any file parsing.
   * A registry thread whose rollout is unreadable still produces a snapshot.
   */
  private async snapshotSession(
    candidate: CodexCandidate,
    context: { activityMs: number; grew: boolean; feedSources: Map<string, string> }
  ): Promise<DiscoveredCodexSnapshot | null> {
    const { path, thread } = candidate
    const rollout = await this.readRollout(path)
    if (rollout === null && thread === undefined) return null

    const sessionId = thread?.threadId ?? rollout!.head.sessionId
    const cwd = thread?.cwd ?? rollout!.head.cwd
    // Growth since the previous scan means the rollout is being appended to
    // right now, which is a running turn even when the tail read cannot prove it.
    const busy = (rollout?.info.busy ?? false) || context.grew

    const dwarfId = `codex:${sessionId}`
    if (rollout !== null) context.feedSources.set(dwarfId, path)

    const mainDwarf: Dwarf = {
      id: dwarfId,
      provider: 'codex',
      role: 'worker',
      name: thread?.agentName ?? rollout?.head.agentName ?? `codex-${sessionId.slice(0, 8)}`,
      model: thread?.model ?? rollout?.info.model,
      effort: thread?.effort ?? rollout?.info.effort,
      status: busy ? 'working' : 'waiting',
      lastMessage: rollout?.info.lastMessage,
      sessionId
    }
    if (thread?.tokensUsed !== undefined) mainDwarf.tokensUsed = thread.tokensUsed

    const discovered: DiscoveredCodexSnapshot = {
      snapshot: {
        provider: 'codex',
        sessionId,
        cwd,
        status: busy ? 'busy' : 'idle',
        dwarfs: busy ? [mainDwarf] : [],
        updatedAt: context.activityMs
      },
      mainDwarf
    }
    const parentSessionId = rollout?.head.parentSessionId ?? thread?.parentThreadId
    if (parentSessionId !== undefined) discovered.parentSessionId = parentSessionId
    return discovered
  }

  /** Parse a rollout's head and tail; null when it is missing or has no session_meta. */
  private async readRollout(path: string): Promise<{
    head: NonNullable<ReturnType<typeof parseCodexRolloutHead>>
    info: ReturnType<typeof parseCodexRolloutTail>
  } | null> {
    // Codex can retire a rollout between the directory walk and either read,
    // which must degrade to "no rollout data" rather than failing the tick.
    let headText: string
    try {
      headText = await this.fs.readTextHead(path, HEAD_BYTES)
    } catch {
      return null
    }
    // Parsed before the tail read so a file that is not a rollout never costs
    // the multi-megabyte busy-detection read.
    const head = parseCodexRolloutHead(headText)
    if (head === null) return null

    let tailText: string
    try {
      tailText = await this.fs.readTextTail(path, BUSY_TAIL_BYTES)
    } catch {
      return null
    }
    const headContext = parseCodexRolloutContext(headText)
    const tailInfo = parseCodexRolloutTail(tailText)
    // A newer turn_context in the tail wins; the head preserves the initial
    // context when a large turn pushed it outside the bounded tail read.
    return {
      head,
      info: {
        ...tailInfo,
        model: tailInfo.model ?? headContext.model,
        effort: tailInfo.effort ?? headContext.effort
      }
    }
  }

  /**
   * Codex records a spawned worker's parent thread in session_meta, and the
   * registry mirrors the same graph in thread_spawn_edges. Promote a parent
   * only when both sessions were observed in this scan; we never infer a
   * hierarchy from shared cwd, process ancestry or transcript recency.
   */
  private linkSubagents(
    discovered: DiscoveredCodexSnapshot[],
    edges: ReadonlyMap<string, string>
  ): void {
    const bySessionId = new Map(discovered.map((item) => [item.snapshot.sessionId, item]))
    for (const child of discovered) {
      if (child.snapshot.status !== 'busy') continue
      const parentSessionId = child.parentSessionId ?? edges.get(child.snapshot.sessionId)
      if (parentSessionId === undefined) continue
      const parent = bySessionId.get(parentSessionId)
      if (parent === undefined) continue
      parent.mainDwarf.role = 'foreman'
      if (!parent.snapshot.dwarfs.some((dwarf) => dwarf.id === parent.mainDwarf.id)) {
        parent.snapshot.dwarfs.unshift(parent.mainDwarf)
      }
    }
  }
}
