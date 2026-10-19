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
// Resume under the same id (owner decision 2026-10-05, as 07 S4.41 / FM-145): `agy --conversation
// <id>` (AMENDMENT-13) continues a conversation with its own id, but a conversation observed closed
// is in the ended-agents ledger, which never lets its identity arrive again (INV-36). So a resumed
// conversation is a new session, and a new dwarf: `resumedSessionIdOf` gives it the identity
// `<conversationId>~resumed-<lock start, epoch seconds>`. The shape is the frozen `ProviderIdentity`
// (ADR-015; 16): the generation rides on `providerSessionId`, because `providerAgentId` names a
// subagent of a session, which a resume is not. It is derived from the store alone, never from
// memory, so a Host restart derives the same identity: a lock is a 0-byte file the CLI writes when a
// session starts, so its modification time is that start; a lock that started more than the grace
// after the conversation's first step began a later session (the original session's lock is
// written before its first step, and a closed session's lock stayed gone for at least the grace).
// Steps created from that start on are the resumed session's; the ones before stay the
// conversation's first session. Keys never change with the session: a step's source key is its
// conversation's (`parse.ts`), so the predecessor's records, read again, add no rows. Its usage
// units likewise keep their `unitKey`; only the dwarf they are read for is the resumed one.
// UNVERIFIED until the ISSUE-319 recording: that agy writes the lock once per session and never
// touches it while the session runs.
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

/** The most read of a step log's head to find its first step's time. */
const HEAD_BYTES = 64 * 1024

/**
 * The session identity of a conversation resumed under its own id, from when its lock was written
 * (15 §5; ADR-015): `<conversationId>~resumed-<epoch seconds>`. Seconds, because the step log's
 * times are whole seconds.
 */
export function resumedSessionIdOf(conversationId: string, lockStartedAtMs: number): string {
  return `${conversationId}~resumed-${Math.floor(lockStartedAtMs / 1000)}`
}

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
  /** The step log of each conversation. */
  private readonly logOf = new Map<string, string>()
  /** Each conversation's first step time, once its log has one. */
  private readonly firstStepAt = new Map<string, number>()
  /** The start of each conversation's resumed session (its lock's time), while known. */
  private readonly resumedAt = new Map<string, number>()

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
      this.logOf.set(conversationId, source.path)
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
      if (conversationId === null) return this.databases.read(source, from, false)
      const read = await this.databases.read(source, from, this.isClosed(conversationId))
      // Units read now are the current session's: every earlier one was sealed by its close.
      const sessionId = this.sessionIdOf(conversationId, null)
      return {
        ...read,
        events: read.events.map((event) => ({
          ...event,
          identity: { ...event.identity, providerSessionId: sessionId }
        }))
      }
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
      identity: {
        providerId: this.providerId,
        providerSessionId: this.sessionIdOf(conversationId, null)
      },
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
      sessionId: this.sessionIdOf(conversationId, step.at),
      cwd: workspace === undefined ? null : (workspace as FolderPath),
      offset: line.offset
    })
  }

  /**
   * The session a fact of the conversation belongs to: its resumed session when the fact is from
   * that session's start on (`at` null: the current session), else the conversation's own.
   */
  private sessionIdOf(conversationId: string, at: Instant | null): string {
    const resumed = this.resumedAt.get(conversationId)
    if (resumed === undefined) return conversationId
    // The step log's times are whole seconds: a step of the lock's second is the resumed session's.
    if (at !== null && at < Math.floor(resumed / 1000) * 1000) return conversationId
    return resumedSessionIdOf(conversationId, resumed)
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
    for (const id of locked) await this.readResume(id)
  }

  /**
   * Whether the held lock of a conversation started a resumed session: written more than the grace
   * after the conversation's first step. A lock that did not drops the resume (the store says the
   * running session is the conversation's own).
   */
  private async readResume(conversationId: string): Promise<void> {
    const lock = await this.options.fs.stat(
      join(presenceDirOf(this.options.geminiDir), `${conversationId}.lock`)
    )
    const first = await this.firstStepOf(conversationId)
    if (lock === null || first === null) return
    if (lock.mtimeMs - this.grace > first) this.resumedAt.set(conversationId, lock.mtimeMs)
    else this.resumedAt.delete(conversationId)
  }

  /** The time of a conversation's first readable step, or null while its log has none. */
  private async firstStepOf(conversationId: string): Promise<number | null> {
    const known = this.firstStepAt.get(conversationId)
    if (known !== undefined) return known
    const path = this.logOf.get(conversationId)
    if (path === undefined) return null
    let text: string
    try {
      text = await this.options.fs.readTextHead(path, HEAD_BYTES)
    } catch {
      return null
    }
    for (const line of text.split('\n')) {
      const at = parseStepLine(line.replace(/\r$/, ''))?.at ?? null
      if (at === null) continue
      this.firstStepAt.set(conversationId, at)
      return at
    }
    return null
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
