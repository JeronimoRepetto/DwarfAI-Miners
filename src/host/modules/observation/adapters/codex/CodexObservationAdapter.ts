// CodexObservationAdapter (15 §5 Codex row; 16 §4.3 `ObservationAdapter`, `TranscriptReader`):
// the Host reads Codex sessions started outside DwarfAI from Codex's own files under
// `CODEX_HOME` (default `~/.codex`, FM-091), and never writes them (09 §1; FM-090; T-30).
//
// Two kinds of source:
//
// - Rollouts, `sessions/**/rollout-*.jsonl`, read by the shared JSONL base (byte-offset cursor,
//   bounded tail reads, settle, root dispatch: `../base`). The base hands every line it consumes
//   to this adapter, which reads it in stream order (`parse.ts`): a stream's turns and lifetime
//   usage need the lines before it, so the state a read ends in is kept per stream at its cursor.
//   A read from a cursor with no kept state (a Host restart) rebuilds it from the look-back window
//   before the cursor; a turn that began before that window has no usage unit (a warning), and a
//   gated read (FM-088) starts a stream with its totals unknown.
// - The thread registry, `state_5.sqlite`, read through the read-only snapshot (FM-090) with a
//   watermark cursor (`state.ts`): one `session` fact per new, unarchived thread row. A busy file
//   is read again next cycle, with no event and no warning.
//
// Identity: the thread id (the registry row's, which a rollout's `session_meta` repeats; a rollout
// whose head is unreadable falls back to the id in its file name). Turn ends are reliable
// (`task_complete`, `turn_aborted`); the port has no observed kind for them yet, so they are
// returned by `readWithTurnEnds` beside the port's events, and `read` (the port) carries the rest.
// No pid is readable (`codexProvider.ts:700-706`): `processIdentitySource` is `none`, so ending an
// observed Codex session answers `no-identity` until spike S-014-1 (15 §5, ADR-014 item 2).
//
// Candidate decision (21 §6): `src/main/providers/codex/*` is replaced; the evidence is in
// `CodexObservationAdapter.conformance.test.ts`.
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { SqliteInfrastructureError } from '../../../../kernel/domain/errors'
import type { ProviderId } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
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
import type { ObservedSessionRef } from '../../ports/observedSessionStore'
import type { TranscriptEntry, TranscriptReader } from '../../ports/transcriptReader'
import { nodeFileIdentity, type FileIdentifier } from '../base/fileIdentity'
import {
  JsonlObservationAdapter,
  OBSERVATION_TAIL_GATE_BYTES,
  type JsonlLine
} from '../base/jsonlObservationAdapter'
import { splitTail } from '../base/tailRead'
import {
  entryOf,
  eventIdOf,
  parseRolloutLine,
  ROLLOUT_GAP,
  ROLLOUT_START,
  rolloutHeadOf,
  stepRollout,
  threadIdOfRolloutName,
  type CodexTurnEnd,
  type RolloutContext,
  type RolloutHead,
  type RolloutState
} from './parse'
import {
  CODEX_STATE_FILE,
  MAX_ROW_SQL,
  maxRowOf,
  sessionsOfThreadRows,
  THREADS_SINCE_SQL
} from './state'

export type { CodexTurnEnd } from './parse'

/** How far before a cursor a read with no kept stream state looks to rebuild it. */
export const CODEX_LOOKBACK_BYTES = OBSERVATION_TAIL_GATE_BYTES

/** The most read of a rollout's head to find its `session_meta` line. */
const HEAD_BYTES = 1024 * 1024

/**
 * What an observed Codex session can do, declared as data (HO-14; 15 §3 rows A/B X3); an omitted
 * field fails closed (ADR-009 D3). `sendTurn` stays omitted until the send path of ISSUE-167
 * exists (hidden until built), and `observedQuestion` is `none` although 15 §2.5 measured
 * `detected`: the port has no observed ask yet, so no question could reach the person.
 */
export const CODEX_OBSERVED_CAPABILITIES: ObservedCapabilities = Object.freeze({
  launch: false,
  observe: true,
  interrupt: false,
  permission: 'none',
  question: 'none',
  resume: 'none',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'transcript-match',
  subagents: 'none',
  usage: Object.freeze({ fidelity: 1, rateLimits: false }),
  mcpInjection: 'none',
  console: 'log',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
})

/** `CODEX_HOME` when the Host's environment sets it, else `~/.codex` (15 §5; FM-091, HO-09). */
export function codexHomeOf(
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string {
  const set = env['CODEX_HOME']
  return set !== undefined && set !== '' ? set : join(home, '.codex')
}

/** A read with the turn ends the port cannot carry yet. */
export interface CodexRead {
  events: ObservedEvent[]
  turnEnds: CodexTurnEnd[]
  next: Cursor
  warnings: string[]
}

export interface CodexObservationAdapterOptions {
  /** The Codex catalog id (the catalog's, passed in by the composition). */
  providerId: ProviderId
  /** `codexHomeOf(env, home)`, resolved by the composition root. */
  codexHome: string
  /** The other adapters' roots, for the longest-prefix dispatch (FM-093). */
  claimedRoots: readonly string[]
  fs: FileSystem
  clock: Clock
  /** `openReadOnlySnapshot` of `host/platform/sqlite` (R11). */
  openSnapshot: ReadOnlySnapshotOpener
  identify?: FileIdentifier
}

/** A stream's state at a byte offset: the end of the last read. */
interface Checkpoint {
  offset: number
  state: RolloutState
}

const RETRY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function baseStreamId(streamId: string): string {
  return streamId.replace(/#\d+$/, '')
}

function isRolloutName(name: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl')
}

export class CodexObservationAdapter implements ObservationAdapter, TranscriptReader {
  readonly providerId: ProviderId
  readonly cursorKind = 'byte-offset' as const
  /** Where a process identity for ending a session would come from: nowhere (ADR-014 item 2). */
  readonly processIdentitySource = 'none' as const
  private readonly rollouts: JsonlObservationAdapter
  private readonly identify: FileIdentifier
  private readonly statePath: string
  /** A rollout's head, by file identity. */
  private readonly heads = new Map<string, RolloutHead>()
  /** The head of each stream read, by stream id without generation, for window reads. */
  private readonly headOfStream = new Map<string, RolloutHead>()
  private readonly checkpoints = new Map<string, Checkpoint>()
  /** The lines the base consumes during the read in flight, by byte offset. */
  private reading: { streamId: string; lines: Map<number, string> } | null = null
  /** The registry's highest rowid, while its files are unchanged. */
  private registry: { key: string; maxRow: number } | null = null

  constructor(private readonly options: CodexObservationAdapterOptions) {
    this.providerId = options.providerId
    this.identify = options.identify ?? nodeFileIdentity
    this.statePath = join(options.codexHome, CODEX_STATE_FILE)
    this.rollouts = new JsonlObservationAdapter({
      providerId: options.providerId,
      capabilities: CODEX_OBSERVED_CAPABILITIES,
      roots: [join(options.codexHome, 'sessions')],
      claimedRoots: options.claimedRoots,
      matches: isRolloutName,
      parse: (line) => this.parseLine(line),
      fs: options.fs,
      clock: options.clock,
      identify: this.identify
    })
  }

  capabilities(): ObservedCapabilities {
    return { ...CODEX_OBSERVED_CAPABILITIES }
  }

  async discover(fs: FileSystem): Promise<SourceFile[]> {
    const rollouts = await this.rollouts.discover(fs)
    const registry = await this.registrySource()
    return registry === null ? rollouts : [registry, ...rollouts]
  }

  async read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }> {
    const { events, next, warnings } = await this.readWithTurnEnds(source, from)
    return { events, next, warnings }
  }

  /** `read`, with the stream's turn ends (ADR-021) that `ObservedEvent` has no kind for yet. */
  readWithTurnEnds(source: SourceFile, from: Cursor | null): Promise<CodexRead> {
    return this.isRegistry(source)
      ? this.readRegistry(source, from)
      : this.readRollout(source, from)
  }

  entries(
    ref: ObservedSessionRef,
    window: { before?: string; limit: number }
  ): Promise<TranscriptEntry[]> {
    return this.rollouts.entries(ref, window)
  }

  // ---------- rollouts ----------

  /**
   * The base's line parser. Stateless, so the base's window reads use it as well; during a read
   * it also hands the consumed line to `readRollout`, which reads the stream in order.
   */
  private parseLine(line: JsonlLine): ObservedEvent[] | null {
    const record = parseRolloutLine(line.text)
    if (record === null) return null
    // Keyed by offset: a window read of the same stream that interleaves with the read hands in
    // the same bytes at the same offsets, and `readRollout` keeps only its own range.
    if (this.reading?.streamId === line.streamId) this.reading.lines.set(line.offset, line.text)
    const head = this.headOfStream.get(baseStreamId(line.streamId))
    const sourceEventId = eventIdOf(record, line.text, line.offset)
    const entry = entryOf(
      record,
      head ?? { exec: false },
      `${this.providerId}:${line.streamId}:${sourceEventId}`
    )
    if (entry === null) return []
    // Only a window read uses these events, and only their entries: the read's own events come
    // from `stepRollout`, which knows the stream's head.
    return [
      {
        kind: 'entries',
        sourceEventId,
        identity: { providerId: this.providerId, providerSessionId: head?.threadId ?? '' },
        entries: [entry]
      }
    ]
  }

  private async readRollout(source: SourceFile, from: Cursor | null): Promise<CodexRead> {
    const start = from?.value ?? 0
    const nothing: CodexRead = {
      events: [],
      turnEnds: [],
      next: {
        adapterId: this.providerId,
        kind: 'byte-offset',
        value: start,
        fileIdentity: source.fileIdentity
      },
      warnings: []
    }
    const head = await this.headOf(source)
    if (head === 'pending') return nothing
    if (head === 'unknown') {
      // No thread id anywhere: nothing it holds can be attributed. Skipped once, with a warning.
      return {
        ...nothing,
        next: { ...nothing.next, value: Math.max(start, source.size) },
        warnings: ['rollout without a readable session head']
      }
    }
    this.headOfStream.set(baseStreamId(source.streamId), head)
    const context: RolloutContext = { providerId: this.providerId, streamId: source.streamId, head }
    let state = await this.stateAt(source, start, context)

    const reading = { streamId: source.streamId, lines: new Map<number, string>() }
    this.reading = reading
    let batch: Awaited<ReturnType<JsonlObservationAdapter['read']>>
    try {
      batch = await this.rollouts.read(source, from)
    } finally {
      this.reading = null
    }

    const lines = [...reading.lines]
      .filter(([offset]) => offset >= start && offset < batch.next.value)
      .sort(([a], [b]) => a - b)
    // A gated read began past the cursor (FM-088): what came before is unknown.
    if (lines.length > 0 && lines[0]![0] > start) state = ROLLOUT_GAP
    const out: CodexRead = {
      events: [],
      turnEnds: [],
      next: batch.next,
      warnings: [...batch.warnings]
    }
    for (const [offset, text] of lines) {
      const record = parseRolloutLine(text)
      if (record === null) continue
      const step = stepRollout(state, record, { text, offset }, context)
      state = step.state
      out.events.push(...step.events)
      out.turnEnds.push(...step.turnEnds)
      out.warnings.push(...step.warnings)
    }
    if (batch.next.value > start) {
      this.checkpoints.set(source.streamId, { offset: batch.next.value, state })
    }
    return out
  }

  /** The stream's state at byte `start`: kept from the last read, or rebuilt from before it. */
  private async stateAt(
    source: SourceFile,
    start: number,
    context: RolloutContext
  ): Promise<RolloutState> {
    if (start === 0) return ROLLOUT_START
    const kept = this.checkpoints.get(source.streamId)
    if (kept?.offset === start) return kept.state

    const fs = this.options.fs
    let text: string
    let readFrom: number
    try {
      if (start <= CODEX_LOOKBACK_BYTES) {
        // The whole stream before the cursor, whatever the file grows to meanwhile.
        text = await fs.readTextHead(source.path, start)
        readFrom = 0
      } else {
        const before = await fs.stat(source.path)
        if (before === null || before.size - start > OBSERVATION_TAIL_GATE_BYTES) return ROLLOUT_GAP
        const length = before.size - start + CODEX_LOOKBACK_BYTES
        text = await fs.readTextTail(source.path, length)
        const after = await fs.stat(source.path)
        if (after === null || after.size !== before.size) return ROLLOUT_GAP
        readFrom = before.size - length
      }
    } catch {
      return ROLLOUT_GAP
    }
    const tail = splitTail(text, readFrom, readFrom > 0)
    let state = readFrom === 0 ? ROLLOUT_START : ROLLOUT_GAP
    for (const line of tail.lines) {
      if (line.offset >= start) break
      const record = parseRolloutLine(line.text)
      if (record !== null) state = stepRollout(state, record, line, context).state
    }
    return state
  }

  /** The rollout's head: its `session_meta`, else the thread id of its file name. */
  private async headOf(source: SourceFile): Promise<RolloutHead | 'pending' | 'unknown'> {
    const known = this.heads.get(source.fileIdentity)
    if (known !== undefined) return known
    let text: string
    try {
      text = await this.options.fs.readTextHead(source.path, HEAD_BYTES)
    } catch {
      return 'pending'
    }
    const newline = text.indexOf('\n')
    if (newline < 0 && Buffer.byteLength(text) < HEAD_BYTES) return 'pending'
    const first = newline < 0 ? null : parseRolloutLine(text.slice(0, newline).replace(/\r$/, ''))
    let head = first === null ? null : rolloutHeadOf(first)
    if (head === null) {
      const threadId = threadIdOfRolloutName(basename(source.path))
      if (threadId === null) return 'unknown'
      head = { threadId, cwd: null, at: null, parentThreadId: null, exec: false }
    }
    this.heads.set(source.fileIdentity, head)
    return head
  }

  // ---------- the thread registry ----------

  private isRegistry(source: SourceFile): boolean {
    return source.streamId.startsWith(`${this.providerId}:state:`)
  }

  /** The registry as a source, sized by its highest rowid; absent while it cannot be read. */
  private async registrySource(): Promise<SourceFile | null> {
    const file = await this.identify(this.statePath)
    if (file === null) return null
    const db = await this.options.fs.stat(file.canonicalPath)
    const wal = await this.options.fs.stat(`${file.canonicalPath}-wal`)
    const key = JSON.stringify([file.fileIdentity, db?.size, db?.mtimeMs, wal?.size, wal?.mtimeMs])
    if (this.registry?.key !== key) {
      const rows = await this.query(file.canonicalPath, MAX_ROW_SQL, [])
      if (rows.kind !== 'rows') return null
      this.registry = { key, maxRow: maxRowOf(rows.rows) }
    }
    return {
      streamId: `${this.providerId}:state:${hash(file.canonicalPath)}`,
      adapterId: this.providerId,
      path: file.canonicalPath,
      fileIdentity: file.fileIdentity,
      size: this.registry.maxRow
    }
  }

  private async readRegistry(source: SourceFile, from: Cursor | null): Promise<CodexRead> {
    const start = from?.value ?? 0
    const at = (value: number): Cursor => ({
      adapterId: this.providerId,
      kind: 'watermark',
      value,
      fileIdentity: source.fileIdentity
    })
    const nothing: CodexRead = { events: [], turnEnds: [], next: at(start), warnings: [] }
    if (source.size <= start) return nothing
    const result = await this.query(source.path, THREADS_SINCE_SQL, [start])
    if (result.kind === 'retry') return nothing
    if (result.kind === 'failed') return { ...nothing, warnings: [result.warning] }
    const read = sessionsOfThreadRows(result.rows, start, this.providerId)
    return { events: read.events, turnEnds: [], next: at(read.watermark), warnings: read.warnings }
  }

  /** One query on a fresh snapshot; a busy file is `retry`, never a warning (FM-090). */
  private async query(
    path: string,
    sql: string,
    params: readonly number[]
  ): Promise<
    { kind: 'rows'; rows: SqliteRow[] } | { kind: 'retry' } | { kind: 'failed'; warning: string }
  > {
    let snapshot: ReadOnlySnapshot
    try {
      snapshot = await this.options.openSnapshot(path)
    } catch {
      return { kind: 'failed', warning: 'state database could not be opened' }
    }
    if (snapshot.kind === 'retry-next-cycle') return { kind: 'retry' }
    if (snapshot.kind === 'unavailable') {
      return { kind: 'failed', warning: `state database unavailable (${snapshot.code})` }
    }
    try {
      return { kind: 'rows', rows: snapshot.reader.all(sql, params) }
    } catch (error) {
      if (error instanceof SqliteInfrastructureError && RETRY_CODES.has(error.code)) {
        return { kind: 'retry' }
      }
      const code = error instanceof SqliteInfrastructureError ? error.code : 'SQLITE_ERROR'
      return { kind: 'failed', warning: `state database query failed (${code})` }
    } finally {
      snapshot.reader.close()
    }
  }
}
