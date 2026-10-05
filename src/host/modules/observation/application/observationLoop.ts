// The observation loop (05 §3.3; 16 §4.3 `ObservationControl.start` / `stop` / `nudge`): the Host
// notices sessions started outside DwarfAI by polling every adapter's sources and reading each
// stream from its cursor. Polling is the backbone (FM-089); a hook nudge only brings the next cycle
// forward, and nudges that arrive while a cycle runs collapse into one more cycle (#196). One cycle
// runs at a time.
//
// Per stream, one batch:
//
// 1. Read from the stream's cursor. An adapter that throws, and every line it skipped, is a drift
//    record (INV-38, FM-086): logged without anything the provider wrote, never fatal.
// 2. A file that shrank below its cursor or was replaced is the next generation of its stream id
//    (FM-087): the old cursor is never moved back (INV-35).
// 3. A session whose identity has no dwarf yet is observed (`SessionObserved`, once per identity,
//    stream and first-message flag in a Host run, 08 §2.3), and its messages and usage wait: the
//    stream's cursor is held so nothing passes an unwritten message (16 §4.3), and the next cycle
//    writes them to the dwarf the route made (05 §4: `mines.resolveForSession` → `crew.arrive`).
//    A batch with nothing to write moves only the cursor (INV-39 "the cursor only").
// 4. Otherwise one transaction: the batch's messages and usage through `ObservedBatchSink`, then
//    the cursor advance, then the observed-session index rows (the stream link needs its cursor
//    row, 09 §4.2). Only those writes (INV-37). A throw rolls the whole batch back and the next
//    cycle re-reads it from the old position.
// 5. After the commit only, the batch's events (16 §2.3, §4.3 "Ordering"; 09 §5.2 step 6).
//
// A session that is closed (a close record, or its dwarf departed) takes no further transition
// from a late write (S4.40): its records move the cursor and nothing else.
//
// Anti-ghost (INV-36; 16 §4.3 `EndedAgentLedger`; 15 §5 item 2): every identity DwarfAI ended or
// saw end joins the ledger, whatever path ended it: the terminator's `recordEnded` (ADR-014
// item 7), or an adapter's `closed` fact, recorded in its batch's transaction. A subagent of an
// ended session is ended too: it ran inside that session's process. An ended identity with no
// dwarf is dropped before `SessionObserved` (07 S4.30 guard; S3.22, S4.40; FM-092): its records
// move the cursor and nothing else, so a late write raises no ghost and rediscovers no removed
// mine. An ended identity whose dwarf is still present (it arrived while its ending was being
// read) is closed (S4.33), because an `active` session is never in the ledger (07 §4B).
//
// `catchUp` (later: ISSUE-078) joins with its issue.
import { providerIdentityKey } from '../../../kernel/domain/providerIdentity'
import type {
  DwarfId,
  EventId,
  FolderPath,
  HostEpoch,
  Instant,
  ProviderIdentity
} from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { ConversationEntry, UsageObservation } from '../../suppliers'
import { generationStreamId, sourceRestarted } from '../domain/cursor'
import { holdsFirstMessage } from '../domain/firstMessage'
import { observedTransition } from '../domain/observedSession'
import type { CursorStore } from '../ports/cursorStore'
import type {
  Cursor,
  ObservationAdapter,
  ObservedEvent,
  SourceFile
} from '../ports/observationAdapter'
import type { EndedAgentLedger } from '../ports/endedAgentLedger'
import type { ObservedBatchSink } from '../ports/observedBatchSink'
import type { ObservedSession, ObservedSessionStore } from '../ports/observedSessionStore'
import type { ObservationEvent } from './events'

/** The poll interval (FM-089: polling is the backbone; today's `poller.ts` interval). */
export const OBSERVATION_POLL_MS = 2_000

/** The ceiling on generations probed for one source (FM-087), against a corrupt cursor table. */
const MAX_GENERATIONS = 64

export interface ObservationLoopDeps {
  /** One per provider (05 §3.3); each declares its capabilities as data (HO-14). */
  adapters: readonly ObservationAdapter[]
  fs: FileSystem
  cursors: CursorStore
  sessions: ObservedSessionStore
  /**
   * The identities DwarfAI ended or saw end (16 §4.3; INV-36). `createObservation` always passes
   * it; it is absent only where a test composes the loop without the module's stores.
   */
  ended?: EndedAgentLedger
  /** The `host/wiring` bridge to conversation and ledger (AMENDMENT-10). */
  sink: ObservedBatchSink
  transactions: TransactionRunner
  bus: Pick<DomainEventBus<ObservationEvent>, 'publish'>
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** Defaults to `OBSERVATION_POLL_MS`. */
  pollMs?: number
}

/** The hint a hook ingress passes (05 §3.3); the loop reads every source anyway. */
export interface NudgeHint {
  providerId: string
  path?: string
  sessionId?: string
}

type Pending = ObservationEvent extends infer E
  ? E extends { type: infer T; payload: infer P }
    ? { type: T; payload: P }
    : never
  : never

/** One identity's records of a batch. */
interface IdentityRecords {
  identity: ProviderIdentity
  events: ObservedEvent[]
}

/** What a batch writes and publishes once its plan is made. */
interface BatchPlan {
  held: boolean
  /** Identities the batch saw end, recorded in its transaction. */
  ended: Array<{ identity: ProviderIdentity; at: Instant }>
  sinks: Array<{ dwarfId: DwarfId; entries: ConversationEntry[]; usage: UsageObservation[] }>
  sessions: ObservedSession[]
  links: Array<{ dwarfId: DwarfId; streamId: string }>
  /** Published after the commit (or at once when nothing is written). */
  events: Pending[]
}

export class ObservationLoop {
  private running = false
  private timer: { cancel(): void } | null = null
  private cycle: Promise<void> | null = null
  private rerun = false
  /** `SessionObserved` already published this Host run (08 §2.3 key `identity` + `streamId`). */
  private readonly announced = new Set<string>()
  /** The cwd of an identity seen in an earlier batch, for a later batch that carries none. */
  private readonly cwdOf = new Map<string, FolderPath>()
  /** The identity of each dwarf a batch was written to this Host run. */
  private readonly identityOfDwarf = new Map<DwarfId, ProviderIdentity>()

  constructor(private readonly deps: ObservationLoopDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.kick()
  }

  stop(): void {
    this.running = false
    this.rerun = false
    this.timer?.cancel()
    this.timer = null
  }

  nudge(_hint: NudgeHint): void {
    if (!this.running) return
    this.kick()
  }

  /**
   * 16 §4.3 `ObservationControl.recordEnded`: the terminator bridge ended this identity (ADR-014
   * item 7); it joins the ledger and never arrives again. A second record is a no-op.
   */
  recordEnded(identity: ProviderIdentity, at: Instant): void {
    const ended = this.deps.ended
    if (ended === undefined) return
    this.deps.transactions.inTransaction(() => ended.record(identity, at))
  }

  /** The identity of a dwarf a batch was written to this Host run, or null. */
  identityOf(dwarfId: DwarfId): ProviderIdentity | null {
    return this.identityOfDwarf.get(dwarfId) ?? null
  }

  /** Resolves once no cycle is in flight, including the reruns nudges asked for. */
  async whenIdle(): Promise<void> {
    while (this.cycle !== null) await this.cycle
  }

  private kick(): void {
    if (this.cycle !== null) {
      this.rerun = true
      return
    }
    this.timer?.cancel()
    this.timer = null
    this.cycle = this.runCycles().finally(() => {
      this.cycle = null
      this.schedule()
    })
  }

  private schedule(): void {
    if (!this.running || this.timer !== null) return
    this.timer = this.deps.scheduler.after(this.deps.pollMs ?? OBSERVATION_POLL_MS, () => {
      this.timer = null
      this.kick()
    })
  }

  private async runCycles(): Promise<void> {
    do {
      this.rerun = false
      for (const adapter of this.deps.adapters) {
        if (!this.running) return
        await this.observe(adapter)
      }
    } while (this.rerun && this.running)
  }

  private async observe(adapter: ObservationAdapter): Promise<void> {
    let sources: SourceFile[]
    try {
      sources = await adapter.discover(this.deps.fs)
    } catch {
      this.drift(adapter, 'discover')
      return
    }
    const seen = new Set<string>()
    for (const source of sources) {
      if (!this.running) return
      if (seen.has(source.streamId)) continue
      seen.add(source.streamId)
      await this.observeSource(adapter, source)
    }
  }

  private async observeSource(adapter: ObservationAdapter, source: SourceFile): Promise<void> {
    const { streamId, from } = this.generationOf(source)
    let batch: Awaited<ReturnType<ObservationAdapter['read']>>
    try {
      batch = await adapter.read({ ...source, streamId }, from)
    } catch {
      this.drift(adapter, 'read')
      return
    }
    for (let n = 0; n < batch.warnings.length; n++) this.drift(adapter, 'record')
    const plan = this.plan(adapter, streamId, batch.events)
    if (plan.held) {
      this.publishAll(plan.events)
      return
    }
    try {
      this.deps.transactions.inTransaction(() => {
        for (const { identity, at } of plan.ended) this.deps.ended?.record(identity, at)
        for (const sink of plan.sinks) this.deps.sink.apply(sink)
        this.deps.cursors.advance(streamId, batch.next)
        for (const session of plan.sessions) this.deps.sessions.save(session)
        for (const link of plan.links) this.deps.sessions.saveStream(link)
      })
    } catch {
      // Rolled back whole: the next cycle re-reads the batch from the old position (16 §4.3).
      this.deps.log.record({
        level: 'error',
        event: 'observation.batch-failed',
        subsystem: 'observation',
        provider: adapter.providerId,
        outcome: 'failed',
        msg: 'an observed batch was rolled back and will be read again'
      })
      return
    }
    this.publishAll(plan.events)
  }

  /** The generation of `source` its stored cursors say it is in (FM-087), and where to read from. */
  private generationOf(source: SourceFile): { streamId: string; from: Cursor | null } {
    for (let n = 0; n < MAX_GENERATIONS; n++) {
      const streamId = generationStreamId(source.streamId, n)
      const cursor = this.deps.cursors.get(streamId)
      if (cursor === null || !sourceRestarted(cursor, source)) return { streamId, from: cursor }
    }
    return { streamId: generationStreamId(source.streamId, MAX_GENERATIONS), from: null }
  }

  private plan(adapter: ObservationAdapter, streamId: string, events: ObservedEvent[]): BatchPlan {
    const plan: BatchPlan = {
      held: false,
      ended: [],
      sinks: [],
      sessions: [],
      links: [],
      events: []
    }
    const now = this.deps.clock.now()
    for (const { identity, events: records } of byIdentity(events)) {
      const key = providerIdentityKey(identity)
      const alreadyEnded = this.hasEnded(identity)
      const closing = records.find((r) => r.kind === 'closed')
      if (closing?.kind === 'closed' && !alreadyEnded) {
        plan.ended.push({ identity, at: closing.at })
      }
      const session = this.deps.sessions.byIdentity(identity)
      // Only its ending, and no dwarf: it ends without ever arriving (a subagent's ending read in
      // its session's transcript).
      const endsUnseen = session === null && records.every((r) => r.kind === 'closed')
      if (alreadyEnded || endsUnseen) {
        // Anti-ghost (INV-36): no arrival, no write; a dwarf still present is closed (S4.33).
        if (session !== null && session.closedAt === null) {
          plan.sessions.push({ ...session, closedAt: now })
          plan.events.push({ type: 'SessionClosedObserved', payload: { identity, at: now } })
        }
        continue
      }
      const cwd = records.map((r) => r.cwd).find((c) => c !== undefined) ?? this.cwdOf.get(key)
      if (cwd !== undefined) this.cwdOf.set(key, cwd)
      const entries = records.flatMap((r) => (r.kind === 'entries' ? r.entries : []))
      const usage = records.flatMap((r) => (r.kind === 'usage' ? [r.usage] : []))

      if (session === null) {
        const firstMessage = holdsFirstMessage(entries)
        const parent = records.find((r) => r.kind === 'session')
        const announceKey = JSON.stringify([key, streamId, firstMessage])
        if (cwd !== undefined && !this.announced.has(announceKey)) {
          this.announced.add(announceKey)
          plan.events.push({
            type: 'SessionObserved',
            payload: {
              identity,
              cwd,
              ...(parent?.kind === 'session' && parent.parentIdentity !== undefined
                ? { parentIdentity: parent.parentIdentity }
                : {}),
              firstMessage,
              streamId
            }
          })
        }
        // Messages, usage and turn ends need the dwarf: hold the stream until the route made it (16 §4.3).
        const turnEnds = records.some((r) => r.kind === 'turn-ended')
        if (entries.length > 0 || usage.length > 0 || turnEnds) plan.held = true
        continue
      }

      const step = observedTransition(session.closedAt === null ? 'active' : 'closed', {
        type: closing === undefined ? 'records' : 'closed-elsewhere'
      })
      // S4.40: a closed session takes no transition from a late write; only the cursor moves.
      if (!step.ok || session.closedAt !== null) continue

      const dwarfId = session.dwarfId
      this.identityOfDwarf.set(dwarfId, identity)
      if (entries.length > 0 || usage.length > 0) {
        plan.sinks.push({
          dwarfId,
          entries,
          usage: usage.map((u) => ({ ...u, dwarfId, observedAt: now }))
        })
      }
      plan.sessions.push({
        identity,
        dwarfId,
        cwd: cwd ?? session.cwd,
        firstSeenAt: session.firstSeenAt,
        lastRecordAt: Math.max(session.lastRecordAt, now),
        closedAt: closing?.kind === 'closed' ? closing.at : null
      })
      // A stream that only carries this identity's ending (a subagent's, in its session's
      // transcript) does not feed it.
      const feeds = records.some((r) => r.kind !== 'closed')
      if (feeds && !this.deps.sessions.streams(dwarfId).some((s) => s.streamId === streamId)) {
        plan.links.push({ dwarfId, streamId })
      }
      plan.events.push(...this.eventsOf(adapter, streamId, identity, records, dwarfId, now))
    }
    return plan
  }

  private eventsOf(
    adapter: ObservationAdapter,
    streamId: string,
    identity: ProviderIdentity,
    records: ObservedEvent[],
    dwarfId: DwarfId,
    now: number
  ): Pending[] {
    const out: Pending[] = []
    let closed = false
    for (const r of records) {
      switch (r.kind) {
        case 'entries':
          if (r.entries.length > 0) {
            out.push({
              type: 'TranscriptEntriesObserved',
              payload: { identity, entries: r.entries }
            })
          }
          break
        case 'usage':
          out.push({
            type: 'UsageObserved',
            payload: { observation: { ...r.usage, dwarfId, observedAt: now } }
          })
          break
        case 'activity':
          out.push({
            type: 'SessionActivityObserved',
            payload: {
              identity,
              sourceKey: `${adapter.providerId}:${streamId}:${r.sourceEventId}`,
              at: r.at,
              kind: r.activity
            }
          })
          break
        case 'turn-ended':
          out.push({
            type: 'ObservedTurnEnded',
            payload: { identity, end: { ...r.end, dwarfId } }
          })
          break
        case 'closed':
          // A session closes once: Claude Code writes one ending twice (queued, then delivered).
          if (!closed) out.push({ type: 'SessionClosedObserved', payload: { identity, at: r.at } })
          closed = true
          break
        case 'session':
          break
      }
    }
    return out
  }

  /** Whether the ledger holds the identity, or the session a subagent ran in. */
  private hasEnded(identity: ProviderIdentity): boolean {
    const ended = this.deps.ended
    if (ended === undefined) return false
    if (ended.has(identity)) return true
    if (identity.providerAgentId === undefined) return false
    return ended.has({
      providerId: identity.providerId,
      providerSessionId: identity.providerSessionId
    })
  }

  private publishAll(events: Pending[]): void {
    for (const event of events) {
      this.deps.bus.publish({
        ...event,
        v: 1,
        id: this.deps.ids.uuidv7() as EventId,
        at: this.deps.clock.now(),
        hostEpoch: this.deps.hostEpoch
      } as ObservationEvent)
    }
  }

  private drift(adapter: ObservationAdapter, where: 'discover' | 'read' | 'record'): void {
    // Nothing the provider wrote is logged: no path, no line, no error text (ADR-026 item 4).
    this.deps.log.record({
      level: 'warn',
      event: 'observation.drift',
      subsystem: 'observation',
      provider: adapter.providerId,
      outcome: 'skipped',
      causeClass: where,
      msg: 'unreadable or malformed provider data skipped'
    })
  }
}

/** A batch's records grouped by identity, in first-seen order. */
function byIdentity(events: ObservedEvent[]): IdentityRecords[] {
  const groups = new Map<string, IdentityRecords>()
  for (const event of events) {
    const key = providerIdentityKey(event.identity)
    const group = groups.get(key) ?? { identity: event.identity, events: [] }
    group.events.push(event)
    groups.set(key, group)
  }
  return [...groups.values()]
}
