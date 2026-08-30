import { join } from 'node:path'
import type { FsLike } from '../../adapters/fsLike'
import { isCodexProcessRunning as defaultIsCodexProcessRunning } from '../../adapters/processProbe'
import type { SqliteLike } from '../../adapters/sqliteLike'
import { redactSecrets } from '../../domain/redactSecrets'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import { pollProfiler } from '../../runtime/perf'
import { currentPlatform, normalizePathKey, type Platform } from '../../platform/platform'
import type { Provider } from '../provider'
import {
  extractCodexFeed,
  parseCodexRolloutContext,
  parseCodexRolloutHead,
  parseCodexRolloutTail,
  type CodexRolloutHead,
  type CodexRolloutInfo
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
/**
 * How long a resolved isCodexProcessRunning() verdict is reused across scan
 * ticks when no override is supplied. A quiet session past freshAfter but
 * still inside retainAfter would otherwise re-spawn PowerShell on every 2s
 * tick for as long as it stays quiet; the TTL bounds that to one spawn per
 * window while staying responsive enough to notice codex opening or closing.
 */
const DEFAULT_PROCESS_PROBE_CACHE_TTL_S = 15

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
  /** Decides how rollout paths are compared; defaults to this machine's platform. */
  platform?: Platform
  /**
   * How long a resolved isCodexProcessRunning() verdict is reused across scan
   * ticks, in seconds. Defaults to DEFAULT_PROCESS_PROBE_CACHE_TTL_S.
   */
  processProbeCacheTtlS?: number
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

/** Parsed head+tail of one rollout, as returned (fresh or cached) by readRollout(). */
interface RolloutParseResult {
  head: CodexRolloutHead
  info: CodexRolloutInfo
}

/**
 * The registry's rollout_path and the day-directory walk can spell the same
 * file differently. Keyed this way a rollout is read once per scan instead of
 * twice. The folding is platform-aware (see normalizePathKey): merging two
 * spellings is right on Windows and macOS, and wrong on Linux, where two
 * rollouts differing only in case really are two different files.
 */
function candidateKey(path: string, platform: Platform): string {
  return normalizePathKey(path, platform)
}

/** The YYYY/MM/DD directory a rollout started on that day lives in. */
function dateSegments(date: Date): [string, string, string] {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ]
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
  private readonly processProbeCacheTtlS: number
  private readonly platform: Platform
  private readonly now: () => number
  /**
   * Rollout path -> size at the previous scan. Growth between two scans is the
   * only liveness signal a frozen mtime cannot contradict.
   */
  private readonly lastSeenSizes = new Map<string, number>()
  /**
   * Rollout path -> tail-derived info at the size it was last read. A rollout
   * whose size hasn't changed since the previous scan has produced no new
   * bytes to parse (rollouts are append-only), so its previous busy/model/
   * lastMessage verdict is reused instead of paying the BUSY_TAIL_BYTES (4MiB)
   * read again. The head is always re-read (HEAD_BYTES is cheap, and it keeps
   * a real read happening on every candidate every scan). Pruned to the
   * current scan's candidates at the end of every scan().
   */
  private readonly rolloutCache = new Map<string, { size: number; info: CodexRolloutInfo }>()
  /** Last isCodexProcessRunning() verdict, reused for processProbeCacheTtlS seconds. */
  private probeCache: { running: boolean; checkedAtMs: number } | undefined
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
    this.processProbeCacheTtlS = options.processProbeCacheTtlS ?? DEFAULT_PROCESS_PROBE_CACHE_TTL_S
    this.platform = options.platform ?? currentPlatform()
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

    const registry = await pollProfiler.measure('cx.registry', () =>
      this.readRegistry(nowMs, retainAfter)
    )
    const candidates = await pollProfiler.measure('cx.candidates', () =>
      this.collectCandidates(nowMs, registry)
    )
    pollProfiler.count('cx.candidates.n', candidates.length)

    const discovered: DiscoveredCodexSnapshot[] = []
    const seenSessions = new Set<string>()
    // Sizes are only useful for rollouts still in the scan window; anything
    // else is pruned below so a long-running tray session cannot leak entries.
    const sizesThisScan = new Map<string, number>()
    // Every candidate's stat is fetched in one batch rather than one await at
    // a time (#25). stat() has no side effects and nothing below depends on
    // the previous candidate's result, so the order of the loop — and every
    // decision it makes — is unchanged; only the waiting is shared. Measured
    // on a 7-day window of 84 rollouts, this is the difference between 5.1ms
    // and 0.4ms of the 2s poll (see docs/performance.md).
    const stats = await pollProfiler.measure('cx.stat', () =>
      Promise.all(candidates.map((candidate) => this.fs.stat(candidate.path)))
    )
    for (const [index, { path, thread }] of candidates.entries()) {
      const stat = stats[index] ?? null
      const size = stat?.size
      const previousSize = this.lastSeenSizes.get(path)
      if (size !== undefined) sizesThisScan.set(path, size)
      // Growth between two scans is proof of writes happening right now, and
      // is the one signal a frozen mtime cannot contradict.
      const grew = previousSize !== undefined && size !== undefined && size > previousSize
      // The mirror image of grew: a rollout that produced no new bytes since
      // the previous scan has nothing new to parse (rollouts are append-only),
      // so its cached parse result can be reused as-is.
      const unchanged = previousSize !== undefined && size !== undefined && size === previousSize

      const heartbeatMs =
        thread === undefined ? undefined : registry.heartbeats.get(thread.threadId)
      const activityMs = Math.max(stat?.mtimeMs ?? 0, heartbeatMs ?? 0, thread?.updatedAtMs ?? 0)

      if (!grew) {
        if (activityMs < retainAfter) continue
        if (activityMs < freshAfter) {
          codexProcessRunning ??= await this.getCachedProcessRunning(nowMs)
          if (!codexProcessRunning) continue
        }
      }

      const discoveredSnapshot = await this.snapshotSession(
        { path, thread },
        { activityMs: Math.max(activityMs, grew ? nowMs : 0), grew, unchanged, size, feedSources }
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
    // Drop cached parses for rollouts no longer scanned this tick, so a
    // retired session's parse result does not linger forever.
    for (const path of [...this.rolloutCache.keys()]) {
      if (!sizesThisScan.has(path)) this.rolloutCache.delete(path)
    }
    // Only reached on success: a throwing scan leaves the previous generation
    // in place rather than stripping it.
    this.feedSources = feedSources
    return discovered.map(({ snapshot }) => snapshot)
  }

  /**
   * isCodexProcessRunning() spawns a PowerShell process. scan() already
   * memoizes it to at most one call per tick (codexProcessRunning above), but
   * a session that stays in the "past freshAfter, still inside retainAfter"
   * band keeps needing it on every subsequent 2s tick. Reusing the verdict
   * for processProbeCacheTtlS seconds bounds that to one spawn per window.
   */
  private async getCachedProcessRunning(nowMs: number): Promise<boolean> {
    if (
      this.probeCache !== undefined &&
      nowMs - this.probeCache.checkedAtMs < this.processProbeCacheTtlS * 1_000
    ) {
      return this.probeCache.running
    }
    const running = await this.isCodexProcessRunning()
    this.probeCache = { running, checkedAtMs: nowMs }
    return running
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
          pollProfiler.measureSync('cx.q.threads', () => {
            for (const thread of readCodexThreads(db, retainAfter)) {
              threads.set(thread.threadId, thread)
            }
          })
          edges = pollProfiler.measureSync('cx.q.edges', () => readCodexSpawnEdges(db))
        } finally {
          db.close()
        }
      }
    }
    if (this.logsDbPath !== undefined) {
      const db = await this.sqlite.openReadOnly(this.logsDbPath)
      if (db !== null) {
        try {
          // Measured as its own stage because it is the most expensive thing
          // one poll does (#25): the plan is a covering-index walk grouped by
          // thread_id, so its cost tracks the SIZE of the Codex log store
          // rather than the length of the heartbeat window.
          pollProfiler.measureSync('cx.q.beats', () => {
            heartbeats = readCodexHeartbeats(db, nowMs - this.heartbeatWindowS * 1_000)
          })
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
      byPath.set(candidateKey(thread.rolloutPath, this.platform), {
        path: thread.rolloutPath,
        thread
      })
    }

    for (let daysAgo = 0; daysAgo < this.scanDays; daysAgo++) {
      const day = new Date(nowMs - daysAgo * 24 * 60 * 60 * 1_000)
      const dir = join(this.sessionsRoot, ...dateSegments(day))
      for (const entry of await this.fs.listDir(dir)) {
        if (entry.isDirectory || !ROLLOUT_RE.test(entry.name)) continue
        const path = join(dir, entry.name)
        const key = candidateKey(path, this.platform)
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
    // Redacted here — user text included — so preload/renderer never hold the
    // raw string (see domain/redactSecrets).
    return extractCodexFeed(await this.fs.readTextTail(path, FEED_TAIL_BYTES), limit).map(
      (message) => ({ ...message, text: redactSecrets(message.text) })
    )
  }

  /** Path backing feed(), used to open a terminal that tails the transcript live. */
  transcriptPath(dwarfId: string): string | undefined {
    return this.feedSources.get(dwarfId)
  }

  /**
   * Codex sessions currently have no input channel, whichever product owns
   * them.
   *
   * The CLI/TUI never records a pid anywhere this provider can read — neither
   * the rollout's session_meta nor the state_5.sqlite `threads` row carries
   * one — so there is no process to walk up to a console window, and matching
   * a running codex.exe to a specific thread would be guesswork. The desktop
   * app (`codex.exe app-server`) has no console at all, and Codex exposes no
   * cross-session messaging the way Claude Code does.
   *
   * Reporting null for both keeps the panel honest: the send action renders
   * disabled with an explanation instead of failing after the user has typed.
   */
  textDelivery(_dwarfId: string): null {
    return null
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
    context: {
      activityMs: number
      grew: boolean
      /** True when this rollout's size is unchanged since the previous scan. */
      unchanged: boolean
      /** This scan's observed size, used as the rolloutCache key alongside path. */
      size: number | undefined
      feedSources: Map<string, string>
    }
  ): Promise<DiscoveredCodexSnapshot | null> {
    const { path, thread } = candidate
    const rollout = await this.readRollout(path, {
      unchanged: context.unchanged,
      size: context.size
    })
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
      // Codex exposes no structured "alive but blocked mid-turn" evidence: its
      // rollout event vocabulary carries no approval/input-request record and
      // logs_2.sqlite is a plain tracing log (both verified against real data,
      // 2026-08-30). So a possibly-blocked in-turn agent deliberately stays
      // 'working' — issue #34's conservative rule — and turn_aborted (see
      // parse.ts) is the one structured signal that ends a turn without a
      // task_complete.
      status: busy ? 'working' : 'waiting',
      // Redacted BEFORE the renderer's bubble truncation can ever slice it: a
      // truncated prefix can still contain a whole key. The rolloutCache keeps
      // the raw parse; only what leaves the provider is scrubbed.
      lastMessage: redactSecrets(rollout?.info.lastMessage),
      sessionId
    }
    if (thread?.tokensUsed !== undefined) {
      mainDwarf.tokensUsed = thread.tokensUsed
      // Mirrors tokensUsed so the ore/vault economy has one field to sum
      // across providers (see Mine.tokensObserved).
      mainDwarf.tokensObserved = thread.tokensUsed
    }

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

  /**
   * Parse a rollout's head and tail; null when it is missing or has no
   * session_meta.
   *
   * The head (HEAD_BYTES, 64KiB) is always read fresh — it is cheap, and a
   * real per-candidate read every scan keeps directory/file churn (a retired
   * rollout disappearing between the walk and the read) handled the same way
   * regardless of caching. The tail (BUSY_TAIL_BYTES, 4MiB) is the expensive
   * part; when `cache.unchanged` is true (this rollout's size matches the
   * previous scan's) a rolloutCache hit is reused instead of re-reading it —
   * rollouts are append-only, so no growth means no new bytes to parse and
   * the previous busy/model/lastMessage verdict is still exactly correct.
   */
  private async readRollout(
    path: string,
    cache: { unchanged: boolean; size: number | undefined }
  ): Promise<RolloutParseResult | null> {
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

    if (cache.unchanged && cache.size !== undefined) {
      const cached = this.rolloutCache.get(path)
      if (cached !== undefined && cached.size === cache.size) {
        return { head, info: cached.info }
      }
    }

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
    const info: CodexRolloutInfo = {
      ...tailInfo,
      model: tailInfo.model ?? headContext.model,
      effort: tailInfo.effort ?? headContext.effort
    }
    if (cache.size !== undefined) this.rolloutCache.set(path, { size: cache.size, info })
    return { head, info }
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
