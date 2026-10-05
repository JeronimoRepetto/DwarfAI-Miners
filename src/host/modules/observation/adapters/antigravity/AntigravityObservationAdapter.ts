// AntigravityObservationAdapter (15 §5 Antigravity row, AMENDMENT-13; 16 §4.3 `ObservationAdapter`,
// `TranscriptReader`): the Host reads Antigravity CLI (`agy`) conversations started outside DwarfAI
// from the CLI's own store under `~/.gemini` (`discovery.ts`), and never writes it (09 §1; FM-090;
// T-30). Reading local files uses no quota and touches no credential (15 §8).
//
// Sources:
//
// - Step logs, `antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`,
//   read by the shared JSONL base (byte-offset cursor, bounded tail reads, settle, root dispatch:
//   `../base`) with the pinned, stateless step reader of `parse.ts`: a record it does not recognise
//   is skipped with a warning, counted as drift by the loop, and the session goes on (INV-38,
//   FM-068).
// - Conversations databases, `conversations/<conversationId>.db` under the three trees, read
//   through the read-only snapshot from a watermark (`conversationDb.ts`): one sealed usage unit
//   per generation, with its model id.
// - Lookups read at every `discover`, not streams of their own: `history.jsonl` for each
//   conversation's workspace (re-read only when it changed), and `presence/` for which
//   conversations are running.
//
// Identity: the conversation id (the `brain/<id>` folder; the `.db` file name). The workspace comes
// only from `history.jsonl`; until it names a conversation, its facts carry no folder, so the loop
// holds them and no dwarf arrives (a mine is never invented from an id).
//
// Ending (FM-059): a conversation is closed while its presence lock is absent, once the lock has
// been gone for `ANTIGRAVITY_LOCK_GRACE_MS` (a lock replaced between two reads is no ending), or at
// once when it was already absent the first time this Host run looked (a conversation that ended
// while no Host ran, ISSUE-078). Every read of a closed conversation's step log states one `closed`
// fact with the same key; the loop's ledger keeps that to one `SessionClosedObserved` (INV-36). A
// lock that comes back opens it again. Closure also seals a conversation's newest generation.
//
// No turn end (`turnEnd: 'none'`, C-20) and no readable process identity: a running agy cannot be
// tied to a conversation (`antigravityProvider.ts:102-103`), so `processIdentitySource` is `none`
// and ending an observed Antigravity session answers `no-identity` (15 §5, ADR-014 item 2, S-014-1).
//
// Candidate decision (21 §6): `src/main/providers/antigravity/*` is replaced; the evidence is in
// `AntigravityObservationAdapter.conformance.test.ts`.
import { join } from 'node:path'
import type { FolderPath, Instant, ProviderId } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { ReadOnlySnapshotOpener } from '../../../../platform/sqlite/readOnlySnapshot'
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
import { JsonlObservationAdapter, type JsonlLine } from '../base/jsonlObservationAdapter'
import { ConversationDbReader } from './conversationDb'
import {
  brainDirOf,
  conversationIdOfTranscript,
  historyPathOf,
  lockedConversations,
  presenceDirOf,
  TRANSCRIPT_NAME,
  workspacesOfHistory
} from './discovery'
import { eventsOfStep, parseStepLine } from './parse'

/** How long a presence lock must stay gone before its conversation is closed (the candidate's 30 s). */
export const ANTIGRAVITY_LOCK_GRACE_MS = 30_000

/** The most read of `history.jsonl`, from its end: the newest records are the ones that count. */
const HISTORY_TAIL_BYTES = 1024 * 1024

/**
 * What an observed Antigravity session can do, declared as data (HO-14; 15 §3 rows A/B A2); an
 * omitted field fails closed (ADR-009 D3).
 */
export const ANTIGRAVITY_OBSERVED_CAPABILITIES: ObservedCapabilities = Object.freeze({
  launch: false,
  observe: true,
  interrupt: false,
  permission: 'none',
  question: 'none',
  resume: 'none',
  adopt: false,
  turnEnd: 'none',
  reactionEvidence: 'none',
  subagents: 'none',
  usage: Object.freeze({ fidelity: 1, rateLimits: false }),
  mcpInjection: 'none',
  console: 'log',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
})

/** `~/.gemini`, the folder the three Antigravity trees sit in (15 §5). */
export function antigravityGeminiDirOf(home: string): string {
  return join(home, '.gemini')
}

/** What a read answers (16 §4.3). */
type AntigravityRead = Awaited<ReturnType<ObservationAdapter['read']>>

export interface AntigravityObservationAdapterOptions {
  /** The Antigravity catalog id (the catalog's, passed in by the composition). */
  providerId: ProviderId
  /** `antigravityGeminiDirOf(home)`, resolved by the composition root. */
  geminiDir: string
  /** The other adapters' roots, for the longest-prefix dispatch (FM-093). */
  claimedRoots: readonly string[]
  fs: FileSystem
  clock: Clock
  /** `openReadOnlySnapshot` of `host/platform/sqlite` (R11). */
  openSnapshot: ReadOnlySnapshotOpener
  identify?: FileIdentifier
  /** Defaults to `ANTIGRAVITY_LOCK_GRACE_MS`. */
  lockGraceMs?: number
}

function baseStreamId(streamId: string): string {
  return streamId.replace(/#\d+$/, '')
}

export class AntigravityObservationAdapter implements ObservationAdapter, TranscriptReader {
  readonly providerId: ProviderId
  readonly cursorKind = 'byte-offset' as const
  /** Where a process identity for ending a session would come from: nowhere (ADR-014 item 2). */
  readonly processIdentitySource = 'none' as const
  private readonly transcripts: JsonlObservationAdapter
  private readonly databases: ConversationDbReader
  private readonly grace: number
  /** The conversation of each step-log stream, by stream id without generation. */
  private readonly conversationOfStream = new Map<string, string>()
  /** Each conversation's workspace, from `history.jsonl`. */
  private workspaces = new Map<string, string>()
  private historyKey: string | null = null
  /** The conversations whose lock the last `discover` found. */
  private locked = new Set<string>()
  /**
   * Since when each conversation's lock has been absent, and whether it was already absent the
   * first time this Host run looked (closed at once, no grace).
   */
  private readonly absentSince = new Map<string, { at: number; atFirstSight: boolean }>()
  /** The conversations any `discover` of this Host run has seen. */
  private readonly seen = new Set<string>()

  constructor(private readonly options: AntigravityObservationAdapterOptions) {
    this.providerId = options.providerId
    this.grace = options.lockGraceMs ?? ANTIGRAVITY_LOCK_GRACE_MS
    const identify = options.identify ?? nodeFileIdentity
    this.transcripts = new JsonlObservationAdapter({
      providerId: options.providerId,
      capabilities: ANTIGRAVITY_OBSERVED_CAPABILITIES,
      roots: [brainDirOf(options.geminiDir)],
      claimedRoots: options.claimedRoots,
      matches: (name) => name === TRANSCRIPT_NAME,
      parse: (line) => this.parseLine(line),
      fs: options.fs,
      clock: options.clock,
      identify
    })
    this.databases = new ConversationDbReader({
      providerId: options.providerId,
      geminiDir: options.geminiDir,
      fs: options.fs,
      identify,
      openSnapshot: options.openSnapshot
    })
  }

  capabilities(): ObservedCapabilities {
    return { ...ANTIGRAVITY_OBSERVED_CAPABILITIES }
  }

  async discover(fs: FileSystem): Promise<SourceFile[]> {
    await this.readHistory()
    const logs: SourceFile[] = []
    for (const source of await this.transcripts.discover(fs)) {
      const conversationId = conversationIdOfTranscript(source.path)
      if (conversationId === null) continue
      this.conversationOfStream.set(source.streamId, conversationId)
      logs.push(source)
    }
    const databases = await this.databases.discover((id) => this.workspaces.has(id))
    await this.readPresence()
    return [...logs, ...databases]
  }

  async read(source: SourceFile, from: Cursor | null): Promise<AntigravityRead> {
    const streamId = baseStreamId(source.streamId)
    if (this.databases.owns(streamId)) {
      const conversationId = this.databases.conversationOf(streamId)
      const closed = conversationId !== null && this.isClosed(conversationId)
      return this.databases.read(source, from, closed)
    }
    const conversationId =
      this.conversationOfStream.get(streamId) ?? conversationIdOfTranscript(source.path)
    if (conversationId !== null) this.conversationOfStream.set(streamId, conversationId)
    const batch = await this.transcripts.read(source, from)
    if (conversationId === null || !this.isClosed(conversationId)) return batch
    const workspace = this.workspaces.get(conversationId)
    const closed: ObservedEvent = {
      kind: 'closed',
      sourceEventId: 'presence-closed',
      identity: { providerId: this.providerId, providerSessionId: conversationId },
      ...(workspace === undefined ? {} : { cwd: workspace as FolderPath }),
      at: this.closedAt(conversationId)
    }
    return { ...batch, events: [...batch.events, closed] }
  }

  entries(
    ref: ObservedSessionRef,
    window: { before?: string; limit: number }
  ): Promise<TranscriptEntry[]> {
    return this.transcripts.entries(ref, window)
  }

  /**
   * The model id the generation of a usage unit recorded (field 1.19), or null. Read only: the
   * models data belongs to the suppliers catalog (EPIC-09), which the composition feeds from here.
   */
  modelIdOf(unitKey: string): string | null {
    return this.databases.modelIdOf(unitKey)
  }

  /** The base's line parser; stateless, so the base's window reads use it as well. */
  private parseLine(line: JsonlLine): ObservedEvent[] | null {
    const step = parseStepLine(line.text)
    if (step === null) return null
    const conversationId = this.conversationOfStream.get(baseStreamId(line.streamId))
    if (conversationId === undefined) return []
    const workspace = this.workspaces.get(conversationId)
    return eventsOfStep(step, {
      providerId: this.providerId,
      conversationId,
      cwd: workspace === undefined ? null : (workspace as FolderPath),
      offset: line.offset
    })
  }

  /** Whether a conversation is not running: its lock gone past the grace, or never seen. */
  private isClosed(conversationId: string): boolean {
    if (this.locked.has(conversationId)) return false
    const since = this.absentSince.get(conversationId)
    if (since === undefined) return false
    return since.atFirstSight || this.options.clock.now() - since.at >= this.grace
  }

  /** When the lock was first seen absent: the lock's disappearance, or first sight. */
  private closedAt(conversationId: string): Instant {
    return (this.absentSince.get(conversationId)?.at ?? this.options.clock.now()) as Instant
  }

  /** Reads which conversations hold a lock, and since when the others have not. */
  private async readPresence(): Promise<void> {
    let entries: Awaited<ReturnType<FileSystem['listDir']>>
    try {
      entries = await this.options.fs.listDir(presenceDirOf(this.options.geminiDir))
    } catch {
      entries = []
    }
    const now = this.options.clock.now()
    const locked = lockedConversations(entries)
    const known = new Set([
      ...this.conversationOfStream.values(),
      ...this.databases.conversations(),
      ...this.locked,
      ...locked
    ])
    for (const id of known) {
      if (locked.has(id)) this.absentSince.delete(id)
      else if (!this.absentSince.has(id)) {
        this.absentSince.set(id, { at: now, atFirstSight: !this.seen.has(id) })
      }
      this.seen.add(id)
    }
    this.locked = locked
  }

  /** Re-reads the workspace map when `history.jsonl` changed. */
  private async readHistory(): Promise<void> {
    const path = historyPathOf(this.options.geminiDir)
    const info = await this.options.fs.stat(path)
    if (info === null) {
      this.workspaces = new Map()
      this.historyKey = null
      return
    }
    const key = JSON.stringify([info.size, info.mtimeMs])
    if (key === this.historyKey) return
    let text: string
    try {
      text = await this.options.fs.readTextTail(path, HISTORY_TAIL_BYTES)
    } catch {
      return
    }
    this.workspaces = workspacesOfHistory(text)
    this.historyKey = key
  }
}
