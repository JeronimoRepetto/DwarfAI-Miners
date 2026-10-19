// SimulatedObservationAdapter (15 §4.12; 16 §4.3 adapter table): the observation side of the
// simulated provider of ISSUE-143. It reads no disk and talks to no provider: the sessions it
// observes are written to a `SimulatedSessionLog`, the simulated provider's own "files", by a test,
// the parity fixture world or the development valley, and every read is a pure function of that
// log, so a run replays exactly (same records, same `sourceEventId`s, HO-37).
//
// - One stream per simulated session; the cursor is a watermark: the number of records read.
// - A session in the log is one provider identity (`providerSessionId` = its session id); a
//   resumed or forked session is another session id, so another dwarf (S4.41, ADR-015 item 7).
// - Capabilities are test configuration, declared as data (HO-14); omitted fields fail closed.
//
// Candidate decision (21 §6): `src/main/providers/simulated/*` is replaced (as ISSUE-143 recorded
// for the driver side): it is a snapshot `Provider` with a seeded world model, not a cursor-based
// `ObservationAdapter`, and only src/legacy-bridge may import it (R16).
import type {
  FolderPath,
  Instant,
  ProviderId,
  ProviderIdentity
} from '../../../../kernel/domain/values'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { ConversationEntry, ObservedCapabilities } from '../../../suppliers'
import type {
  Cursor,
  ObservationAdapter,
  ObservedEvent,
  SourceFile
} from '../../ports/observationAdapter'

/** One record the simulated provider wrote for a session. */
export type SimulatedRecord =
  | { kind: 'start'; cwd: FolderPath; at: Instant }
  | { kind: 'message'; role: ConversationEntry['role']; text: string; at: Instant }
  | { kind: 'activity'; turnStarted: boolean; at: Instant }
  | { kind: 'close'; at: Instant }

/** The simulated provider's session files: what the adapter observes. */
export class SimulatedSessionLog {
  private readonly bySession = new Map<string, SimulatedRecord[]>()

  /** A session opens in `cwd`. */
  open(sessionId: string, cwd: FolderPath, at: Instant): void {
    this.append(sessionId, { kind: 'start', cwd, at })
  }

  /** The person (or the dwarf) writes a message in the session. */
  message(sessionId: string, role: ConversationEntry['role'], text: string, at: Instant): void {
    this.append(sessionId, { kind: 'message', role, text, at })
  }

  /** A record with no message (a tool step, a turn start). */
  activity(sessionId: string, at: Instant, turnStarted = false): void {
    this.append(sessionId, { kind: 'activity', turnStarted, at })
  }

  /** The session ends outside DwarfAI. */
  close(sessionId: string, at: Instant): void {
    this.append(sessionId, { kind: 'close', at })
  }

  sessions(): string[] {
    return [...this.bySession.keys()]
  }

  records(sessionId: string): readonly SimulatedRecord[] {
    return this.bySession.get(sessionId) ?? []
  }

  private append(sessionId: string, record: SimulatedRecord): void {
    const records = this.bySession.get(sessionId) ?? []
    records.push(record)
    this.bySession.set(sessionId, records)
  }
}

export interface SimulatedObservationAdapterOptions {
  /** The simulated provider's catalog id (the catalog's, passed in by the composition). */
  providerId: ProviderId
  log: SimulatedSessionLog
  /** Test configuration (15 §4.12). */
  capabilities?: ObservedCapabilities
}

export class SimulatedObservationAdapter implements ObservationAdapter {
  readonly providerId: ProviderId
  readonly cursorKind = 'watermark' as const

  constructor(private readonly options: SimulatedObservationAdapterOptions) {
    this.providerId = options.providerId
  }

  capabilities(): ObservedCapabilities {
    return { ...(this.options.capabilities ?? { observe: true }) }
  }

  discover(_fs: FileSystem): Promise<SourceFile[]> {
    return Promise.resolve(
      this.options.log.sessions().map((sessionId) => ({
        streamId: this.streamOf(sessionId),
        adapterId: this.providerId,
        path: `simulated://${sessionId}`,
        fileIdentity: this.streamOf(sessionId),
        size: this.options.log.records(sessionId).length
      }))
    )
  }

  read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }> {
    const sessionId = source.path.slice('simulated://'.length)
    const records = this.options.log.records(sessionId)
    const start = from?.value ?? 0
    const identity: ProviderIdentity = { providerId: this.providerId, providerSessionId: sessionId }
    const cwd = records.find((r) => r.kind === 'start')
    const events = records
      .slice(start)
      .map((record, n) =>
        this.eventOf(
          record,
          `r${start + n}`,
          identity,
          source.streamId,
          cwd?.kind === 'start' ? cwd.cwd : undefined
        )
      )
    return Promise.resolve({
      events,
      next: {
        adapterId: this.providerId,
        kind: 'watermark',
        value: Math.max(start, records.length),
        fileIdentity: source.fileIdentity
      },
      warnings: []
    })
  }

  private eventOf(
    record: SimulatedRecord,
    sourceEventId: string,
    identity: ProviderIdentity,
    streamId: string,
    cwd: FolderPath | undefined
  ): ObservedEvent {
    const base = { sourceEventId, identity, ...(cwd === undefined ? {} : { cwd }) }
    switch (record.kind) {
      case 'start':
        return { ...base, kind: 'session', cwd: record.cwd, at: record.at }
      case 'message':
        return {
          ...base,
          kind: 'entries',
          entries: [
            {
              sourceKey: `${this.providerId}:${streamId}:${sourceEventId}`,
              role: record.role,
              text: record.text,
              providerTime: record.at
            }
          ]
        }
      case 'activity':
        return {
          ...base,
          kind: 'activity',
          at: record.at,
          activity: record.turnStarted ? 'turn-started' : 'record'
        }
      case 'close':
        return { ...base, kind: 'closed', at: record.at }
    }
  }

  private streamOf(sessionId: string): string {
    return `${this.providerId}:${sessionId}`
  }
}
