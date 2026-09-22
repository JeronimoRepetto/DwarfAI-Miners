import { normalize } from 'node:path'
import type { FsLike } from '../../adapters/fsLike'
import type { SqliteLike } from '../../adapters/sqliteLike'
import { permissionInputLine } from '../../domain/permissionSummary'
import { redactSecrets } from '../../domain/redactSecrets'
import {
  dwarfSilenceWindowMs,
  type Dwarf,
  type DwarfPermissionRequest,
  type FeedMessage,
  type FeedPageCursor,
  type ProviderSnapshot,
  type WaitingReason
} from '../../domain/types'
import type { PendingAsk } from '../../opencodePermissions/openCodePermissionRegistry'
import { cursorIndex, feedPageOf, textCount, trimFeed, type FeedWindowRead } from '../feedWindow'
import type { Provider } from '../provider'
import { pollProfiler } from '../../runtime/perf'
import type { TextDeliveryTarget } from '../../textDelivery/port'
import { lastAssistantText, openCodeFeedRows, type OpenCodeMessage } from './parse'
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
 * Row 5), no transcript file (`transcriptPath` returns `undefined` — the
 * conversation lives as rows, not a file to tail).
 *
 * `textDelivery` is the one exception, since #534: a root session's own id
 * IS the join `opencode run --session <id>` needs, so it answers
 * `'opencode-run-continue'` for every root and stays `null` for a worker,
 * whose foreman hop is unmeasured and out of scope for that issue.
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
 * with `finish: 'stop'`. `waiting` was never reported from this heuristic
 * alone: no pending-permission evidence exists anywhere in THIS SCHEMA
 * (`docs/opencode-format.md`). AMENDED for #588 T4: a session with a pending
 * ask now reports `waiting` regardless of what D3's own signals say, because
 * the evidence for that comes from `OpenCodePermissionRegistry` — the
 * plugin's own push, never the store — and overrides D3 rather than joining
 * it. See `pendingPermissionField` below.
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
 * previous scan skips the READ — zero `openReadOnly` calls, the same idiom
 * `codexProvider.ts` uses for its own rollout files — and nothing else: the
 * generation is drawn again from the facts the last read left behind, with
 * the current clock, because `busy`'s stall guard and the silence windows
 * are measured against time and not against the store (#461). Republishing
 * the previous generation left a dwarf `working` and a finished worker on the
 * board for as long as nobody wrote a byte.
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
  /**
   * `OpenCodePermissionRegistry.askFor`'s answer for a session (#588 T4) —
   * the OpenCode plugin's own push, for the provider whose store carries no
   * pending-permission evidence of its own (see this class's D3 note above).
   *
   * Unlike claudeProvider.ts's `isPermissionPromptOpen`, this hands back the
   * ask itself rather than a boolean. Claude's hook only proves a dialog is
   * open and needs a second proof — the transcript's own unresolved
   * `tool_use` — to say what it asks; OpenCode's plugin event already names
   * the request whole (permission, command, patterns), so there is no
   * second, richer source in this store to confirm it against. The push IS
   * the evidence.
   */
  pendingPermission?: (sessionId: string) => PendingAsk | undefined
}

/**
 * Everything one full read learned about a session — the FACTS, kept apart
 * from the verdicts drawn from them (#461). Two verdicts depend on the clock
 * rather than on the store: `busy` (the stall guard, and D3's `seqAdvanced`
 * half on the one scan that saw the seq move) and retention. A scan on an
 * unchanged store runs no SQL (D2) but the clock has still moved, so it draws
 * both again from these rather than republishing the previous generation —
 * which is what left a finished dwarf `working` for as long as nobody wrote.
 */
interface SessionFacts {
  sessionId: string
  /** `session.directory`, normalized. Never '' — #166 drops that row before it gets here. */
  cwd: string
  parentSessionId?: string
  agent?: string
  modelId?: string
  /** `session.time_updated`. */
  updatedMs: number
  /** The newest `role: 'assistant'` row; absent while the session has not replied yet. */
  newest?: OpenCodeMessage
  /** Max `event.seq` at the last full read. */
  seq: number
  /**
   * When a scan last saw `seq` move — the stall clock for BUSY_WINDOW_MS.
   * First sight counts as a move: the guard has to start somewhere, and a
   * fresh instance cannot prove the seq stood still before it looked.
   */
  seqChangedAtMs: number
  /** Redacted newest assistant text — read only for a session still inside its silence window. */
  lastMessage?: string
  /**
   * This session's own `session.tokens_*` sum (#540), read straight through
   * from `OpenCodeSession.tokensUsed` — always a number, never absent, so a
   * session that has burned nothing stamps `tokensObserved: 0` rather than
   * omitting the field, exactly like `tokensUsed` itself (state.ts).
   */
  tokensUsed: number
  /**
   * `Dwarf.transcriptUpdatedAt` (#459): the newest of the three per-session
   * facts D3 names for liveness — `updatedMs`, the newest assistant row's own
   * time, `seqChangedAtMs` — and never lower than the value last published.
   * Never the WAL's mtime, which is store-wide and says nothing about WHICH
   * session moved; never the clock, which moves whether anyone wrote or not.
   */
  transcriptUpdatedAt: number
}

/** The newest assistant row's own time: completed once it has one, else created. */
function newestRowMs(facts: SessionFacts): number {
  return facts.newest?.timeCompletedMs ?? facts.newest?.timeCreatedMs ?? 0
}

/**
 * When this session was last known to move — per-session facts only. The
 * WAL's mtime is deliberately absent: one file for the whole store, so its
 * freshness proves writes somewhere, not which session (D3); it gates the
 * re-read cost above and must not keep a frozen dwarf alive (#444). The scan
 * that saw the seq move counts as now; a later scan on a quiet store does not,
 * and that is what lets a finished worker leave once its window has run (#461).
 */
function activityOf(facts: SessionFacts, seqAdvanced: boolean, nowMs: number): number {
  return Math.max(seqAdvanced ? nowMs : 0, newestRowMs(facts), facts.updatedMs)
}

/**
 * The registry's pending ask as a spreadable dwarf field, redacted (#588 T4).
 *
 * Field by field rather than by spreading the push, mirroring
 * claudeProvider.ts's own `pendingPermissionField` and for the same reason: a
 * field OpenCode's plugin starts sending later must not ride across
 * unredacted by being forgotten here.
 *
 * No foreman restriction, unlike that one's own guard: a Claude subagent
 * shares its foreman's sessionId, which is the trap `pendingPermissionField`
 * (claudeProvider.ts) and `stampPermissionPrompts` (permissionPrompts.ts)
 * both exist to avoid. An OpenCode session never does — `session.parent_id`
 * gives every session, root or worker, its own id (D4) — so the push's
 * `sessionId` already names exactly one dwarf and there is nothing here to
 * guard against.
 *
 * `waitingReason` travels with the card rather than being left to a second,
 * generic pass: unlike Claude's hook, which only proves a dialog is open and
 * needs `stampPermissionPrompts` to turn that into a cross-provider stamp,
 * this ask is the whole proof by itself, so the one function that reads it
 * sets both fields together.
 */
function pendingPermissionField(
  ask: PendingAsk | undefined,
  nowMs: number
): { pendingPermission?: DwarfPermissionRequest; waitingReason?: WaitingReason } {
  if (ask === undefined) return {}
  const summary: Record<string, unknown> = {}
  // Only the two fields buildOpenCodePermissionPush ever puts on the ask
  // (permissionPushPayload.ts) — never the whole push spread in, for the
  // reason this function's own doc gives.
  if (ask.command !== undefined) summary.command = ask.command
  if (ask.patterns !== undefined) summary.pattern = ask.patterns.join(', ')
  // Neither field present -- an edit/webfetch ask carries no command and no
  // patterns; only bash is ever measured carrying both (docs/opencode-format.
  // md), which is why this went unmeasured (#588 review F4). `summary` is
  // empty rather than merely lacking a NAMED field, so
  // `permissionInputLine({})` would fall all the way through
  // `namedSubject`/`summarizePermissionInput` to `JSON.stringify({})` — the
  // literal string "{}", which names nothing real. Omit the content rather
  // than invent it: the card still shows the tool name and channel, just
  // nothing underneath.
  const input = Object.keys(summary).length === 0 ? '' : permissionInputLine(summary)
  return {
    waitingReason: 'approval',
    pendingPermission: {
      // requestId, not callId: OpenCode's own permission.replied event names
      // the ask by requestID (permissionPushPayload.ts), so that is the id a
      // later answer will actually round-trip against, not the tool call's
      // own id.
      toolUseId: ask.requestId,
      toolName: ask.permission,
      input,
      // No answer route exists yet: #588 T5, which would reply to OpenCode's
      // own HTTP server, is unstarted. 'terminal' is still the honest
      // reading and not a claim of answerability this slice never built —
      // the dialog genuinely lives in a console this app only watches,
      // exactly what 'terminal' means (see DwarfPromptChannel), and
      // answerDwarfPermission's existing routing (runtime.ts) already
      // refuses it correctly today: OpenCodeProvider.textDelivery() never
      // returns a 'terminal'-kind endpoint (it returns
      // 'opencode-run-continue', or null for a worker), so
      // resolveKickDelivery finds nothing to type into and the card's click
      // answers CANNOT_REACH_TERMINAL rather than pretending to press a key.
      // The same honest-refusal shape codexProvider.ts's own pendingQuestion
      // comment already states for its own 'terminal' channel ("never
      // offered as answerable").
      channel: 'terminal',
      // OpenCode's own event carries no timestamp for when the ask was
      // raised (unlike Claude's transcript line, or Codex's rollout row) —
      // the moment this scan learned of it is the only honest clock there
      // is, exactly the fallback claudeProvider.ts's own askedAtFallback
      // reaches for when ITS better evidence wrote none.
      askedAt: new Date(nowMs).toISOString()
    }
  }
}

export class OpenCodeProvider implements Provider {
  readonly kind = 'opencode' as const

  private readonly fs: FsLike
  private readonly sqlite: SqliteLike
  private readonly dbPath: string
  private readonly walPath: string
  private readonly now: () => number
  private readonly pendingPermission: (sessionId: string) => PendingAsk | undefined

  /** Sizes at the previous scan; both unchanged skips the read, never the verdict (#461). */
  private lastDbSize: number | undefined
  private lastWalSize: number | undefined

  /**
   * sessionId -> what the last full read learned about it, for EVERY
   * non-archived session with a directory — including one already past its
   * silence window, so the seq it comes back with is compared against a
   * remembered one rather than counted as first sight.
   */
  private facts = new Map<string, SessionFacts>()
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
    this.pendingPermission = options.pendingPermission ?? (() => undefined)
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
    // D2 saves the READ, never the verdict (#461): nothing was written, so no
    // SQL runs and no seq can have advanced — but the clock moved, and the
    // stall guard and the silence windows are measured against it.
    if (unchanged) return this.publish(nowMs, new Set())

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
    const facts = new Map<string, SessionFacts>()
    const advanced = new Set<string>()

    for (const session of sessions) {
      // #166: an empty directory names no honest project, so the session is
      // dropped rather than placed under a phantom one.
      if (session.cwd === '') continue

      const seq = eventSeqs.get(session.sessionId) ?? 0
      const previous = this.facts.get(session.sessionId)
      const seqAdvanced = previous !== undefined && seq > previous.seq
      if (seqAdvanced) advanced.add(session.sessionId)

      const read: SessionFacts = {
        sessionId: session.sessionId,
        cwd: normalize(session.cwd),
        updatedMs: session.updatedMs,
        seq,
        seqChangedAtMs: seqAdvanced ? nowMs : (previous?.seqChangedAtMs ?? nowMs),
        transcriptUpdatedAt: 0,
        tokensUsed: session.tokensUsed
      }
      if (session.parentSessionId !== undefined) read.parentSessionId = session.parentSessionId
      if (session.agent !== undefined) read.agent = session.agent
      if (session.modelId !== undefined) read.modelId = session.modelId
      const newest = newestAssistant.get(session.sessionId)
      if (newest !== undefined) read.newest = newest
      read.transcriptUpdatedAt = Math.max(
        previous?.transcriptUpdatedAt ?? 0,
        read.updatedMs,
        newestRowMs(read),
        read.seqChangedAtMs
      )

      // The one per-session query. Not paid for a session already past its
      // window: publish() below will drop it before anyone reads the text.
      const role = this.roleOf(session.sessionId, session.parentSessionId)
      if (nowMs - activityOf(read, seqAdvanced, nowMs) <= dwarfSilenceWindowMs(role, 'unknown')) {
        const { messages, parts } = readOpenCodeMessages(
          db,
          session.sessionId,
          LAST_MESSAGE_READ_LIMIT
        )
        const lastMessage = redactSecrets(lastAssistantText(messages, parts))
        if (lastMessage !== undefined) read.lastMessage = lastMessage
      }
      facts.set(session.sessionId, read)
    }

    // Only reached on success (#12): a throwing scan leaves the previous
    // generation in place, and a concurrent feed() call mid-scan reads it
    // until every await above has resolved.
    this.facts = facts
    return this.publish(nowMs, advanced)
  }

  /**
   * Draw this scan's generation from the remembered facts with the clock as
   * it stands NOW — the pure half of scan(), and the whole of it on an
   * unchanged store. `advanced` names the sessions whose seq moved on THIS
   * read: D3's second busy half is true only on the scan that saw the write,
   * so a quiet store passes none and the row alone decides.
   */
  private publish(nowMs: number, advanced: ReadonlySet<string>): ProviderSnapshot[] {
    const knownSessionIds = new Set<string>()
    const snapshots: ProviderSnapshot[] = []

    for (const facts of this.facts.values()) {
      const seqAdvanced = advanced.has(facts.sessionId)
      const role = this.roleOf(facts.sessionId, facts.parentSessionId)
      const activityMs = activityOf(facts, seqAdvanced, nowMs)
      if (nowMs - activityMs > dwarfSilenceWindowMs(role, 'unknown')) continue

      const { newest } = facts
      const streaming = newest === undefined || newest.timeCompletedMs === undefined
      const intermediateStep =
        newest !== undefined && newest.timeCompletedMs !== undefined && newest.finish !== 'stop'
      const stalled = nowMs - facts.seqChangedAtMs >= BUSY_WINDOW_MS
      const busy = streaming || seqAdvanced || (intermediateStep && !stalled)

      // Whether OpenCode's own plugin has an ask open for this session (#588
      // T4) — read before status below, because a pending ask overrides D3's
      // busy/idle reading rather than joining it: a session cannot move until
      // a human decides, whatever the store's own rows currently say (see
      // pendingPermissionField and this class's D3 doc above).
      const ask = this.pendingPermission(facts.sessionId)
      const blockedOnApproval = ask !== undefined

      const dwarf: Dwarf = {
        id: `opencode:${facts.sessionId}`,
        provider: 'opencode',
        role,
        name: facts.agent ?? `opencode-${facts.sessionId.slice(0, 8)}`,
        status: blockedOnApproval ? 'waiting' : busy ? 'working' : 'waiting',
        sessionId: facts.sessionId,
        // D4: every case reports 'unknown' — stated explicitly (mirroring
        // claudeProvider.ts's own attendance field) rather than left to the
        // contract's absent-reads-as-'unknown' fallback, so design and code
        // agree out loud (#444).
        attendance: 'unknown',
        transcriptUpdatedAt: facts.transcriptUpdatedAt,
        // AMENDED for #540 (was omitted, DET-R5/#444): this session's own
        // row, never a parent's or a sum across the crew — a worker mines
        // exactly what its own session burned. Feeds observationsFrom/accrue
        // (domain/ledger.ts) with no new ledger code, the same path Claude
        // and Codex already credit through.
        tokensObserved: facts.tokensUsed,
        ...pendingPermissionField(ask, nowMs)
      }
      if (facts.modelId !== undefined) dwarf.model = facts.modelId
      if (facts.parentSessionId !== undefined) {
        dwarf.parentId = `opencode:${facts.parentSessionId}`
      }
      if (facts.lastMessage !== undefined) dwarf.lastMessage = facts.lastMessage

      knownSessionIds.add(facts.sessionId)
      snapshots.push({
        provider: 'opencode',
        sessionId: facts.sessionId,
        cwd: facts.cwd,
        status: blockedOnApproval ? 'waiting' : busy ? 'busy' : 'idle',
        dwarfs: [dwarf],
        updatedAt: activityMs
      })
    }

    this.knownSessionIds = knownSessionIds
    return snapshots
  }

  /** `'foreman'` for a root, or for any session ever observed as somebody's parent; `'worker'` otherwise. */
  private roleOf(sessionId: string, parentSessionId: string | undefined): 'foreman' | 'worker' {
    if (this.parentSessions.has(sessionId)) return 'foreman'
    return parentSessionId === undefined ? 'foreman' : 'worker'
  }

  /** A scan that found nothing to publish still counts as success: the generation swaps to empty. */
  private publishNothing(): ProviderSnapshot[] {
    this.facts = new Map()
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

  /**
   * The `opencode-run-continue` channel (#534), for every ROOT session this
   * scan knows about — launched by this panel or opened in a terminal,
   * since the join is the session id read from the store rather than a pid
   * (#231 stays intact; Row 5 is still true of pid-to-session joins, which
   * this is not one of).
   *
   * `facts.parentSessionId === undefined` rather than `role === 'foreman'`:
   * `roleOf` ALSO promotes a middle-tier worker to `'foreman'` once it
   * becomes somebody else's parent (D4), and that promoted worker must
   * still get no channel — `parentSessionId` is the one field this schema
   * carries that answers root-or-not on its own (see the topology tests).
   *
   * `directory` is `facts.cwd`, the same normalized value `scan()` already
   * grouped this session under — never a fresh read, and never the raw
   * backslash form M7 measured `session list --format json` to carry.
   */
  textDelivery(dwarfId: string): TextDeliveryTarget | null {
    const sessionId = this.sessionIdOf(dwarfId)
    if (sessionId === undefined) return null
    const facts = this.facts.get(sessionId)
    if (facts === undefined || facts.parentSessionId !== undefined) return null
    return { kind: 'opencode-run-continue', sessionId: facts.sessionId, directory: facts.cwd }
  }
}
