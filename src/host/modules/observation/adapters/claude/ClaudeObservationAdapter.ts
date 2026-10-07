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
// - Endings and replays (`reconcile.ts`, `parse.ts`): a subagent's delivered `<task-notification>`
//   is a `closed` fact of its identity, which the loop records in `EndedAgentLedger` (INV-36); a
//   resumed session's replayed records keep their first keys (C-16).
// - The session registry `sessions/<pid>.json` is read, when the composition gives a
//   `ProcessControl`, for two facts: the process identity of a session (pid and the recorded
//   start, through the #45 guard of `reconcile.ts`), which the module answers for ending an
//   observed session (ADR-014 item 2; 05 §4 item 1), and whether that process is gone (FM-059).
//   Claude Code removes an entry when its session exits, but a killed process leaves its entry
//   behind, so an entry is no evidence of a live session. Every `discover` checks the recorded
//   process of each session last found live, also after its entry left the registry, and a
//   session whose process is gone (nothing on the pid, or another process on a recycled pid) is
//   closed: every read of its transcript states one `closed` fact, which the loop turns into one
//   `SessionClosedObserved` (07 S4.33) and the ledger keeps (INV-36). A process that ended never
//   comes back, so a `gone` verdict is kept while its entry exists and its pid is not checked
//   again. A probe with no answer is no evidence: presence fails open (#45 polarity). Its
//   `waitingFor` ask evidence belongs to an observed-ask port that does not exist yet, so
//   `observedPermission` / `observedQuestion` are `none` here although 15 §2.5 measured
//   `detected` (hidden until built).
// - Cadence (owner amendment H, 2026-10-07): the identity check (`probe`, whose start-time query
//   spawns PowerShell on Windows) would cost one process per live session every 2 s cycle. So each
//   cycle runs only `ProcessControl.isRunning` (signal 0, no spawn), which closes a session whose
//   pid has no process at once, and the full `probe` runs at most once per `IDENTITY_RECHECK_MS`
//   per live session, and again whenever the cheap answer changes. Bound: a pid recycled between
//   two cycles (the cheap check still answers `running`) is found within `IDENTITY_RECHECK_MS`.
//   That only delays a departure: presence is not destructive, and every kill path re-checks the
//   identity itself (ADR-014, #231), so a stale `live` verdict never ends a stranger's process.
// - Known limits: a registry entry whose pid is already dead at the first look closes in the
//   batch that first reads its session, and the loop announces `SessionObserved` before it, so
//   that dwarf arrives once and walks out on the next cycle (the ledger blocks it afterwards). An
//   entry with no readable `procStart` (only the Windows FILETIME form is known) closes when its
//   pid has no process, but a recycled pid there is no evidence and keeps the session present.
//   The Codex and OpenCode adapters emit no `closed` fact at all, so their observed dwarfs never
//   depart (15 §5: no readable pid for Codex; OpenCode's pid source is UNVERIFIED, S-014-1).
//
// Candidate decision (21 §6): `src/main/providers/claude/parse.ts` and `subagents.ts` are replaced;
// the evidence is in `ClaudeObservationAdapter.conformance.test.ts`.
import { join } from 'node:path'
import type { ProbeResult, ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { Instant, ProviderId, ProviderIdentity } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { ProcessControl } from '../../../../kernel/ports/processControl'
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
import {
  registryEntryOf,
  registryVerdict,
  type RegistryEntry,
  type RegistryVerdict
} from './reconcile'
import { isTranscriptName, parentAgentIdOf, SIDECAR_MAX_BYTES, transcriptFileOf } from './subagents'

/** How far before a cursor a read with no kept stream state looks to rebuild it. */
export const CLAUDE_LOOKBACK_BYTES = OBSERVATION_TAIL_GATE_BYTES

/**
 * How long a live session's identity check (`probe`: the per-OS start-time query) is trusted
 * while the cheap existence check keeps answering the same (owner amendment H, 2026-10-07).
 */
export const IDENTITY_RECHECK_MS = 30_000

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
  /** The kernel probe for the #45 guard; without it no session answers a process identity. */
  processes?: Pick<ProcessControl, 'probe' | 'isRunning' | 'currentBootIdentity'>
}

/** A registry file's name: the pid of the session's process. */
const REGISTRY_FILE = /^\d+\.json$/
/** The most read of a registry file: real ones are under 1 KiB. */
const REGISTRY_MAX_BYTES = 64 * 1024

/** One registry entry's last check: the verdict, when the full probe ran, the cheap answer. */
interface IdentityCheck {
  verdict: RegistryVerdict
  probedAt: Instant
  running: 'running' | 'absent' | 'unknown'
}

/** The key of a registry entry's process: its session, pid and recorded start. */
function checkKeyOf(entry: RegistryEntry): string {
  return `${entry.sessionId}|${entry.pid}|${entry.recordedStartMs ?? ''}`
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
  /** The process identity the #45 guard took for each registered session, by session id. */
  private registered = new Map<string, ProcessIdentity | null>()
  /** The last check of each (session, pid, recorded start); a `gone` one is final. */
  private readonly checks = new Map<string, IdentityCheck>()
  /** The entry of each session whose process was last found live, by session id. */
  private readonly running = new Map<string, RegistryEntry>()
  /** When each session was found closed in this Host run, by session id (FM-059). */
  private readonly closedAt = new Map<string, Instant>()

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
    await this.readRegistry()
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
    // A session's own transcript states its closure; a subagent ends with its session (INV-36).
    const closedAt = file.agentId === null ? this.closedAt.get(file.sessionId) : undefined
    if (closedAt !== undefined) {
      out.events.push({
        kind: 'closed',
        sourceEventId: 'registry-closed',
        identity: { providerId: this.providerId, providerSessionId: file.sessionId },
        at: closedAt
      })
    }
    return out
  }

  /**
   * The process identity of a session as of the last `discover` (pid and recorded start, ADR-014
   * item 1), or null: a subagent runs inside its session's process and has none of its own, and a
   * session the registry does not name, or whose pid the #45 guard did not take, has none either.
   */
  processIdentityOf(identity: ProviderIdentity): ProcessIdentity | null {
    if (identity.providerId !== this.providerId || identity.providerAgentId !== undefined) {
      return null
    }
    return this.registered.get(identity.providerSessionId) ?? null
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

  /**
   * Reads the session registry, takes each entry's process identity through the #45 guard, and
   * closes every session whose recorded process is gone (FM-059).
   */
  private async readRegistry(): Promise<void> {
    const processes = this.options.processes
    if (processes === undefined) return
    const folder = join(this.options.configDir, 'sessions')
    let listed: Array<{ name: string; isDirectory: boolean }>
    try {
      listed = await this.options.fs.listDir(folder)
    } catch {
      return
    }
    const registered = new Map<string, ProcessIdentity | null>()
    const present = new Set<string>()
    const named = new Set<string>()
    for (const file of listed) {
      if (file.isDirectory || !REGISTRY_FILE.test(file.name)) continue
      let text: string
      try {
        text = await this.options.fs.readTextHead(join(folder, file.name), REGISTRY_MAX_BYTES)
      } catch {
        continue
      }
      const entry = registryEntryOf(text)
      if (entry === null) continue
      named.add(entry.sessionId)
      present.add(checkKeyOf(entry))
      const verdict = await this.check(entry, processes)
      this.follow(entry, verdict)
      registered.set(entry.sessionId, verdict.kind === 'live' ? verdict.identity : null)
    }
    // A live session's entry can leave the registry before its process ends (an entry rewritten,
    // or one this read could not parse): its last entry is checked until that process is gone.
    for (const [sessionId, entry] of [...this.running]) {
      if (named.has(sessionId)) continue
      present.add(checkKeyOf(entry))
      this.follow(entry, await this.check(entry, processes))
    }
    for (const key of [...this.checks.keys()]) if (!present.has(key)) this.checks.delete(key)
    this.registered = registered
  }

  /**
   * One cycle's check of an entry's process (owner amendment H): the cheap existence check every
   * cycle, the full #45 guard only when none ran yet, the cheap answer changed, or the last one is
   * `IDENTITY_RECHECK_MS` old. A `gone` verdict is final.
   */
  private async check(
    entry: RegistryEntry,
    processes: Pick<ProcessControl, 'probe' | 'isRunning' | 'currentBootIdentity'>
  ): Promise<RegistryVerdict> {
    const key = checkKeyOf(entry)
    const last = this.checks.get(key)
    if (last?.verdict.kind === 'gone') return last.verdict
    let running: IdentityCheck['running']
    try {
      running = processes.isRunning(entry.pid)
    } catch {
      running = 'unknown'
    }
    const now = this.options.clock.now()
    if (running === 'absent') {
      // No process has the pid: the session's own process is not running, whatever it started.
      const gone: RegistryVerdict = { kind: 'gone' }
      this.checks.set(key, { verdict: gone, probedAt: now, running })
      return gone
    }
    if (
      last !== undefined &&
      last.running === running &&
      now - last.probedAt < IDENTITY_RECHECK_MS
    ) {
      return last.verdict
    }
    const verdict = await this.guard(entry, processes)
    this.checks.set(key, { verdict, probedAt: now, running })
    return verdict
  }

  /** Keeps following a session whose process is live; closes it once that process is gone. */
  private follow(entry: RegistryEntry, verdict: RegistryVerdict): void {
    if (verdict.kind === 'live') {
      this.running.set(entry.sessionId, entry)
    } else if (verdict.kind === 'gone') {
      this.running.delete(entry.sessionId)
      if (!this.closedAt.has(entry.sessionId)) {
        this.closedAt.set(entry.sessionId, this.options.clock.now())
      }
    }
  }

  /** The #45 guard over one entry: one probe of its pid, and the boot id when it answers none. */
  private async guard(
    entry: RegistryEntry,
    processes: Pick<ProcessControl, 'probe' | 'isRunning' | 'currentBootIdentity'>
  ): Promise<RegistryVerdict> {
    let probe: ProbeResult
    try {
      probe = await processes.probe(entry.pid)
    } catch {
      probe = 'unknown'
    }
    let bootId: string | 'unknown' = 'unknown'
    if (probe === 'unknown') {
      try {
        bootId = (await processes.currentBootIdentity()).bootId
      } catch {
        bootId = 'unknown'
      }
    }
    return registryVerdict(entry, probe, bootId)
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
