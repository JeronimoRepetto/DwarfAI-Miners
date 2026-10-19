// `ProviderHistoryScanner` (16 §4.10 `HistoricalUsageScanner`; 05 §3.10; 09 §5.5): the coal
// backfill's own bounded scan of the history providers left on disk, read-only, never through
// `source_cursors` (09 §5.5 "Independent of cursors"). Provider files are read through the kernel
// `FileSystem` and the OpenCode store through the read-only snapshot (15 §5; FM-090), never written.
//
// Scan units, in order, each finished whole before it is yielded:
//
// - Claude: one unit per project directory `<root>/projects/<dir>` of every configured root
//   (CLAUDE_CONFIG_DIRS, else `CLAUDE_CONFIG_DIR`, HO-09). Each top-level `*.jsonl` transcript is read by its bounded tail
//   (`CLAUDE_TAIL_BYTES`) and yields per-unit records keyed by the live `unitKey`, the assistant
//   `message.id` (15 §5 Claude row; ADR-006 item 4): the last row of a message wins (its final
//   stop-state row, HR O4), its tokens are the four usage fields added together, its provider time
//   the row's timestamp and its folder the row's own `cwd` (the directory name is a lossy encoding,
//   never decoded). Subagent transcripts one level down are not read (as at `0bfd108`).
// - Codex: one unit per day directory `sessions/YYYY/MM/DD` of `CODEX_HOME`. A rollout's bounded
//   tail holds only its running `total_token_usage`, so each rollout is a lifetime-total stream
//   `coal:<threadId>` (09 §5.5) whose newest record time is the latest timestamp of its tail; the
//   thread id and folder come from the head's `session_meta`. Its tokens are
//   `input + output + cache_write`, the same sum as the live per-turn units add up to (`inputNet`
//   is net of `cached`, `output` net of `reasoning`; `observation/adapters/codex/parse.ts`).
// - OpenCode: the store `opencode.db` is one unit (one file on the budget); each non-archived
//   session row is a lifetime-total stream `coal:<sessionId>` of its five `tokens_*` columns, its
//   newest record time `time_updated`. A store that does not exist is no unit; a busy or
//   unreadable one is an unreadable unit (read again at a later run).
//
// Antigravity's history (`conversations/*.db`, AMENDMENT-13) is not scanned yet: its usage reader
// arrives with its observation adapter (cut 3e); until then its history pays no coal.
//
// Only records strictly before `before` whose folder resolves to a mine (`resolveMine`, the mines
// module's resolution with the worktree fold, composed by `host/main.ts`) are yielded; a lifetime
// stream that straddles `before` yields nothing (the honest-floor rule). The per-boot budget
// (09 §5.5) is checked between units and never before the first, so every run records progress;
// `maxFilesPerDir` bounds one unit. A unit any of whose files cannot be read is yielded as
// `unreadable` with a fixed code, never a path or content (ADR-026 item 4).
//
// Candidate decision (21 §6): `src/main/ledger/coalBackfill.ts` and `coalScan.ts` are replaced: they
// credit one lifetime figure per session and project with no `unit_key` (the last Claude usage
// block stands for the whole session), keep their progress in a JSON marker written after the run
// and capture the install moment themselves. Their format knowledge (tail sizes, the `session_meta`
// head, the `token_count` total, the OpenCode `tokens_*` columns, the budgets and the
// between-units budget rule) is reimplemented here; their tests still pass on the legacy code.
import { join } from 'node:path'
import type { FolderPath, Instant, MineId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { ReadOnlySnapshotOpener } from '../../../platform/sqlite/readOnlySnapshot'
import { coalStreamKey } from '../domain/coalBoundary'
import type {
  HistoricalUsage,
  HistoricalUsageRecord,
  HistoricalUsageScanner,
  ScanBudget
} from '../ports/historicalUsageScanner'

/** Bytes read from the end of a Claude transcript (transplanted). */
export const CLAUDE_TAIL_BYTES = 64 * 1024
/** Bytes read from the start of a Codex rollout, where `session_meta` lives (transplanted). */
export const CODEX_HEAD_BYTES = 16 * 1024
/** Bytes read from the end of a Codex rollout, for its last `token_count` (transplanted). */
export const CODEX_TAIL_BYTES = 128 * 1024

const ROLLOUT = /^rollout-.*\.jsonl$/
const YEAR = /^\d{4}$/
const MONTH_OR_DAY = /^\d{2}$/

export interface ProviderHistoryScannerDeps {
  fs: FileSystem
  /** The run's time budget is measured on it. */
  clock: Clock
  /** `openReadOnlySnapshot` of `host/platform/sqlite` (R11). */
  openSnapshot: ReadOnlySnapshotOpener
  /** Claude config roots, home-expanded (CLAUDE_CONFIG_DIRS, else `CLAUDE_CONFIG_DIR`, HO-09). */
  claudeRoots: readonly string[]
  /** `CODEX_HOME`, home-expanded; null when Codex is not scanned. */
  codexHome: string | null
  /** The OpenCode store root (the folder of `opencode.db`); null when OpenCode is not scanned. */
  opencodeStoreRoot: string | null
  /** The mine a folder belongs to (worktree fold included), or null for a folder that is no mine. */
  resolveMine(folder: FolderPath): Promise<MineId | null>
}

type Provider = 'claude' | 'codex' | 'opencode'

interface ScanUnit {
  provider: Provider
  /** The directory, or the store file for OpenCode. */
  path: string
}

/** One record read from a provider file, before its folder is resolved to a mine. */
interface RawRecord {
  unitKey: string
  span: 'unit' | 'lifetime'
  folder: string
  tokens: number
  providerTime: Instant
}

type UnitRead =
  { ok: true; records: RawRecord[]; files: number } | { ok: false; errCode: string; files: number }

/** A unit any of whose files could not be read. */
class UnreadableUnit extends Error {
  constructor(
    readonly errCode: string,
    readonly files: number
  ) {
    super(errCode)
  }
}

export class ProviderHistoryScanner implements HistoricalUsageScanner {
  constructor(private readonly deps: ProviderHistoryScannerDeps) {}

  async *scan(
    before: Instant,
    budget: ScanBudget,
    signal: AbortSignal
  ): AsyncIterable<HistoricalUsage> {
    const { clock } = this.deps
    const startedAt = clock.now()
    const mines = new Map<string, Promise<MineId | null>>()
    const mineOf = (folder: string) => {
      let found = mines.get(folder)
      if (found === undefined) {
        found = this.deps.resolveMine(folder as FolderPath)
        mines.set(folder, found)
      }
      return found
    }
    let filesRead = 0
    for (const unit of await this.units()) {
      if (signal.aborted) return
      const scanUnit = `${unit.provider}:${unit.path}`
      if (budget.finishedScanUnits.has(scanUnit)) continue
      // Between units, never before the first: a run that records nothing never finishes.
      if (
        filesRead > 0 &&
        (filesRead >= budget.maxFiles || clock.now() - startedAt >= budget.maxDurationMs)
      ) {
        yield { kind: 'budget-reached' }
        return
      }
      const read = await this.read(unit, before, budget.maxFilesPerDir)
      if (read === null) continue
      filesRead += read.files
      if (signal.aborted) return
      if (!read.ok) {
        yield { kind: 'unreadable', scanUnit, adapterId: unit.provider, errCode: read.errCode }
        continue
      }
      const records: HistoricalUsageRecord[] = []
      for (const raw of read.records) {
        if (raw.providerTime >= before) continue
        const mineId = await mineOf(raw.folder)
        if (mineId === null) continue
        const { unitKey, span, tokens, providerTime } = raw
        records.push({ unitKey, span, mineId, tokens, providerTime })
      }
      if (signal.aborted) return
      yield { kind: 'scanned', scanUnit, adapterId: unit.provider, records }
    }
  }

  /** Every scan unit, in a stable order: Claude projects, Codex days, the OpenCode store. */
  private async units(): Promise<ScanUnit[]> {
    const { fs } = this.deps
    const units: ScanUnit[] = []
    for (const root of this.deps.claudeRoots) {
      const projects = join(root, 'projects')
      for (const entry of sorted(await fs.listDir(projects))) {
        if (entry.isDirectory) units.push({ provider: 'claude', path: join(projects, entry.name) })
      }
    }
    const codexHome = this.deps.codexHome
    if (codexHome !== null) {
      const sessions = join(codexHome, 'sessions')
      for (const year of await subdirs(fs, sessions, YEAR)) {
        for (const month of await subdirs(fs, year, MONTH_OR_DAY)) {
          for (const day of await subdirs(fs, month, MONTH_OR_DAY)) {
            units.push({ provider: 'codex', path: day })
          }
        }
      }
    }
    const storeRoot = this.deps.opencodeStoreRoot
    if (storeRoot !== null)
      units.push({ provider: 'opencode', path: join(storeRoot, 'opencode.db') })
    return units
  }

  /** One unit's records; null for an OpenCode store that does not exist. */
  private async read(unit: ScanUnit, before: Instant, maxFiles: number): Promise<UnitRead | null> {
    if (unit.provider === 'opencode') return this.readStore(unit.path)
    try {
      const records: RawRecord[] = []
      const files = await this.filesOf(unit, maxFiles)
      let read = 0
      for (const file of files) {
        read += 1
        try {
          records.push(...(await this.readFile(unit.provider, file, before)))
        } catch {
          throw new UnreadableUnit('read-failed', read)
        }
      }
      return { ok: true, records, files: read }
    } catch (error) {
      if (error instanceof UnreadableUnit)
        return { ok: false, errCode: error.errCode, files: error.files }
      return { ok: false, errCode: 'list-failed', files: 0 }
    }
  }

  private async filesOf(unit: ScanUnit, maxFiles: number): Promise<string[]> {
    const matches = (name: string) =>
      unit.provider === 'claude' ? name.endsWith('.jsonl') : ROLLOUT.test(name)
    return sorted(await this.deps.fs.listDir(unit.path))
      .filter((entry) => !entry.isDirectory && matches(entry.name))
      .slice(0, maxFiles)
      .map((entry) => join(unit.path, entry.name))
  }

  private async readFile(provider: Provider, path: string, before: Instant): Promise<RawRecord[]> {
    const { fs } = this.deps
    if (provider === 'claude') return claudeRecords(await fs.readTextTail(path, CLAUDE_TAIL_BYTES))
    const head = await fs.readTextHead(path, CODEX_HEAD_BYTES)
    const tail = await fs.readTextTail(path, CODEX_TAIL_BYTES)
    const stream = codexStream(head, tail)
    // A stream whose newest record is not before the moment straddles it: no coal (09 §5.5).
    return stream === null || stream.providerTime >= before ? [] : [stream]
  }

  private async readStore(location: string): Promise<UnitRead | null> {
    const snapshot = await this.deps.openSnapshot(location)
    if (snapshot.kind === 'unavailable' && snapshot.code === 'not-found') return null
    if (snapshot.kind !== 'open') return { ok: false, errCode: snapshot.code, files: 1 }
    try {
      return {
        ok: true,
        records: opencodeStreams(snapshot.reader.all(OPENCODE_SESSIONS)),
        files: 1
      }
    } catch {
      return { ok: false, errCode: 'query-failed', files: 1 }
    } finally {
      snapshot.reader.close()
    }
  }
}

function sorted<T extends { name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The subdirectories of `dir` whose names match `shape` (a date part), as paths. */
async function subdirs(fs: FileSystem, dir: string, shape: RegExp): Promise<string[]> {
  return sorted(await fs.listDir(dir))
    .filter((entry) => entry.isDirectory && shape.test(entry.name))
    .map((entry) => join(dir, entry.name))
}

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function instant(value: unknown): Instant | null {
  const text = asString(value)
  if (text === null) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : null
}

/**
 * The JSON records of a bounded slice. A tail starts and a head ends mid-line: such a line does
 * not parse and is skipped, as is any other line that is not a JSON object.
 */
function jsonRecords(slice: string): Rec[] {
  const records: Rec[] = []
  for (const line of slice.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const record = asRecord(JSON.parse(line))
      if (record !== null) records.push(record)
    } catch {
      // A partial line at the slice's edge, or not JSON.
    }
  }
  return records
}

const CLAUDE_USAGE = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
] as const

/** Per-unit records of a Claude tail: the last row of each assistant `message.id` wins. */
function claudeRecords(tail: string): RawRecord[] {
  const units = new Map<string, RawRecord>()
  for (const record of jsonRecords(tail)) {
    if (record['type'] !== 'assistant') continue
    const message = asRecord(record['message'])
    const unitKey = asString(message?.['id'])
    const usage = asRecord(message?.['usage'])
    const folder = asString(record['cwd'])
    const providerTime = instant(record['timestamp'])
    if (unitKey === null || usage === null || folder === null || providerTime === null) continue
    const tokens = CLAUDE_USAGE.reduce((sum, field) => sum + count(usage[field]), 0)
    units.delete(unitKey)
    if (tokens > 0) units.set(unitKey, { unitKey, span: 'unit', folder, tokens, providerTime })
  }
  return [...units.values()]
}

/** A Codex rollout as one lifetime-total stream, or null when its slices prove nothing. */
function codexStream(head: string, tail: string): RawRecord | null {
  let threadId: string | null = null
  let folder: string | null = null
  for (const record of jsonRecords(head)) {
    if (record['type'] !== 'session_meta') continue
    const payload = asRecord(record['payload'])
    threadId = asString(payload?.['id'])
    folder = asString(payload?.['cwd'])
    break
  }
  if (threadId === null || folder === null) return null
  let tokens: number | null = null
  let newest: Instant | null = null
  for (const record of jsonRecords(tail)) {
    const at = instant(record['timestamp'])
    if (at !== null && (newest === null || at > newest)) newest = at
    const payload = asRecord(record['payload'])
    if (record['type'] !== 'event_msg' || payload?.['type'] !== 'token_count') continue
    const total = asRecord(asRecord(payload['info'])?.['total_token_usage'])
    if (total === null) continue
    tokens =
      count(total['input_tokens']) +
      count(total['output_tokens']) +
      count(total['cache_write_input_tokens'])
  }
  if (tokens === null || tokens === 0 || newest === null) return null
  return {
    unitKey: coalStreamKey(threadId),
    span: 'lifetime',
    folder,
    tokens,
    providerTime: newest
  }
}

const OPENCODE_SESSIONS =
  'SELECT id, directory, time_updated, tokens_input, tokens_output, tokens_reasoning, ' +
  'tokens_cache_read, tokens_cache_write FROM session WHERE time_archived IS NULL'

/** Each OpenCode session as one lifetime-total stream (its five `tokens_*` columns). */
function opencodeStreams(rows: Rec[]): RawRecord[] {
  const streams: RawRecord[] = []
  for (const row of rows) {
    const id = asString(row['id'])
    const folder = asString(row['directory'])
    const updated = row['time_updated']
    if (id === null || folder === null || typeof updated !== 'number') continue
    const tokens =
      count(row['tokens_input']) +
      count(row['tokens_output']) +
      count(row['tokens_reasoning']) +
      count(row['tokens_cache_read']) +
      count(row['tokens_cache_write'])
    if (tokens === 0) continue
    streams.push({
      unitKey: coalStreamKey(id),
      span: 'lifetime',
      folder,
      tokens,
      providerTime: updated
    })
  }
  return streams
}
