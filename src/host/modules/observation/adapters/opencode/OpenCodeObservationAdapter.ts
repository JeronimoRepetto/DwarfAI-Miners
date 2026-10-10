// OpenCodeObservationAdapter (15 §5 OpenCode row; 16 §4.3 `ObservationAdapter`): the Host reads
// OpenCode sessions started outside DwarfAI from OpenCode's own store, `opencode.db` under
// `~/.local/share/opencode/` (`store.ts`), and never writes it (09 §1; FM-090; T-30).
//
// - One source: the database, read only through the read-only, WAL-merging snapshot of
//   `host/platform/sqlite/readOnlySnapshot.ts` (HR O1, R11; never in place, never `immutable`),
//   one snapshot per read so every query of it sees one commit. A busy store (the provider holds it,
//   or a commit is in flight) is read again next cycle, with no event and no warning.
// - A watermark cursor over the store's `time_updated` (`state.ts`), read with a short look-back,
//   so a row that committed after a read with an earlier stamp than that read's newest is not
//   lost; the rows already observed inside the look-back are remembered per stream and not
//   observed twice. After a Host restart they may be read once more, with the same keys
//   (ADR-006 item 2: the ingest drops them).
// - Identity: the session id; a child session is a subagent identity of its parent (ADR-015).
//   Entries by part id, usage by assistant message id, sealed when the message finishes.
// - Turn ends: none until spike S-021-2 passes (ADR-021 item 4; the record is partial), so no
//   `turn-ended` event is ever emitted; ISSUE-100 infers them (ADR-032 item 5).
// - No pid in the store (Row 2): `processIdentitySource` is `none`, so ending an observed OpenCode
//   session answers `no-identity` (or `protocol-error` through the person's server, SP-14).
// - Closing (owner amendment I, 2026-10-07; 13 FM-059 as amended): no row says a session ended, so
//   a session closes once it is quiet for 300 s (no changed message, no `session.time_updated`
//   movement) and two process listings 30 s apart show no OpenCode process in its folder
//   (`../base/processGone.ts`), or once the person archives it (`session.time_archived`). A closed
//   session resumed under its own id (`opencode --session`) is a new session,
//   `<session id>~resumed-<marker>`, derived from its message times and the ended-agents ledger
//   alone (`../base/generations.ts`): a Host restart derives the same identity, and its keys stay
//   the session's, so messages read again add no rows.
// - `lifetimeTotals` exposes each session's `session.tokens_*` for the coal backfill (09 §5.5,
//   ISSUE-077); they never travel as live usage.
//
// Candidate decision (21 §6): `src/main/providers/opencode/*` is replaced; the evidence is in
// `OpenCodeObservationAdapter.conformance.test.ts`.
import { createHash } from 'node:crypto'
import { SqliteInfrastructureError } from '../../../../kernel/domain/errors'
import type { ProviderId } from '../../../../kernel/domain/values'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { SqliteReader } from '../../../../kernel/ports/sqliteDatabase'
import type {
  ReadOnlySnapshot,
  ReadOnlySnapshotOpener
} from '../../../../platform/sqlite/readOnlySnapshot'
import type { ObservedCapabilities } from '../../../suppliers'
import type {
  Cursor,
  ObservationAdapter,
  ObservedEvent,
  SourceFile
} from '../../ports/observationAdapter'
import type { EndedAgentLedger } from '../../ports/endedAgentLedger'
import { nodeFileIdentity, type FileIdentifier } from '../base/fileIdentity'
import { generationAt, RecordTimeline } from '../base/generations'
import type { ProcessGoneWatch } from '../base/processGone'
import {
  CHANGED_MESSAGES_SQL,
  changedMessagesOf,
  factsOfBatch,
  LIFETIME_TOTALS_SQL,
  lifetimeTotalsOf,
  LOOKBACK_MS,
  MAX_CHANGED_SQL,
  maxChangedOf,
  messageTimesOf,
  messageTimesSql,
  partsSql,
  READ_LIMIT,
  SESSION_STATES_SQL,
  SESSIONS_SQL,
  sessionStatesOf,
  type OpenCodeLifetimeTotal,
  type SessionState
} from './state'
import { openCodeDbPath } from './store'

export { openCodeStoreRootOf } from './store'
export type { OpenCodeLifetimeTotal } from './state'

/**
 * What an observed OpenCode session can do, declared as data (HO-14; 15 §3 row O3); an omitted
 * field fails closed (ADR-009 D3). `sendTurn` stays omitted (U→no: no send path recorded). The
 * permission and question asks reach the Host only through the OpenCode plugin (EPIC-14), which is
 * not built: `permission` and `observedPermission` are `none` until it is (hidden until built).
 * `console` is `focus-terminal (→ log)` in 15 §3: with no verified pid there is nothing to focus.
 */
export const OPENCODE_OBSERVED_CAPABILITIES: ObservedCapabilities = Object.freeze({
  launch: false,
  observe: true,
  interrupt: false,
  permission: 'none',
  question: 'none',
  resume: 'none',
  adopt: false,
  turnEnd: 'none',
  reactionEvidence: 'transcript-match',
  subagents: 'transcript',
  usage: Object.freeze({ fidelity: 1, rateLimits: false }),
  mcpInjection: 'none',
  console: 'log',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
})

/** What a read answers (16 §4.3). */
type OpenCodeRead = Awaited<ReturnType<ObservationAdapter['read']>>

/** What `lifetimeTotals` answers: the totals, or why there are none this cycle. */
export type OpenCodeLifetimeTotals =
  | { kind: 'totals'; totals: OpenCodeLifetimeTotal[] }
  | { kind: 'retry-next-cycle' }
  | { kind: 'unavailable'; warning: string }

export interface OpenCodeObservationAdapterOptions {
  /** The OpenCode catalog id (the catalog's, passed in by the composition). */
  providerId: ProviderId
  /** `openCodeStoreRootOf(home)`, resolved by the composition root. */
  storeRoot: string
  /** `openReadOnlySnapshot` of `host/platform/sqlite` (R11). */
  openSnapshot: ReadOnlySnapshotOpener
  identify?: FileIdentifier
  /** Closes a quiet session whose OpenCode process is gone (owner amendment I); without it, only archiving does. */
  processWatch?: ProcessGoneWatch
  /** The ended-agents ledger (INV-36), for a resumed session's generation; or `useEndedLedger`. */
  ended?: Pick<EndedAgentLedger, 'has'>
}

/** The stems an OpenCode process carries (`opencode`, `opencode.exe`, `opencode-<target>`). */
export const OPENCODE_PROCESS_STEMS: readonly string[] = Object.freeze(['opencode'])

type Snapshotted<T> =
  { kind: 'ok'; value: T } | { kind: 'retry' } | { kind: 'failed'; code: string }

const RETRY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** The stream id without the generation suffix the loop adds after a rebuild (FM-087). */
function baseStreamId(streamId: string): string {
  return streamId.replace(/#\d+$/, '')
}

export class OpenCodeObservationAdapter implements ObservationAdapter {
  readonly providerId: ProviderId
  readonly cursorKind = 'watermark' as const
  /** Where a process identity for ending a session would come from: nowhere yet (15 §5). */
  readonly processIdentitySource = 'none' as const
  private readonly identify: FileIdentifier
  private readonly dbPath: string
  /** The store's newest change, while its files are unchanged. */
  private store: { key: string; fileIdentity: string; size: number } | null = null
  /** The rows each stream observed inside its look-back window, by stream id without generation. */
  private readonly recent = new Map<
    string,
    { value: number; seen: Map<string, number>; storeKey: string | undefined }
  >()
  /** Every session's row as the last changed read saw it (owner amendment I). */
  private states = new Map<string, SessionState>()
  /** Each session's message times; `complete` once read whole from the store. */
  private readonly timelines = new Map<string, { timeline: RecordTimeline; complete: boolean }>()
  /** The sessions whose closing generation is in the ledger, until they show activity again. */
  private readonly settled = new Set<string>()
  /** The sessions the last changed read saw archived for the first time this Host run. */
  private newlyArchived = new Set<string>()
  private ended: Pick<EndedAgentLedger, 'has'> | undefined

  constructor(private readonly options: OpenCodeObservationAdapterOptions) {
    this.providerId = options.providerId
    this.ended = options.ended
    this.identify = options.identify ?? nodeFileIdentity
    this.dbPath = openCodeDbPath(options.storeRoot)
  }

  capabilities(): ObservedCapabilities {
    return { ...OPENCODE_OBSERVED_CAPABILITIES }
  }

  /** The ended-agents ledger the observation module records closings in (bound by `host/wiring`). */
  useEndedLedger(ended: Pick<EndedAgentLedger, 'has'>): void {
    this.ended = ended
  }

  /** The store as a source, sized by its newest change; absent while it cannot be read. */
  async discover(fs: FileSystem): Promise<SourceFile[]> {
    const file = await this.identify(this.dbPath)
    if (file === null) {
      this.store = null
      return []
    }
    const db = await fs.stat(file.canonicalPath)
    const wal = await fs.stat(`${file.canonicalPath}-wal`)
    const key = JSON.stringify([file.fileIdentity, db?.size, db?.mtimeMs, wal?.size, wal?.mtimeMs])
    if (this.store?.key !== key) {
      const sized = await this.withSnapshot(file.canonicalPath, (reader) =>
        maxChangedOf(reader.all(MAX_CHANGED_SQL))
      )
      if (sized.kind === 'ok') {
        this.store = { key, fileIdentity: file.fileIdentity, size: sized.value }
      } else if (this.store?.fileIdentity !== file.fileIdentity) {
        // Busy or unreadable, and nothing known of this file yet: try again next cycle.
        return []
      }
      // Otherwise the size last read stands, and the key stays stale so the next cycle re-sizes.
    }
    return [
      {
        streamId: `${this.providerId}:db:${hash(file.canonicalPath)}`,
        adapterId: this.providerId,
        path: file.canonicalPath,
        fileIdentity: file.fileIdentity,
        size: this.store.size
      }
    ]
  }

  async read(source: SourceFile, from: Cursor | null): Promise<OpenCodeRead> {
    const start = from?.value ?? 0
    const at = (value: number): Cursor => ({
      adapterId: this.providerId,
      kind: 'watermark',
      value,
      fileIdentity: source.fileIdentity
    })
    const nothing: OpenCodeRead = { events: [], next: at(start), warnings: [] }
    const stream = baseStreamId(source.streamId)
    const kept = this.recent.get(stream)
    // Nothing was committed since this stream's last read: no query, no snapshot copy. The size
    // alone cannot tell, since a row that commits late is stamped below the watermark.
    const storeKey = this.store?.key
    if (from !== null && kept?.value === start && storeKey !== undefined) {
      if (kept.storeKey === storeKey)
        return { ...nothing, events: await this.closings(source.path) }
    }
    const seen = kept?.value === start ? kept.seen : new Map<string, number>()
    const result = await this.withSnapshot(source.path, (reader) => {
      const newest = maxChangedOf(reader.all(MAX_CHANGED_SQL))
      const changedSince = (since: number) =>
        changedMessagesOf(reader.all(CHANGED_MESSAGES_SQL, [since, since, READ_LIMIT]))
      let lower = Math.max(0, start - LOOKBACK_MS)
      let messages = changedSince(lower)
      // A look-back window full of rows already seen would hold the watermark still.
      if (messages.length === READ_LIMIT && messages[READ_LIMIT - 1]!.changed < start) {
        lower = start
        messages = changedSince(start)
      }
      // A bounded read stops at its last message; the rest follow next cycle (FM-088).
      const end = messages.length === READ_LIMIT ? messages[messages.length - 1]!.changed : newest
      const watermark = Math.max(start, end)
      const sessions = reader.all(SESSIONS_SQL, [lower, watermark])
      const ids = messages.map((m) => m.id)
      const parts = ids.length === 0 ? [] : reader.all(partsSql(ids.length), ids)
      const states = sessionStatesOf(reader.all(SESSION_STATES_SQL))
      for (const message of messages) this.timelineOf(message.sessionId).add(message.createdAt)
      const resumable = [...new Set(messages.map((m) => m.sessionId))].filter((id) =>
        this.hasEnded(id)
      )
      this.completeTimelines(reader, resumable)
      return {
        watermark,
        states,
        active: newestChangeBySession(messages.filter((m) => m.changed >= start)),
        facts: factsOfBatch({
          providerId: this.providerId,
          sessions,
          messages,
          parts,
          seen,
          generationOf: (sessionId, createdAt) => this.generationOf(sessionId, createdAt),
          folderOf: (sessionId) => states.get(sessionId)?.directory ?? null
        })
      }
    })
    if (result.kind === 'retry') return nothing
    if (result.kind === 'failed') {
      return { ...nothing, warnings: [`store unreadable (${result.code})`] }
    }

    const { watermark, facts } = result.value
    this.noteActivity(result.value.states, result.value.active)
    const floor = watermark - LOOKBACK_MS
    const remembered = new Map<string, number>()
    for (const [key, value] of seen) if (value >= floor) remembered.set(key, value)
    for (const { key, at: value } of facts.observed) if (value >= floor) remembered.set(key, value)
    this.recent.set(stream, { value: watermark, seen: remembered, storeKey })
    const closings = await this.closings(source.path)
    return { events: [...facts.events, ...closings], next: at(watermark), warnings: facts.warnings }
  }

  // ---------- closing and resuming (owner amendment I) ----------

  /** Whether the ledger holds this session id (INV-36). */
  private hasEnded(sessionId: string): boolean {
    return this.ended?.has({ providerId: this.providerId, providerSessionId: sessionId }) === true
  }

  /** A session's message times, kept for this Host run. */
  private timesOf(sessionId: string): { timeline: RecordTimeline; complete: boolean } {
    let times = this.timelines.get(sessionId)
    if (times === undefined) {
      times = { timeline: new RecordTimeline(), complete: false }
      this.timelines.set(sessionId, times)
    }
    return times
  }

  private timelineOf(sessionId: string): RecordTimeline {
    return this.timesOf(sessionId).timeline
  }

  /** Reads the whole message timeline of each session in `ids` not yet read whole. */
  private completeTimelines(reader: SqliteReader, ids: readonly string[]): void {
    const missing = ids.filter((id) => this.timelines.get(id)?.complete !== true)
    for (let n = 0; n < missing.length; n += READ_LIMIT) {
      const chunk = missing.slice(n, n + READ_LIMIT)
      const rows = reader.all(messageTimesSql(chunk.length), chunk)
      for (const { sessionId, at } of messageTimesOf(rows)) this.timelineOf(sessionId).add(at)
      for (const id of chunk) this.timesOf(id).complete = true
    }
  }

  /**
   * The session a message of `sessionId` created at `at` belongs to (`../base/generations.ts`): its
   * own id until that is in the ledger; then the generation its markers lead to.
   */
  private generationOf(sessionId: string, at: number): string {
    if (!this.hasEnded(sessionId)) return sessionId
    const markers = this.timelines.get(sessionId)?.timeline.markers() ?? []
    return generationAt(sessionId, markers, at, (id) => this.hasEnded(id))
  }

  /**
   * Activity (owner amendment I): a changed message of a session, or its row's `time_updated`
   * moving since the last read, as of when it changed (owner decision 2026-10-10): a session read
   * for the first time long after its last change is quiet since that change, not since now.
   */
  private noteActivity(states: Map<string, SessionState>, changed: Map<string, number>): void {
    const watch = this.options.processWatch
    // By session: when it last changed, or undefined when no time says (activity now).
    const active = new Map<string, number | undefined>(changed)
    for (const [id, state] of states) {
      const before = this.states.get(id)
      if (before === undefined || before.updated !== state.updated) {
        const at = state.updated ?? undefined
        const known = active.get(id)
        if (at !== undefined) active.set(id, known === undefined ? at : Math.max(known, at))
        else if (before !== undefined && !active.has(id)) active.set(id, undefined)
      }
      if (state.archivedAt !== null && before?.archivedAt !== state.archivedAt) {
        this.newlyArchived.add(id)
      }
    }
    for (const [id, at] of active) {
      watch?.active(id, at)
      this.settled.delete(id)
    }
    this.states = states
  }

  /**
   * The `closed` facts this read states (owner amendment I): for every session archived by the
   * person, or whose OpenCode process is gone (`../base/processGone.ts`), its current generation,
   * until the ledger holds it. A session that may have a resumed generation is named only once its
   * whole timeline is read; a busy store is tried again next read.
   */
  private async closings(path: string): Promise<ObservedEvent[]> {
    const watch = this.options.processWatch
    const due: Array<{ id: string; state: SessionState; archived: boolean }> = []
    // An archive is stated in the read that sees it; with the ledger bound, until it holds it.
    const newlyArchived = this.newlyArchived
    this.newlyArchived = new Set()
    for (const [id, state] of this.states) {
      if (this.settled.has(id)) continue
      const archived = state.archivedAt !== null
      if (archived) {
        if (newlyArchived.has(id) || this.ended !== undefined) due.push({ id, state, archived })
      } else if (watch !== undefined && (await watch.gone(id, state.directory))) {
        due.push({ id, state, archived })
      }
    }
    const unnamed = due.map((d) => d.id).filter((id) => this.hasEnded(id))
    if (unnamed.some((id) => this.timelines.get(id)?.complete !== true)) {
      await this.withSnapshot(path, (reader) => this.completeTimelines(reader, unnamed))
    }
    const out: ObservedEvent[] = []
    for (const { id, state, archived } of due) {
      if (this.hasEnded(id) && this.timelines.get(id)?.complete !== true) continue
      const sessionId = this.generationOf(id, Number.POSITIVE_INFINITY)
      if (this.hasEnded(sessionId)) {
        this.settled.add(id)
        continue
      }
      out.push({
        kind: 'closed',
        sourceEventId: archived ? 'archived' : 'process-gone',
        identity: { providerId: this.providerId, providerSessionId: sessionId },
        ...(state.directory === null ? {} : { cwd: state.directory }),
        at: archived ? (state.archivedAt as number) : (watch?.now() ?? state.updated ?? 0)
      })
    }
    return out
  }

  /** Every observed session's lifetime token total, for the coal backfill (09 §5.5). */
  async lifetimeTotals(source: SourceFile): Promise<OpenCodeLifetimeTotals> {
    const result = await this.withSnapshot(source.path, (reader) =>
      lifetimeTotalsOf(reader.all(LIFETIME_TOTALS_SQL), this.providerId)
    )
    if (result.kind === 'retry') return { kind: 'retry-next-cycle' }
    if (result.kind === 'failed') {
      return { kind: 'unavailable', warning: `store unreadable (${result.code})` }
    }
    return { kind: 'totals', totals: result.value }
  }

  /** Runs `use` on a fresh snapshot; a busy store is `retry`, never a warning (FM-090). */
  private async withSnapshot<T>(
    path: string,
    use: (reader: SqliteReader) => T
  ): Promise<Snapshotted<T>> {
    let snapshot: ReadOnlySnapshot
    try {
      snapshot = await this.options.openSnapshot(path)
    } catch {
      return { kind: 'failed', code: 'open-failed' }
    }
    if (snapshot.kind === 'retry-next-cycle') return { kind: 'retry' }
    if (snapshot.kind === 'unavailable') return { kind: 'failed', code: snapshot.code }
    try {
      return { kind: 'ok', value: use(snapshot.reader) }
    } catch (error) {
      if (error instanceof SqliteInfrastructureError && RETRY_CODES.has(error.code)) {
        return { kind: 'retry' }
      }
      const code = error instanceof SqliteInfrastructureError ? error.code : 'SQLITE_ERROR'
      return { kind: 'failed', code }
    } finally {
      snapshot.reader.close()
    }
  }
}

/** The newest change of each session among `messages`, by session id. */
function newestChangeBySession(
  messages: ReadonlyArray<{ sessionId: string; changed: number }>
): Map<string, number> {
  const newest = new Map<string, number>()
  for (const m of messages)
    newest.set(m.sessionId, Math.max(newest.get(m.sessionId) ?? m.changed, m.changed))
  return newest
}
