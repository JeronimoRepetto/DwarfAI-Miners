// The ObservedSessionStore double (16 §4.3 `InMemory*`, §2.8). Never imported by production code
// (R14). It runs `runObservedSessionStoreContract` like `SqliteObservedSessionStore`. The dwarfs it
// indexes are crew's: the test hands it a `BoundDwarfs` read, as the SQLite store reads `dwarfs`.
// A test's transaction rolls it back through `snapshot` / `restore`. Type-only imports (05 R2).
import type {
  DwarfId,
  FolderPath,
  Instant,
  ProviderIdentity
} from '../../../../kernel/domain/values'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type {
  ObservedSession,
  ObservedSessionStore,
  ObservedSessionStream
} from '../observedSessionStore'

/** The dwarf bound to an identity, as crew stored it (`dwarfs` and its mine's folder). */
export interface BoundDwarf {
  dwarfId: DwarfId
  folder: FolderPath
  arrivedAt: Instant
  departedAt: Instant | null
}

/** Crew's side of the index: the dwarf bound to an identity, or null. */
export interface BoundDwarfs {
  bound(i: ProviderIdentity): BoundDwarf | null
}

interface Rows {
  sessions: ObservedSession[]
  streams: ObservedSessionStream[]
}

export class InMemoryObservedSessionStore implements ObservedSessionStore {
  private rows: Rows = { sessions: [], streams: [] }
  /** Every write, in order, for tests that check what a cycle wrote. */
  readonly writes: Array<'save' | 'saveStream'> = []

  constructor(
    private readonly scope: TransactionScope,
    private readonly dwarfs: BoundDwarfs
  ) {}

  byIdentity(i: ProviderIdentity): ObservedSession | null {
    const dwarf = this.dwarfs.bound(i)
    if (dwarf === null) return null
    const row = this.rows.sessions.find((s) => s.dwarfId === dwarf.dwarfId)
    if (row === undefined) {
      return {
        identity: { ...i },
        dwarfId: dwarf.dwarfId,
        cwd: dwarf.folder,
        firstSeenAt: dwarf.arrivedAt,
        lastRecordAt: dwarf.arrivedAt,
        closedAt: dwarf.departedAt
      }
    }
    return { ...row, identity: { ...row.identity }, closedAt: row.closedAt ?? dwarf.departedAt }
  }

  save(s: ObservedSession): void {
    this.inside('save')
    // One row per session (the dwarf's id is the key, as `observed_sessions.dwarf_id` is).
    const others = this.rows.sessions.filter((row) => row.dwarfId !== s.dwarfId)
    this.rows.sessions = [...others, { ...s, identity: { ...s.identity } }]
  }

  streams(sessionId: string): ObservedSessionStream[] {
    return this.rows.streams
      .filter((s) => s.dwarfId === sessionId)
      .sort((a, b) => (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0))
      .map((s) => ({ ...s }))
  }

  saveStream(s: ObservedSessionStream): void {
    this.inside('saveStream')
    const known = this.rows.streams.some(
      (row) => row.dwarfId === s.dwarfId && row.streamId === s.streamId
    )
    if (!known) this.rows.streams.push({ ...s })
  }

  /** The stored sessions, for the contract's row count. */
  rowCount(): number {
    return this.rows.sessions.length
  }

  snapshot(): unknown {
    return structuredClone(this.rows)
  }

  restore(snapshot: unknown): void {
    this.rows = structuredClone(snapshot as Rows)
  }

  private inside(member: 'save' | 'saveStream'): void {
    if (!this.scope.isInTransaction()) {
      throw new Error(`ObservedSessionStore.${member} runs inside the caller transaction (16 §2.2)`)
    }
    this.writes.push(member)
  }
}
