import { join } from 'node:path'
import type { FsLike } from '../../adapters/fsLike'
import { isCodexProcessRunning as defaultIsCodexProcessRunning } from '../../platform/processProbe'
import type { SqliteLike } from '../../adapters/sqliteLike'
import { redactSecrets } from '../../domain/redactSecrets'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import { pollProfiler } from '../../runtime/perf'
import { currentPlatform, normalizePathKey, type Platform } from '../../platform/platform'
import type { Provider } from '../provider'
import type { TextDeliveryTarget } from '../../textDelivery/port'
import {
  extractCodexFeed,
  isCodexArtifactStorageCwd,
  parseCodexRolloutContext,
  parseCodexRolloutHead,
  parseCodexRolloutTail,
  type CodexRolloutHead,
  type CodexRolloutInfo
} from './parse'
import { canQueueToCodexThread } from './queue'
import {
  readCodexCliVersions,
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
  /**
   * The session's own dwarf, named beside the snapshot so linkSubagents can
   * reach it without indexing into the crew it already leads.
   */
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
  /** threadId -> the Codex build that opened it, for the queue's version floor (#97). */
  cliVersions: Map<string, string>
}

const EMPTY_REGISTRY: CodexRegistry = {
  threads: new Map(),
  edges: new Map(),
  heartbeats: new Map(),
  cliVersions: new Map()
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
  /**
   * dwarfId -> the thread UUID `codex queue --thread` addresses, for the
   * threads a queued message has been proven to reach (#97).
   *
   * Rebuilt and swapped exactly as feedSources is, and for the same reason
   * (#12): a send landing mid-scan must not read a half-rebuilt map, and a
   * session that has ended must stop answering with a queue address rather than
   * keep offering one.
   */
  private queueTargets: ReadonlyMap<string, string> = new Map()
  /**
   * Session ids ever observed as the PARENT of a Codex sub-agent.
   *
   * The whole of what this provider remembers about topology, and the reason
   * rank stopped flickering (#202). A parent used to be promoted only while a
   * child was busy in the same scan, so it reverted to 'worker' the moment that
   * child's turn closed — the identity swap Claude had already retired. Being
   * the root of a spawn tree is not a headcount, so an edge once read is kept.
   *
   * Flat and process-lifetime, for the reason claudeProvider's abandonedAgents
   * is: the whole cost is one short string per session that ever spawned a
   * sub-agent, and stickiness is the point. Pruning it to the sessions still
   * on the board would reintroduce the flicker for any parent a single scan
   * happened to miss.
   */
  private readonly parentSessions = new Set<string>()

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
    //
    // Seeded from the previous generation rather than empty (#192): a rollout
    // that ages out of the liveness window stops being a session but is still
    // a file with the last turn in it, and the panel reads once more while the
    // runtime shows the dwarf leaving. Queue targets are NOT carried, for the
    // reason their comment gives: a thread that ended must stop answering.
    const feedSources = new Map<string, string>(this.feedSources)
    const queueTargets = new Map<string, string>()
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
        {
          activityMs: Math.max(activityMs, grew ? nowMs : 0),
          grew,
          unchanged,
          size,
          feedSources,
          queueTargets,
          cliVersion: thread === undefined ? undefined : registry.cliVersions.get(thread.threadId)
        }
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
    this.queueTargets = queueTargets
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
    let cliVersions = new Map<string, string>()

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
          cliVersions = pollProfiler.measureSync('cx.q.vers', () => readCodexCliVersions(db))
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
    return { threads, edges, heartbeats, cliVersions }
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
   * A Codex session's one way in: its own message queue (#97).
   *
   * There is still no console tier and there never will be from here — the
   * CLI/TUI records a pid nowhere this provider can read, so no window can be
   * located, and matching a running codex.exe to a thread would be guesswork.
   * What the queue needs instead is the thread UUID, which the registry row
   * already carries, so `codex queue --thread <id>` reaches a session with no
   * window, no pid and no daemon.
   *
   * Offered only where a drain has actually been WATCHED — see queue.ts for the
   * two conditions and the experiment behind them. Everything else keeps
   * reporting null, which renders the send action disabled with its reason
   * instead of failing after the user has typed.
   */
  textDelivery(dwarfId: string): TextDeliveryTarget | null {
    const threadId = this.queueTargets.get(dwarfId)
    return threadId === undefined ? null : { kind: 'codex-queue', threadId }
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
      /** dwarfId -> thread UUID, filled in for queue-reachable threads only (#97). */
      queueTargets: Map<string, string>
      /** The Codex build that opened this thread, for the queue's version floor (#97). */
      cliVersion: string | undefined
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
    // Codex's own artifact-storage path is never a project (issue #166): a
    // session Codex itself never bound to a real workspace folder records
    // that storage path as its cwd, and there is no other field to recover
    // the real one from — laundering it would invent the exact phantom
    // project the issue reports. Dropped here, before any feed/queue side
    // effect is recorded, exactly like a rollout with no session_meta at all.
    if (isCodexArtifactStorageCwd(cwd)) return null
    // Growth since the previous scan means the rollout is being appended to
    // right now, which is a running turn even when the tail read cannot prove it.
    const busy = (rollout?.info.busy ?? false) || context.grew

    const dwarfId = `codex:${sessionId}`
    if (rollout !== null) context.feedSources.set(dwarfId, path)
    // Keyed on the REGISTRY row, never on the rollout: the source tag and the
    // build that opened the thread are both registry facts, and a rollout the
    // registry never recorded proves neither of them (#97).
    if (
      thread !== undefined &&
      canQueueToCodexThread({
        ...(thread.sourceTag === undefined ? {} : { sourceTag: thread.sourceTag }),
        ...(context.cliVersion === undefined ? {} : { cliVersion: context.cliVersion })
      })
    ) {
      context.queueTargets.set(dwarfId, thread.threadId)
    }

    const mainDwarf: Dwarf = {
      id: dwarfId,
      provider: 'codex',
      // A session is a foreman once a child edge has been observed for it, and
      // stays one (#202). 'worker' here is the absence of that evidence, never
      // a verdict about how many children are busy right now; linkSubagents
      // applies an edge first read in THIS scan.
      role: this.parentSessions.has(sessionId) ? 'foreman' : 'worker',
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
    // What a spawned agent was asked to do (#218). Registry-only, and only
    // ever the spawn blob's own `agent_path`: a root thread was nobody's
    // spawn, so it has no agent definition behind it and gets no objective —
    // the prompt in its rollout really was the human's.
    if (thread?.agentPath !== undefined) mainDwarf.description = thread.agentPath
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
        // Whether a TURN is open, which is a different fact from whether the
        // SESSION is alive — conflating the two is what #202 was.
        status: busy ? 'busy' : 'idle',
        // The session is on the board for as long as this provider reports it
        // at all, so only `status` moves between turns (#202). Reaching here
        // already means the liveness gate in scan() accepted the session —
        // registry activity, a logs heartbeat, file growth or the process probe
        // — and that gate stays the one and only place a Codex session stops
        // being live. Listing the dwarf beside an 'idle' snapshot mirrors
        // claudeProvider, whose root is on scene while its registry entry says
        // idle-with-agents-out.
        dwarfs: [mainDwarf],
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
   * Record every parent edge this scan read, and rank the parents accordingly.
   *
   * Codex records a spawned worker's parent thread in its own session_meta, and
   * the registry mirrors the same graph in thread_spawn_edges. Both are records
   * the CHILD carries about itself, so an edge is a fact the moment it is read;
   * a hierarchy is still never inferred from shared cwd, process ancestry or
   * transcript recency.
   *
   * What went (#202): the promotion used to require the child to be busy AND
   * its parent to be in the same scan, so rank tracked the live headcount and a
   * parent whose sub-agent had gone quiet fell back to 'worker' on the next
   * tick. Remembering the edge instead makes the rank monotone — a session that
   * has led a crew keeps its rank whether or not the crew is still out, which
   * is the rule claudeProvider has always had.
   */
  private linkSubagents(
    discovered: DiscoveredCodexSnapshot[],
    edges: ReadonlyMap<string, string>
  ): void {
    for (const child of discovered) {
      const parentSessionId = child.parentSessionId ?? edges.get(child.snapshot.sessionId)
      if (parentSessionId === undefined) continue
      this.parentSessions.add(parentSessionId)
      // The same edge, published for the board (#218). A Codex sub-agent's id
      // is `codex:<uuid>` exactly like a root's, so nothing about it says who
      // launched it — and messageIssuer used to read the launcher out of that
      // id, which named the literal `codex`. Stated here, it is the fact Mine
      // History has always resolved through `parentThreadId`, on the live path.
      child.mainDwarf.parentId = `codex:${parentSessionId}`
    }
    // Applied after the whole scan is read so an edge first seen in THIS scan
    // reaches a parent whose dwarf was already built.
    for (const item of discovered) {
      if (this.parentSessions.has(item.snapshot.sessionId)) item.mainDwarf.role = 'foreman'
    }
  }
}
