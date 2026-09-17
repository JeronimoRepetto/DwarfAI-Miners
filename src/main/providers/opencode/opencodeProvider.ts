import { normalize } from 'node:path'
import type { FsLike } from '../../adapters/fsLike'
import type { SqliteLike } from '../../adapters/sqliteLike'
import { redactSecrets } from '../../domain/redactSecrets'
import {
  dwarfSilenceWindowMs,
  type Dwarf,
  type FeedMessage,
  type FeedPageCursor,
  type ProviderSnapshot
} from '../../domain/types'
import { cursorIndex, feedPageOf, textCount, trimFeed, type FeedWindowRead } from '../feedWindow'
import type { Provider } from '../provider'
import { pollProfiler } from '../../runtime/perf'
import { lastAssistantText, openCodeFeedRows } from './parse'
import {
  readOpenCodeEventSeqs,
  readOpenCodeMessages,
  readOpenCodeNewestAssistant,
  readOpenCodeSessions
} from './state'
import { opencodeDbPath, opencodeWalPath } from './store'

/**
 * Observes OpenCode CLI sessions through `opencode.db` alone — see
 * `docs/opencode-format.md` for the measured 1.18.31 shape this reads.
 *
 * ## What it is, and what it deliberately is not
 *
 * Store-reading only, in the `CodexProvider` shape: pure parsers in
 * `parse.ts`, SQL in `state.ts`, this class the orchestration — `stat` two
 * files, open the database read-only, read four things, decide, publish. No
 * process probe (the schema carries no pid or process column anywhere, D3/
 * Row 5), no delivery channel (`textDelivery` returns `null`, as
 * `SimulatedProvider` does), no transcript file (`transcriptPath` returns
 * `undefined` — the conversation lives as rows, not a file to tail).
 *
 * ## Liveness (D3), without a probe
 *
 * A session is `busy` while EITHER its newest assistant message carries no
 * `time.completed` (still streaming), OR its `event.seq` has advanced since
 * the previous poll (remembered per session, exactly as `CodexProvider`
 * remembers `lastSeenSizes`) — the half that catches the gap between a new
 * user turn being written and the first assistant row appearing. A completed
 * message with `finish: 'tool-calls'` is an intermediate step and keeps the
 * session busy until `BUSY_WINDOW_MS` passes with no further `seq` movement —
 * the guard against a crashed mid-turn row. `idle` is `time.completed` set
 * with `finish: 'stop'`. `waiting` is never reported: no pending-permission
 * evidence exists anywhere in this schema (`docs/opencode-format.md`).
 *
 * ## Topology (D4)
 *
 * `session.parent_id` is the only source: non-null makes a session a
 * `'worker'` with `parentId` set, and its parent — remembered across scans,
 * exactly as `CodexProvider.parentSessions` is, so a foreman keeps its rank
 * once its crew has gone home — is promoted `'foreman'`. A null `parent_id`
 * is a root, published `'foreman'` by default (D4's departure from Codex:
 * OpenCode's root/child fact lives on the session's own row, so a null
 * `parent_id` is a positive reading rather than the absence of a separate
 * spawn table).
 *
 * ## Store-level growth gate (D2)
 *
 * `opencode.db` and `opencode.db-wal` sizes are STORE-level: growth proves
 * writes happened somewhere, not which session. Both unchanged since the
 * previous scan reuses that generation whole, with zero `openReadOnly` calls
 * — the same idiom `codexProvider.ts` uses for its own rollout files.
 *
 * ## Feed, with no file to tail
 *
 * `feed`/`feedPage` are assembled from `readOpenCodeMessages` rows into
 * `FeedMessage[]` on every call — there is no per-session file, so nothing is
 * cached between polls. `feedPage` composes the exported `cursorIndex`
 * (`feedWindow.ts`) directly with `feedPageOf` instead of `readFeedPage`'s
 * byte-window walk, since the whole conversation is one bounded read rather
 * than a file to widen a tail against.
 */

/**
 * How long a completed `finish: 'tool-calls'` message keeps a session busy
 * with no further `event.seq` movement, in milliseconds — the guard against a
 * crashed mid-turn row (D3). 120 s, Antigravity's `busyWindowS` precedent.
 */
const BUSY_WINDOW_MS = 120_000

/** How many of a session's newest messages are read for its `lastMessage` on every scan. */
const LAST_MESSAGE_READ_LIMIT = 20

/**
 * How many of a session's messages `feedPage` reads to find a cursor in.
 * Generous rather than exact: unlike a byte-window walk there is no cheaper
 * partial read available, so one bounded query stands in for "the whole
 * conversation" for any session this app is likely to see.
 */
const PAGE_READ_LIMIT = 5_000

export interface OpenCodeProviderOptions {
  /** `stat` of `opencode.db` / `opencode.db-wal` only — no other read. */
  fs: FsLike
  /** `opencode.db` missing or unreadable → not observed. */
  sqlite: SqliteLike
  /** The store root, already expanded. */
  storeRoot: string
  now?: () => number
}

interface SeqMemory {
  seq: number
  /** When this session's seq last actually moved — the stall clock for BUSY_WINDOW_MS. */
  changedAtMs: number
}

export class OpenCodeProvider implements Provider {
  readonly kind = 'opencode' as const

  private readonly fs: FsLike
  private readonly sqlite: SqliteLike
  private readonly dbPath: string
  private readonly walPath: string
  private readonly now: () => number

  /** Sizes at the previous scan; both unchanged reuses the previous generation whole. */
  private lastDbSize: number | undefined
  private lastWalSize: number | undefined
  private previousSnapshots: ProviderSnapshot[] = []

  /** sessionId -> its max event.seq and when that seq last changed, this generation. */
  private seqMemory = new Map<string, SeqMemory>()
  /**
   * Every session id ever OBSERVED as a parent, across every scan — never
   * cleared, so a foreman keeps its rank after its crew is gone (D4, the same
   * rule `codexProvider.ts`'s own `parentSessions` field holds).
   */
  private readonly parentSessions = new Set<string>()
  /** Every session id the last successful scan published — feed()'s "known or not" answer. */
  private knownSessionIds: ReadonlySet<string> = new Set()

  constructor(options: OpenCodeProviderOptions) {
    this.fs = options.fs
    this.sqlite = options.sqlite
    this.dbPath = opencodeDbPath(options.storeRoot)
    this.walPath = opencodeWalPath(options.storeRoot)
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    const nowMs = this.now()
    const [dbStat, walStat] = await Promise.all([
      this.fs.stat(this.dbPath),
      this.fs.stat(this.walPath)
    ])

    const dbSize = dbStat?.size
    const walSize = walStat?.size
    const unchanged =
      this.lastDbSize !== undefined &&
      dbSize !== undefined &&
      this.lastDbSize === dbSize &&
      this.lastWalSize !== undefined &&
      walSize !== undefined &&
      this.lastWalSize === walSize
    if (unchanged) return this.previousSnapshots

    this.lastDbSize = dbSize
    this.lastWalSize = walSize

    if (dbStat === null) return this.publishNothing()

    const db = await this.sqlite.openReadOnly(this.dbPath)
    if (db === null) return this.publishNothing()

    const sessions = readOpenCodeSessions(db, 0)
    if (sessions.length === 0) return this.publishNothing()

    for (const session of sessions) {
      if (session.parentSessionId !== undefined) this.parentSessions.add(session.parentSessionId)
    }

    const sessionIds = sessions.map((session) => session.sessionId)
    // Profiled (#444, D9 open question): MAX(seq) GROUP BY aggregate_id is a
    // covering scan on the unique (aggregate_id, seq) index, but a store that
    // has grown for months is exactly where a covering scan can still cost
    // more than it looks like on a fresh fixture. If this stage's own line
    // (DWARFAI_PERF=1) ever shows it growing unbounded, narrow with
    // `WHERE aggregate_id IN (…live ids…)` — see docs/opencode-format.md.
    const eventSeqs = pollProfiler.measureSync('opencode.eventSeqs', () =>
      readOpenCodeEventSeqs(db)
    )
    const newestAssistant = readOpenCodeNewestAssistant(db, sessionIds)
    const seqMemory = new Map<string, SeqMemory>()
    const knownSessionIds = new Set<string>()
    const snapshots: ProviderSnapshot[] = []

    for (const session of sessions) {
      // #166: an empty directory names no honest project, so the session is
      // dropped rather than placed under a phantom one.
      if (session.cwd === '') continue
      const cwd = normalize(session.cwd)

      const newSeq = eventSeqs.get(session.sessionId) ?? 0
      const previous = this.seqMemory.get(session.sessionId)
      const seqAdvanced = previous !== undefined && newSeq > previous.seq
      const changedAtMs = seqAdvanced ? nowMs : (previous?.changedAtMs ?? nowMs)
      seqMemory.set(session.sessionId, { seq: newSeq, changedAtMs })

      const newest = newestAssistant.get(session.sessionId)
      const streaming = newest === undefined || newest.timeCompletedMs === undefined
      const intermediateStep =
        newest !== undefined && newest.timeCompletedMs !== undefined && newest.finish !== 'stop'
      const stalled = nowMs - changedAtMs >= BUSY_WINDOW_MS
      const busy = streaming || seqAdvanced || (intermediateStep && !stalled)

      const activityMs = Math.max(
        seqAdvanced ? nowMs : 0,
        newest?.timeCompletedMs ?? newest?.timeCreatedMs ?? 0,
        session.updatedMs,
        walStat?.mtimeMs ?? 0
      )

      const role = this.roleOf(session.sessionId, session.parentSessionId)
      if (nowMs - activityMs > dwarfSilenceWindowMs(role, 'unknown')) continue

      const { messages, parts } = readOpenCodeMessages(
        db,
        session.sessionId,
        LAST_MESSAGE_READ_LIMIT
      )
      const lastMessage = redactSecrets(lastAssistantText(messages, parts))

      const dwarf: Dwarf = {
        id: `opencode:${session.sessionId}`,
        provider: 'opencode',
        role,
        name: session.agent ?? `opencode-${session.sessionId.slice(0, 8)}`,
        status: busy ? 'working' : 'waiting',
        sessionId: session.sessionId
      }
      if (session.modelId !== undefined) dwarf.model = session.modelId
      if (session.parentSessionId !== undefined) {
        dwarf.parentId = `opencode:${session.parentSessionId}`
      }
      if (lastMessage !== undefined) dwarf.lastMessage = lastMessage

      knownSessionIds.add(session.sessionId)
      snapshots.push({
        provider: 'opencode',
        sessionId: session.sessionId,
        cwd,
        status: busy ? 'busy' : 'idle',
        dwarfs: [dwarf],
        updatedAt: activityMs
      })
    }

    // Only reached on success (#12): a throwing scan leaves the previous
    // generation in place, and a concurrent feed() call mid-scan reads it
    // until every await above has resolved.
    this.seqMemory = seqMemory
    this.knownSessionIds = knownSessionIds
    this.previousSnapshots = snapshots
    return snapshots
  }

  /** `'foreman'` for a root, or for any session ever observed as somebody's parent; `'worker'` otherwise. */
  private roleOf(sessionId: string, parentSessionId: string | undefined): 'foreman' | 'worker' {
    if (this.parentSessions.has(sessionId)) return 'foreman'
    return parentSessionId === undefined ? 'foreman' : 'worker'
  }

  /** A scan that found nothing to publish still counts as success: the generation swaps to empty. */
  private publishNothing(): ProviderSnapshot[] {
    this.previousSnapshots = []
    this.knownSessionIds = new Set()
    return []
  }

  private sessionIdOf(dwarfId: string): string | undefined {
    return dwarfId.startsWith('opencode:') ? dwarfId.slice('opencode:'.length) : undefined
  }

  /**
   * The last `limit` things said, assembled fresh from `message` × `part` rows
   * — there is no file behind this to walk, so every call re-reads the store
   * (bounded to `limit` messages, on the measured indexes).
   */
  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    const sessionId = this.sessionIdOf(dwarfId)
    if (sessionId === undefined || !this.knownSessionIds.has(sessionId)) return null

    const db = await this.sqlite.openReadOnly(this.dbPath)
    // The store vanished between the scan that published this id and this
    // read: an empty feed, never a throw (claudeProvider.ts's own precedent).
    if (db === null) return []

    const { messages, parts } = readOpenCodeMessages(db, sessionId, limit)
    const rows = this.redactedRows(messages, parts)
    return trimFeed(rows, limit)
  }

  /**
   * One page of conversation older than the panel's own oldest row (#364).
   * Composes the exported `cursorIndex` with `feedPageOf` directly, since
   * there is no byte-window walk here — the whole conversation (bounded by
   * `PAGE_READ_LIMIT`) is read in one query and the cursor is resolved
   * against the SAME redacted rows the panel already holds.
   */
  async feedPage(
    dwarfId: string,
    limit: number,
    before: FeedPageCursor
  ): Promise<FeedWindowRead | null> {
    const sessionId = this.sessionIdOf(dwarfId)
    if (sessionId === undefined || !this.knownSessionIds.has(sessionId)) return null

    const db = await this.sqlite.openReadOnly(this.dbPath)
    if (db === null) return { messages: [], reachedStart: true }

    const { messages, parts } = readOpenCodeMessages(db, sessionId, PAGE_READ_LIMIT)
    const rows = this.redactedRows(messages, parts)
    const at = cursorIndex(rows, before)
    if (at === -1) return { messages: [], reachedStart: true }

    const older = rows.slice(0, at)
    return { messages: feedPageOf(older, limit), reachedStart: textCount(older) <= limit }
  }

  /** `message` × `part` rows → redacted `FeedMessage[]`, the shape both `feed` and `feedPage` share. */
  private redactedRows(
    messages: Parameters<typeof openCodeFeedRows>[0],
    parts: Parameters<typeof openCodeFeedRows>[1]
  ): FeedMessage[] {
    return openCodeFeedRows(messages, parts).map((row) => ({
      ...row,
      text: redactSecrets(row.text)
    }))
  }

  /** No per-session file exists to tail — the panel pages its own feed instead. */
  transcriptPath(_dwarfId: string): string | undefined {
    return undefined
  }

  /** No pid-to-session join exists in this schema (Row 5) — no channel, ever. */
  textDelivery(_dwarfId: string): null {
    return null
  }
}
