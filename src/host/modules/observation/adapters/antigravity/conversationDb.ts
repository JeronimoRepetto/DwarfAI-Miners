// Antigravity's conversations databases (15 §5 Antigravity row, AMENDMENT-13, OQ-81): the usage and
// model id of each generation, from `conversations/<conversationId>.db` under the three trees of
// `discovery.ts`. Plain SQLite, opened only through the read-only snapshot of `host/platform/sqlite`
// (FM-090, T-30): never in place, never `immutable` (the design reference's `immutable=1` open,
// `clidb.go:114-117`, is not taken).
//
// - `gen_metadata(idx, data)` holds one row per generation; `data` is plaintext protobuf with no
//   published schema (`protoWalk.ts`): the model id at field 1.19, usage at 1.17.2 (`1` uncached
//   input → `inputNet`, `2` cache write, `5` cache read, `9` reasoning, `10` output; each taken as
//   recorded, the last occurrence winning as protobuf merges).
// - One usage unit per generation: `unitKey` = `<conversationId>:gen:<idx>`, `fidelity` 1, no
//   provider time (the row carries none that is documented). Whether a row is final once written is
//   UNVERIFIED, so a unit is sealed, and only then emitted, when a higher `idx` exists or the
//   conversation is closed (ADR-006 item 6). The cursor is a watermark: the last `idx` emitted or
//   skipped; `SourceFile.size` of a database is its highest `idx`.
// - Drift (FM-068, INV-38): a blob that does not decode, or decodes without usage at 1.17.2, yields
//   no usage and one warning naming only its `idx`; a database without a readable `gen_metadata`
//   yields none and one warning per file state. The watermark passes a drifted row; nothing throws.
// - A database is a source only while `history.jsonl` names its conversation's workspace: without a
//   folder no dwarf can hold its ore, and a source that could only ever be held would be read every
//   cycle for nothing.
// - A busy file (the provider holds it) is read again next cycle, with no event and no warning.
//
// Design reference: `observer@a402217:internal/adapter/antigravity/clidb.go` (`decodeGenMetadata`
// :419-447, the per-generation loop :225-266) and `doc.go:12-60` (the three trees), Apache-2.0
// (20 §2.4): the field paths and the one-unit-per-generation rule; no code is copied.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SqliteInfrastructureError } from '../../../../kernel/domain/errors'
import type { ProviderId } from '../../../../kernel/domain/values'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { SqliteReader, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type {
  ReadOnlySnapshot,
  ReadOnlySnapshotOpener
} from '../../../../platform/sqlite/readOnlySnapshot'
import type { UsageObservationInput } from '../../../suppliers'
import type { Cursor, ObservedEvent, SourceFile } from '../../ports/observationAdapter'
import type { FileIdentifier } from '../base/fileIdentity'
import { conversationIdOfDbName, conversationsDirsOf } from './discovery'
import { sourceKeyOf } from './parse'
import { fieldsAt, UNDECODABLE, type ProtoField } from './protoWalk'

/** Whether the database has the table this reader is pinned to. */
export const GEN_TABLE_SQL =
  "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'gen_metadata'"

/** The highest generation: the size of the database source. */
export const GEN_MAX_SQL = 'SELECT MAX(idx) AS max_idx FROM gen_metadata'

/** The generations past a watermark, oldest first. */
export const GEN_SINCE_SQL = 'SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx'

const MODEL_PATH = [1, 19] as const
const USAGE_PATH = [1, 17, 2] as const
const TOKEN_FIELDS = { inputNet: 1, cacheWrite: 2, cacheRead: 5, reasoning: 9, output: 10 } as const

/** What one `gen_metadata` row is. */
export type Generation =
  | { kind: 'unit'; idx: number; modelId: string | null; tokens: UsageObservationInput['tokens'] }
  | { kind: 'drift'; idx: number }

function lastVarint(fields: ProtoField[]): number {
  let value = 0n
  for (const field of fields) if (field.kind === 'varint') value = field.value
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

function modelOf(blob: Uint8Array): string | null {
  const fields = fieldsAt(blob, MODEL_PATH)
  if (fields === UNDECODABLE) return null
  let model: string | null = null
  for (const field of fields) {
    if (field.kind !== 'bytes') continue
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(field.bytes)
      model = text === '' ? null : text
    } catch {
      model = null
    }
  }
  return model
}

/** One row of `gen_metadata`, decoded; drift when the blob is not the pinned format. */
export function generationOf(idx: number, data: unknown): Generation {
  if (!(data instanceof Uint8Array)) return { kind: 'drift', idx }
  const usage = fieldsAt(data, USAGE_PATH)
  if (usage === UNDECODABLE || !usage.some((field) => field.kind === 'bytes')) {
    return { kind: 'drift', idx }
  }
  const tokens = { inputNet: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const [name, field] of Object.entries(TOKEN_FIELDS)) {
    const found = fieldsAt(data, [...USAGE_PATH, field])
    if (found === UNDECODABLE) return { kind: 'drift', idx }
    tokens[name as keyof typeof tokens] = lastVarint(found)
  }
  return { kind: 'unit', idx, modelId: modelOf(data), tokens }
}

/** The `unitKey` of a generation (15 §5). */
export function unitKeyOf(conversationId: string, idx: number): string {
  return `${conversationId}:gen:${idx}`
}

/** The sealed usage observation of a generation. */
export function usageEventOf(
  providerId: ProviderId,
  conversationId: string,
  unit: Extract<Generation, { kind: 'unit' }>
): ObservedEvent {
  const eventId = `gen:${unit.idx}`
  return {
    kind: 'usage',
    sourceEventId: eventId,
    identity: { providerId, providerSessionId: conversationId },
    usage: {
      sourceKey: sourceKeyOf(providerId, conversationId, eventId),
      unitKey: unitKeyOf(conversationId, unit.idx),
      fidelity: 1,
      tokens: unit.tokens,
      sealed: true,
      providerTime: null
    }
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

type Query<T> = { kind: 'ok'; value: T } | { kind: 'retry' } | { kind: 'failed' }

const RETRY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])

/** One snapshot, `read` run on it, closed; a busy file is `retry`, never a warning (FM-090). */
async function onSnapshot<T>(
  open: ReadOnlySnapshotOpener,
  path: string,
  read: (reader: SqliteReader) => T
): Promise<Query<T>> {
  let snapshot: ReadOnlySnapshot
  try {
    snapshot = await open(path)
  } catch {
    return { kind: 'failed' }
  }
  if (snapshot.kind === 'retry-next-cycle') return { kind: 'retry' }
  if (snapshot.kind === 'unavailable') return { kind: 'failed' }
  try {
    return { kind: 'ok', value: read(snapshot.reader) }
  } catch (error) {
    if (error instanceof SqliteInfrastructureError && RETRY_CODES.has(error.code)) {
      return { kind: 'retry' }
    }
    return { kind: 'failed' }
  } finally {
    snapshot.reader.close()
  }
}

/** What the reader knows of one database file. */
interface DbState {
  conversationId: string
  /** The file's identity and the sizes and times of it and its WAL: a change means news. */
  key: string
  /** Its highest `idx`, or null when it has no readable `gen_metadata`. */
  maxIdx: number | null
  /** The file state whose drift was already counted. */
  warned: string | null
  /** The read that found nothing new: the same file state, cursor and closure read nothing again. */
  quiet: string | null
}

export interface ConversationDbReaderOptions {
  providerId: ProviderId
  geminiDir: string
  fs: FileSystem
  identify: FileIdentifier
  openSnapshot: ReadOnlySnapshotOpener
}

/** What a read answers (16 §4.3). */
export interface DbRead {
  events: ObservedEvent[]
  next: Cursor
  warnings: string[]
}

/** The conversations databases of the three trees, read from a watermark. */
export class ConversationDbReader {
  private readonly states = new Map<string, DbState>()
  /** The model id of every unit read this Host run (the suppliers catalog is EPIC-09's). */
  private readonly models = new Map<string, string | null>()

  constructor(private readonly options: ConversationDbReaderOptions) {}

  /** Whether `streamId` (without generation) is a database source of this reader. */
  owns(streamId: string): boolean {
    return streamId.startsWith(`${this.options.providerId}:db:`)
  }

  /** The conversation of a database source, or null for a stream this reader has not seen. */
  conversationOf(streamId: string): string | null {
    return this.states.get(streamId)?.conversationId ?? null
  }

  /** Every conversation whose database this reader has seen. */
  conversations(): string[] {
    return [...this.states.values()].map((state) => state.conversationId)
  }

  /** The model id a unit's generation recorded, or null. */
  modelIdOf(unitKey: string): string | null {
    return this.models.get(unitKey) ?? null
  }

  /** The databases of the conversations `observed` accepts, one source per file identity. */
  async discover(observed: (conversationId: string) => boolean): Promise<SourceFile[]> {
    const { fs, identify, providerId } = this.options
    const byIdentity = new Map<string, SourceFile>()
    for (const dir of conversationsDirsOf(this.options.geminiDir)) {
      let entries: Awaited<ReturnType<FileSystem['listDir']>>
      try {
        entries = await fs.listDir(dir)
      } catch {
        continue
      }
      for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isDirectory) continue
        const conversationId = conversationIdOfDbName(entry.name)
        if (conversationId === null || !observed(conversationId)) continue
        const file = await identify(join(dir, entry.name))
        if (file === null || byIdentity.has(file.fileIdentity)) continue
        const streamId = `${providerId}:db:${hash(file.canonicalPath)}`
        const state = await this.probe(streamId, conversationId, file)
        if (state === null) continue
        byIdentity.set(file.fileIdentity, {
          streamId,
          adapterId: providerId,
          path: file.canonicalPath,
          fileIdentity: file.fileIdentity,
          size: state.maxIdx ?? 0
        })
      }
    }
    return [...byIdentity.values()]
  }

  /**
   * The sealed units past the cursor. `closed`: the conversation is not running, so its newest
   * generation is final too.
   */
  async read(source: SourceFile, from: Cursor | null, closed: boolean): Promise<DbRead> {
    const start = from?.value ?? 0
    const at = (value: number): Cursor => ({
      adapterId: this.options.providerId,
      kind: 'watermark',
      value,
      fileIdentity: source.fileIdentity
    })
    const nothing: DbRead = { events: [], next: at(start), warnings: [] }
    const state = this.states.get(source.streamId.replace(/#\d+$/, ''))
    if (state === undefined) return nothing
    if (state.maxIdx === null) return this.driftOnce(state, nothing)
    if (source.size <= start) return nothing
    const quiet = JSON.stringify([state.key, start, closed])
    if (state.quiet === quiet) return nothing

    const result = await onSnapshot(this.options.openSnapshot, source.path, (reader) =>
      reader.all(GEN_SINCE_SQL, [start])
    )
    if (result.kind === 'retry') return nothing
    if (result.kind === 'failed') return this.driftOnce(state, nothing)
    const rows = result.value
      .map((row: SqliteRow) => ({ idx: asNumber(row['idx']), data: row['data'] }))
      .filter(
        (row): row is { idx: number; data: unknown } => row.idx !== undefined && row.idx > start
      )
    // The newest generation of a running conversation may still change: it waits for a later one.
    const sealed = closed ? rows : rows.slice(0, -1)
    const out: DbRead = { events: [], next: at(start), warnings: [] }
    for (const row of sealed) {
      const generation = generationOf(row.idx, row.data)
      if (generation.kind === 'drift') {
        out.warnings.push(`undecodable generation ${row.idx}`)
      } else {
        this.models.set(unitKeyOf(state.conversationId, row.idx), generation.modelId)
        out.events.push(usageEventOf(this.options.providerId, state.conversationId, generation))
      }
      out.next = at(Math.max(out.next.value, row.idx))
    }
    state.quiet = out.events.length === 0 && out.warnings.length === 0 ? quiet : null
    return out
  }

  /** One warning for a database with no readable `gen_metadata`, once per file state. */
  private driftOnce(state: DbState, nothing: DbRead): DbRead {
    if (state.warned === state.key) return nothing
    state.warned = state.key
    return { ...nothing, warnings: ['conversations database without a readable gen_metadata'] }
  }

  /** The state of a database file, re-read when it changed; null while it cannot be read yet. */
  private async probe(
    streamId: string,
    conversationId: string,
    file: { canonicalPath: string; fileIdentity: string }
  ): Promise<DbState | null> {
    const db = await this.options.fs.stat(file.canonicalPath)
    const wal = await this.options.fs.stat(`${file.canonicalPath}-wal`)
    const key = JSON.stringify([file.fileIdentity, db?.size, db?.mtimeMs, wal?.size, wal?.mtimeMs])
    const known = this.states.get(streamId)
    if (known?.key === key) return known
    const result = await onSnapshot(this.options.openSnapshot, file.canonicalPath, (reader) => {
      const table = asNumber(reader.all(GEN_TABLE_SQL)[0]?.['n']) ?? 0
      if (table === 0) return null
      return asNumber(reader.all(GEN_MAX_SQL)[0]?.['max_idx']) ?? 0
    })
    if (result.kind === 'retry') return known ?? null
    const state: DbState = {
      conversationId,
      key,
      maxIdx: result.kind === 'ok' ? result.value : null,
      warned: known?.warned ?? null,
      quiet: null
    }
    this.states.set(streamId, state)
    return state
  }
}
