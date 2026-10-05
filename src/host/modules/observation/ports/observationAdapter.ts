// Driven port of observation (05 §3.3, 16 §4.3 `ObservationAdapter`): one adapter per provider,
// reading that provider's own files (15 §5). Type-only (05 §2.2).
//
// The interface below is 16 §4.3's, member for member. The types it names (`SourceFile`, `Cursor`,
// `ObservedEvent`) are not spelled out by the package (Package gap): they are defined here, by the
// module that owns the port, from what 15 §5, 09 §4.2 (`source_cursors`) and 08 §0 (the payloads
// of the observation events) require.
import type {
  FolderPath,
  Instant,
  ProviderId,
  ProviderIdentity
} from '../../../kernel/domain/values'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type {
  ConversationEntry,
  ObservedCapabilities,
  UsageObservationInput
} from '../../suppliers'

/** The stored kind of a stream position (09 §4.2 `source_cursors.kind`). */
export type CursorKind = 'byte-offset' | 'watermark' | 'none'

/**
 * A stream's position (06 §6.1 `SourceCursor`): bytes read for a file, the last row read for a
 * database, nothing for a source with no actions. It only moves forward (INV-35).
 */
export interface Cursor {
  /** The adapter that reads the stream (`source_cursors.adapter_id`). */
  adapterId: string
  kind: CursorKind
  /** `>= 0`; always `0` for `none`. */
  value: number
  /** The identity of the file the position belongs to, when the source is a file (FM-087). */
  fileIdentity: string | null
}

/** One stream the adapter found (15 §5 "Sources"), as `discover` reports it. */
export interface SourceFile {
  /** Stable for the same source across cycles and Host runs (ADR-006 item 2). */
  streamId: string
  adapterId: string
  /** Where the adapter reads it; never logged (ADR-026 item 4). */
  path: string
  /** Same file, same identity, whatever path reached it (FM-093); a replaced file has a new one. */
  fileIdentity: string
  /** Bytes, or rows for a database source; a value below the cursor means it shrank (FM-087). */
  size: number
}

interface ObservedRecord {
  /** Deterministic: the same record read twice has the same id (ADR-006 item 2, HO-37). */
  sourceEventId: string
  identity: ProviderIdentity
  /** The session's working folder, when the record carries it (Claude records do, `15` §5). */
  cwd?: FolderPath
}

/** What an adapter's `read` yields: the provider facts the loop turns into events (08 §2.3). */
export type ObservedEvent =
  | (ObservedRecord & {
      kind: 'session'
      cwd: FolderPath
      at: Instant
      parentIdentity?: ProviderIdentity
    })
  | (ObservedRecord & { kind: 'entries'; entries: ConversationEntry[] })
  | (ObservedRecord & { kind: 'usage'; usage: UsageObservationInput })
  | (ObservedRecord & { kind: 'activity'; at: Instant; activity: 'record' | 'turn-started' })
  | (ObservedRecord & { kind: 'closed'; at: Instant })

/** The kinds of `ObservedEvent`. */
export type ObservedEventKind = ObservedEvent['kind']

export interface ObservationAdapter {
  // one per provider; capability-declared (HO-14)
  readonly providerId: ProviderId
  readonly cursorKind: 'byte-offset' | 'watermark' | 'no-actions'
  capabilities(): ObservedCapabilities // ADR-009 D3: ObservedCapabilities = Partial<ProviderCapabilities>, declared as data (observedPermission, observedQuestion, turnEnd, console, …); omitted fields fail closed
  discover(fs: FileSystem): Promise<SourceFile[]>
  read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }>
  // events carry deterministic sourceEventId (ADR-006); malformed lines skipped, never fatal
}

/** The stored cursor kind of an adapter's declared `cursorKind` (09 §4.2: `no-actions` is `none`). */
export type StoredCursorKind<K extends ObservationAdapter['cursorKind']> = K extends 'no-actions'
  ? 'none'
  : K
