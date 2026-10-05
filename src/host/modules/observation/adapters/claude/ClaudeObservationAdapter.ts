// ClaudeObservationAdapter (15 §5 Claude row; 16 §4.3 `ObservationAdapter`, `TranscriptReader`):
// the Host reads Claude Code sessions started outside DwarfAI from Claude Code's own transcripts
// under its configuration folder (`CLAUDE_CONFIG_DIR`, default `~/.claude`, FM-091), and never
// writes them (09 §1; T-30).
//
// - Sources: every session transcript `projects/<encoded cwd>/<sessionId>.jsonl` and every subagent
//   transcript `<sessionId>/subagents/agent-<id>.jsonl` (`subagents.ts`), read by the shared JSONL
//   base (byte-offset cursor, bounded tail reads, settle, root dispatch: `../base`). The base hands
//   every line it consumes to this adapter, which reads it in stream order (`parse.ts`): a message's
//   usage rows and the session's first record need the lines before them, so the state a read ends
//   in is kept per stream at its cursor. A read from a cursor with no kept state (a Host restart)
//   rebuilds it from the look-back window before the cursor.
// - Identity (ADR-015 item 7): the record's `sessionId`; a subagent adds its agent id and is its own
//   identity, whose parent is the agent its sidecar names (`parentAgentId`, #391), else the session.
//   A session resumed or forked in the person's terminal writes a new session id: a new identity
//   (FM-145). The cwd is the records' own, never the folder name's (ADR-030).
// - Turn ends are inferred (`turnEnd: 'none'` until S-021-1 passes); the 30 s inference from
//   silence (S-032-1) is the loop's, not this adapter's.
// - Not read here: the session registry `sessions/<pid>.json` (pid + start time for ending an
//   observed session, and its `waitingFor` ask evidence) belongs to ISSUE-072's #45 guard and to an
//   observed-ask port that does not exist yet, so `observedPermission` / `observedQuestion` are
//   `none` here although 15 §2.5 measured `detected` (hidden until built).
//
// Candidate decision (21 §6): `src/main/providers/claude/parse.ts` and `subagents.ts` are replaced;
// the evidence is in `ClaudeObservationAdapter.conformance.test.ts`.
import { join } from 'node:path'
import type { ProviderId } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
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
  parseClaudeLine,
  stepTranscript,
  TRANSCRIPT_START,
  type TranscriptContext,
  type TranscriptFile,
  type TranscriptState
} from './parse'
import { isTranscriptName, parentAgentIdOf, SIDECAR_MAX_BYTES, transcriptFileOf } from './subagents'

/** How far before a cursor a read with no kept stream state looks to rebuild it. */
export const CLAUDE_LOOKBACK_BYTES = OBSERVATION_TAIL_GATE_BYTES

/**
 * What an observed Claude session can do, declared as data (HO-14; 15 §3 rows A/B C4); an omitted
 * field fails closed (ADR-009 D3). `sendTurn` stays omitted until the terminal relay of ISSUE-167
 * exists, `console` is `log` until focusing the person's terminal is built (C4 "focus-terminal
 * (→ log)"), and `observedPermission` / `observedQuestion` are `none` although 15 §2.5 measured
 * `detected`: the port has no observed ask yet, so no ask could reach the person.
 */
export const CLAUDE_OBSERVED_CAPABILITIES: ObservedCapabilities = Object.freeze({
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

/** `CLAUDE_CONFIG_DIR` when the Host's environment sets it, else `~/.claude` (15 §5; FM-091, HO-09). */
export function claudeConfigDirOf(
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string {
  const set = env['CLAUDE_CONFIG_DIR']
  return set !== undefined && set !== '' ? set : join(home, '.claude')
}

/** What a read answers (16 §4.3). */
type ClaudeRead = Awaited<ReturnType<ObservationAdapter['read']>>

export interface ClaudeObservationAdapterOptions {
  /** The Claude catalog id (the catalog's, passed in by the composition). */
  providerId: ProviderId
  /** `claudeConfigDirOf(env, home)`, resolved by the composition root. */
  configDir: string
  /** The other adapters' roots, for the longest-prefix dispatch (FM-093). */
  claimedRoots: readonly string[]
  fs: FileSystem
  clock: Clock
  identify?: FileIdentifier
}

/** A stream's state at a byte offset: the end of the last read. */
interface Checkpoint {
  offset: number
  state: TranscriptState
}

function baseStreamId(streamId: string): string {
  return streamId.replace(/#\d+$/, '')
}

export class ClaudeObservationAdapter implements ObservationAdapter, TranscriptReader {
  readonly providerId: ProviderId
  readonly cursorKind = 'byte-offset' as const
  private readonly transcripts: JsonlObservationAdapter
  /** Which transcript each stream is, by stream id without generation, for window reads. */
  private readonly fileOfStream = new Map<string, TranscriptFile>()
  /** A sidecar's parent agent, by sidecar path, once the sidecar was read. */
  private readonly sidecars = new Map<string, string | null>()
  private readonly checkpoints = new Map<string, Checkpoint>()
  /** The lines the base consumes during each read in flight, by stream and byte offset. */
  private readonly reading = new Map<string, Map<number, string>>()

  constructor(private readonly options: ClaudeObservationAdapterOptions) {
    this.providerId = options.providerId
    this.transcripts = new JsonlObservationAdapter({
      providerId: options.providerId,
      capabilities: CLAUDE_OBSERVED_CAPABILITIES,
      roots: [join(options.configDir, 'projects')],
      claimedRoots: options.claimedRoots,
      matches: isTranscriptName,
      parse: (line) => this.parseLine(line),
      fs: options.fs,
      clock: options.clock,
      identify: options.identify ?? nodeFileIdentity
    })
  }

  capabilities(): ObservedCapabilities {
    return { ...CLAUDE_OBSERVED_CAPABILITIES }
  }

  async discover(fs: FileSystem): Promise<SourceFile[]> {
    const found = await this.transcripts.discover(fs)
    return found.filter((source) => transcriptFileOf(source.path) !== null)
  }

  async read(source: SourceFile, from: Cursor | null): Promise<ClaudeRead> {
    const start = from?.value ?? 0
    const file = await this.fileOf(source)
    if (file === null) {
      return {
        events: [],
        next: {
          adapterId: this.providerId,
          kind: 'byte-offset',
          value: start,
          fileIdentity: source.fileIdentity
        },
        warnings: []
      }
    }
    const context: TranscriptContext = { providerId: this.providerId, file }
    let state = await this.stateAt(source, start, context)

    const consumed = new Map<number, string>()
    this.reading.set(source.streamId, consumed)
    let batch: ClaudeRead
    try {
      batch = await this.transcripts.read(source, from)
    } finally {
      this.reading.delete(source.streamId)
    }

    const lines = [...consumed]
      .filter(([offset]) => offset >= start && offset < batch.next.value)
      .sort(([a], [b]) => a - b)
    // A gated read began past the cursor (FM-088): what came before is unknown.
    if (lines.length > 0 && lines[0]![0] > start) state = TRANSCRIPT_START
    const out: ClaudeRead = { events: [], next: batch.next, warnings: [...batch.warnings] }
    for (const [offset, text] of lines) {
      const record = parseClaudeLine(text)
      if (record === null) continue
      const step = stepTranscript(state, record, { text, offset }, context)
      state = step.state
      out.events.push(...step.events)
      out.warnings.push(...step.warnings)
    }
    if (batch.next.value > start) {
      this.checkpoints.set(source.streamId, { offset: batch.next.value, state })
    }
    return out
  }

  entries(
    ref: ObservedSessionRef,
    window: { before?: string; limit: number }
  ): Promise<TranscriptEntry[]> {
    return this.transcripts.entries(ref, window)
  }

  /**
   * The base's line parser. Stateless, so the base's window reads use it as well; during a read it
   * also hands the consumed line to `read`, which reads the stream in order.
   */
  private parseLine(line: JsonlLine): ObservedEvent[] | null {
    const record = parseClaudeLine(line.text)
    if (record === null) return null
    // Keyed by offset: a window read of the same stream that interleaves with the read hands in
    // the same bytes at the same offsets, and `read` keeps only its own range.
    this.reading.get(line.streamId)?.set(line.offset, line.text)
    const file = this.fileOfStream.get(baseStreamId(line.streamId))
    if (file === undefined) return []
    const context: TranscriptContext = { providerId: this.providerId, file }
    const sourceEventId = eventIdOf(record, line.text, line.offset)
    const entry = entryOf(record, context, sourceEventId)
    if (entry === null) return []
    // Only a window read uses these events, and only their entries: the read's own events come
    // from `stepTranscript`, which knows the stream's order.
    return [
      {
        kind: 'entries',
        sourceEventId,
        identity: {
          providerId: this.providerId,
          providerSessionId: file.sessionId,
          ...(file.agentId === null ? {} : { providerAgentId: file.agentId })
        },
        entries: [entry]
      }
    ]
  }

  /** Which transcript the source is, with its subagent's parent from the sidecar. */
  private async fileOf(source: SourceFile): Promise<TranscriptFile | null> {
    const location = transcriptFileOf(source.path)
    if (location === null) return null
    let file: TranscriptFile
    if (location.kind === 'session') {
      file = { sessionId: location.sessionId, agentId: null, parentAgentId: null }
    } else {
      file = {
        sessionId: location.sessionId,
        agentId: location.agentId,
        parentAgentId: await this.parentAgentOf(location.sidecarPath)
      }
    }
    this.fileOfStream.set(baseStreamId(source.streamId), file)
    return file
  }

  /**
   * The parent agent the sidecar names. A sidecar is written once and never rewritten, so a read
   * one is kept; a missing or unreadable one is asked again next time, and meanwhile names none.
   */
  private async parentAgentOf(sidecarPath: string): Promise<string | null> {
    const known = this.sidecars.get(sidecarPath)
    if (known !== undefined) return known
    let text: string
    try {
      text = await this.options.fs.readTextHead(sidecarPath, SIDECAR_MAX_BYTES)
    } catch {
      return null
    }
    const parent = parentAgentIdOf(text)
    this.sidecars.set(sidecarPath, parent)
    return parent
  }

  /** The stream's state at byte `start`: kept from the last read, or rebuilt from before it. */
  private async stateAt(
    source: SourceFile,
    start: number,
    context: TranscriptContext
  ): Promise<TranscriptState> {
    if (start === 0) return TRANSCRIPT_START
    const kept = this.checkpoints.get(source.streamId)
    if (kept?.offset === start) return kept.state

    const fs = this.options.fs
    let text: string
    let readFrom: number
    try {
      if (start <= CLAUDE_LOOKBACK_BYTES) {
        // The whole stream before the cursor, whatever the file grows to meanwhile.
        text = await fs.readTextHead(source.path, start)
        readFrom = 0
      } else {
        const before = await fs.stat(source.path)
        if (before === null || before.size - start > OBSERVATION_TAIL_GATE_BYTES) {
          return TRANSCRIPT_START
        }
        const length = before.size - start + CLAUDE_LOOKBACK_BYTES
        text = await fs.readTextTail(source.path, length)
        const after = await fs.stat(source.path)
        if (after === null || after.size !== before.size) return TRANSCRIPT_START
        readFrom = before.size - length
      }
    } catch {
      return TRANSCRIPT_START
    }
    const tail = splitTail(text, readFrom, readFrom > 0)
    let state = TRANSCRIPT_START
    for (const line of tail.lines) {
      if (line.offset >= start) break
      const record = parseClaudeLine(line.text)
      if (record !== null) state = stepTranscript(state, record, line, context).state
    }
    return state
  }
}
