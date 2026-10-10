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
// 3. A session whose identity has no dwarf yet is admitted by `admission` (owner decisions
//    2026-10-10): records all older than `install_moment` move the cursor and nothing else, so no
//    dwarf and no mine is made for history (pre-install history is the coal backfill's, ADR-006
//    item 8); a session never seen live (its batch already states its ending, or an adapter
//    reports it not live) arrives already departed (decision B): `SessionClosedObserved` follows
//    its `SessionObserved` in the same batch, so crew's route departs it as it arrives, and the
//    next cycle writes its batch once, with no event (its ore and its mine's history, never
//    present). An admitted session is observed (`SessionObserved`, once per identity,
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
// item 7), or an adapter's `closed` fact, recorded in its batch's transaction (a held batch
// records its endings alone, so a subagent it saw end is not announced by its own stream). A subagent of an
// ended session is ended too: it ran inside that session's process. An ended identity with no
// dwarf is dropped before `SessionObserved` (07 S4.30 guard; S3.22, S4.40; FM-092): its records
// move the cursor and nothing else, so a late write raises no ghost and rediscovers no removed
// mine. An ended identity whose dwarf is still present (it arrived while its ending was being
// read) is closed (S4.33), because an `active` session is never in the ledger (07 §4B).
//
// Provider errors (ISSUE-084; 13 FM-067, FM-068; ADR-026 item 6): every read of a stream is
// counted by the `ProviderErrorFold` of domain/providerError.ts, opened once per poll cycle. A read
// that skipped records and read none, or that threw, is an unreadable read of its stream; a streak
// of them surfaces for the stream's dwarf (the present dwarf of the identity the stream last carried
// records of in this Host run; none when the stream never read or its dwarf departed) once as `ProviderErrorObserved {cause: 'unreadable'}`, published after
// the batch's own events, at most once per `(providerId, cause, dwarfId?)` and cycle. The dwarf's
// status is not touched: no event of this loop changes it (US-RES-004.AC02). A thrown read is
// logged with its `errCode` (`code`, else the error's name) and never its message (16 §2.1).
//
// `catchUp` (ISSUE-078) is one such cycle at Host boot, before the live loop starts: it reads every
// stream from the cursor the last Host left, so what was written while no Host ran is observed by
// these same rules (S4.38, S4.39; INV-98).
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
import { ProviderErrorFold, type ReadOutcome } from '../domain/providerError'
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
  /**
   * The adapters that can tell whether a session's process runs (the Claude adapter, through its
   * registry and #45 guard). None: every session's presence is unknown, and it is admitted.
   */
  presence?: readonly ObservedPresence[]
  /**
   * `install_moment.at` (ADR-023 item 2), read by `host/wiring` from the ledger at each batch; null
   * between a reset's `db` and `install-moment` steps, absent where a test composes no ledger.
   */
  installMoment?: () => Instant | null
}

/**
 * What an adapter can tell of a session's process (owner decision 2026-10-10): `live` while it
 * runs, `not-live` when it provably does not, `unknown` when nothing can be told (presence fails
 * open, #45 polarity). Internal to the module, beside `ObservedProcessRegistry`: not a port (16
 * §4.3 is unchanged), and read only when a session first arrives, never to close a present one.
 */
export interface ObservedPresence {
  presenceOf(identity: ProviderIdentity): 'live' | 'not-live' | 'unknown'
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
  /** How many times `stop` ran: a catch-up pass ends when it changes. */
  private halts = 0
  private timer: { cancel(): void } | null = null
  private cycle: Promise<void> | null = null
  private rerun = false
  /** `SessionObserved` already published this Host run (08 §2.3 key `identity` + `streamId`). */
  private readonly announced = new Set<string>()
  /** Identities announced already departed this Host run whose batch is not written yet. */
  private readonly arrivingDeparted = new Set<string>()
  /** The cwd of an identity seen in an earlier batch, for a later batch that carries none. */
  private readonly cwdOf = new Map<string, FolderPath>()
  /** The identity of each dwarf a batch was written to this Host run. */
  private readonly identityOfDwarf = new Map<DwarfId, ProviderIdentity>()
  /** The identity each stream last carried records of, this Host run (ISSUE-084). */
  private readonly identityOfStream = new Map<string, ProviderIdentity>()
  /** Provider errors, folded per cause and cycle, drift counted before it surfaces (ISSUE-084). */
  private readonly errors = new ProviderErrorFold()

  constructor(private readonly deps: ObservationLoopDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.kick()
  }

  stop(): void {
    this.running = false
    this.halts += 1
    this.rerun = false
    this.timer?.cancel()
    this.timer = null
  }

  nudge(_hint: NudgeHint): void {
    if (!this.running) return
    this.kick()
  }

  /**
   * 16 §4.3 `ObservationControl.catchUp` (16 §8.2 step 7; 09 §5.4; 07 S4.37–S4.39): one pass over
   * every stream every adapter discovers, each read from its cursor, under the same batch rules as
   * a live cycle. Whatever a provider wrote while no Host ran is therefore written and credited
   * once (INV-98, ADR-006 item 7): a re-read batch carries the same source and unit keys. A session
   * whose ending was written meanwhile is closed and published once (`SessionClosedObserved`, the
   * ordinary departure), and the anti-ghost check runs first, so an ended identity is never
   * resurrected (INV-36). A stream with no cursor is read from its start (09 §5.4), and a session
   * with no dwarf is admitted as `admission` says (owner decisions 2026-10-10): one that started
   * and ended while no Host ran arrives already departed and what it spent is credited in full. A batch that fails rolls back alone and the next pass (this Host's live loop,
   * or the next boot) reads it again from its cursor. A new session's messages wait for its dwarf
   * as in a live cycle (the held stream): the first live cycle after `start` writes them.
   *
   * It runs whether or not the live loop has started, one cycle at a time with it: a live cycle in
   * flight finishes first, and a nudge or `start` during the pass runs its cycle after it. A `stop`
   * during the pass ends it after the stream being read.
   */
  async catchUp(): Promise<void> {
    while (this.cycle !== null) await this.cycle
    const halts = this.halts
    const pass = (async () => {
      this.errors.beginCycle()
      for (const adapter of this.deps.adapters) {
        if (this.halts !== halts) return
        await this.observe(adapter, () => this.halts === halts)
      }
    })()
    this.cycle = pass.finally(() => {
      this.cycle = null
      if (this.rerun && this.running) this.kick()
      else this.schedule()
    })
    await pass
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
      this.errors.beginCycle()
      for (const adapter of this.deps.adapters) {
        if (!this.running) return
        await this.observe(adapter, () => this.running)
      }
    } while (this.rerun && this.running)
  }

  /** One adapter's streams, each from its cursor, while `active` holds. */
  private async observe(adapter: ObservationAdapter, active: () => boolean): Promise<void> {
    let sources: SourceFile[]
    try {
      sources = await adapter.discover(this.deps.fs)
    } catch (error) {
      this.drift(adapter, 'discover', error)
      this.countRead(adapter, null, { readable: false, drifted: true })
      return
    }
    const seen = new Set<string>()
    for (const source of sources) {
      if (!active()) return
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
    } catch (error) {
      this.drift(adapter, 'read', error)
      this.countRead(adapter, streamId, { readable: false, drifted: true })
      return
    }
    for (let n = 0; n < batch.warnings.length; n++) this.drift(adapter, 'record')
    const plan = this.plan(adapter, streamId, batch.events, from === null)
    // A session record alone is no readable content: a provider whose format changed still names it.
    const outcome: ReadOutcome = {
      readable: batch.events.some((e) => e.kind !== 'session'),
      drifted: batch.warnings.length > 0
    }
    if (plan.held) {
      // The stream waits for a dwarf, but the endings it states join the ledger now (INV-36): a
      // subagent that ended is never announced by its own stream, read later in the cycle.
      if (plan.ended.length > 0 && !this.recordEndings(adapter, plan.ended)) return
      this.publishAll(plan.events)
      this.countRead(adapter, streamId, outcome)
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
    this.countRead(adapter, streamId, outcome)
  }

  /** Records a held batch's endings in their own transaction; false when it rolled back. */
  private recordEndings(adapter: ObservationAdapter, ended: BatchPlan['ended']): boolean {
    try {
      this.deps.transactions.inTransaction(() => {
        for (const { identity, at } of ended) this.deps.ended?.record(identity, at)
      })
      return true
    } catch {
      this.deps.log.record({
        level: 'error',
        event: 'observation.batch-failed',
        subsystem: 'observation',
        provider: adapter.providerId,
        outcome: 'failed',
        msg: 'an observed batch was rolled back and will be read again'
      })
      return false
    }
  }

  /** Counts one read toward its dwarf's drift; publishes the provider error a streak surfaces. */
  private countRead(
    adapter: ObservationAdapter,
    streamId: string | null,
    outcome: ReadOutcome
  ): void {
    const dwarfId = streamId === null ? undefined : this.presentDwarfOf(streamId)
    const report = this.errors.read(
      {
        providerId: adapter.providerId,
        ...(dwarfId === undefined ? {} : { dwarfId }),
        ...(streamId === null ? {} : { streamId })
      },
      outcome
    )
    if (report !== null) this.publishAll([{ type: 'ProviderErrorObserved', payload: report }])
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

  private plan(
    adapter: ObservationAdapter,
    streamId: string,
    events: ObservedEvent[],
    fromStart: boolean
  ): BatchPlan {
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
      if (records.some((r) => r.kind !== 'closed')) this.identityOfStream.set(streamId, identity)
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
      // Admission (owner decisions 2026-10-10): history before the install moment never arrives;
      // a session that is not running arrives already departed.
      const admission =
        session === null ? this.admission(identity, records, closing !== undefined) : 'present'
      if (admission === 'refused') continue
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
          if (admission === 'departed') {
            // Its ending right after its arrival: crew's route departs the dwarf as it arrives,
            // so it is never present (owner decision B). Its ledger row waits for its batch.
            this.arrivingDeparted.add(key)
            plan.events.push({
              type: 'SessionClosedObserved',
              payload: { identity, at: closing?.kind === 'closed' ? closing.at : now }
            })
          }
        }
        if (admission === 'departed') {
          plan.ended = plan.ended.filter((e) => providerIdentityKey(e.identity) !== key)
        }
        // Messages, usage and turn ends need the dwarf: hold the stream until the route made it (16 §4.3).
        const turnEnds = records.some((r) => r.kind === 'turn-ended')
        if (entries.length > 0 || usage.length > 0 || turnEnds) plan.held = true
        continue
      }

      // A session that arrived already departed (owner decision B): its batch is written once, for
      // its ore and its mine's history, and moves nothing (no event: it was never present). Known
      // by this Host run, or after a restart by its stream: still read from its start (the batch
      // was held for the arrival) while its departed dwarf was never fed. A late write of a closed
      // session comes after a cursor and stays S4.40's.
      if (
        this.arrivingDeparted.has(key) ||
        (fromStart &&
          session.closedAt !== null &&
          this.deps.sessions.streams(session.dwarfId).length === 0)
      ) {
        this.arrivingDeparted.delete(key)
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
          closedAt: session.closedAt ?? (closing?.kind === 'closed' ? closing.at : now)
        })
        if (records.some((r) => r.kind !== 'closed')) plan.links.push({ dwarfId, streamId })
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

  /**
   * How a session with no dwarf arrives (owner decisions 2026-10-10; US-OBS-005, FM-059):
   *
   * - `refused` when everything it wrote predates the install moment: that history reaches the
   *   product only through the coal backfill (ADR-006 item 8, ADR-029 row 6). Its records move the
   *   cursor and nothing else (INV-39 "the cursor only"). A record with no provider time says
   *   nothing of when it was written, so it does not count as history;
   * - `departed` (decision B) when it was never seen live: its batch already states its ending, or
   *   an adapter knows its process is not running. It arrives and departs in the same pass, earns
   *   its ore (ADR-006 item 7, OQ-14) and joins its mine's history (OQ-02), never present. Not
   *   running is not an ending: no ledger row for it;
   * - `present` otherwise.
   */
  private admission(
    identity: ProviderIdentity,
    records: ObservedEvent[],
    closed: boolean
  ): 'refused' | 'departed' | 'present' {
    const moment = this.deps.installMoment?.() ?? null
    const newest = newestProviderTime(records)
    if (moment !== null && newest !== null && newest < moment) return 'refused'
    if (closed) return 'departed'
    const notLive = (this.deps.presence ?? []).some((p) => p.presenceOf(identity) === 'not-live')
    return notLive ? 'departed' : 'present'
  }

  /** The dwarf of the identity a stream carries, while it is present (not departed). */
  private presentDwarfOf(streamId: string): DwarfId | undefined {
    const identity = this.identityOfStream.get(streamId)
    const session = identity === undefined ? null : this.deps.sessions.byIdentity(identity)
    return session !== null && session.closedAt === null ? session.dwarfId : undefined
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

  private drift(
    adapter: ObservationAdapter,
    where: 'discover' | 'read' | 'record',
    error?: unknown
  ): void {
    // Nothing the provider wrote is logged: no path, no line, no error text (ADR-026 item 4); a
    // failed read keeps only its code (16 §2.1).
    const errCode = error === undefined ? undefined : errCodeOf(error)
    this.deps.log.record({
      level: 'warn',
      event: 'observation.drift',
      subsystem: 'observation',
      provider: adapter.providerId,
      outcome: 'skipped',
      causeClass: where,
      ...(errCode === undefined ? {} : { errCode }),
      msg: 'unreadable or malformed provider data skipped'
    })
  }
}

/** The code of a thrown error (19 §9 `errCode` = `err.code`, else `err.name`), never its message. */
function errCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') return String(code)
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return 'unknown'
}

/**
 * The newest provider time among records (the instant the provider wrote them), or null when none
 * carries one. A `closed` fact's instant is when the Host saw the ending, never a provider time.
 */
function newestProviderTime(records: ObservedEvent[]): Instant | null {
  let newest: Instant | null = null
  const see = (at: Instant | null | undefined): void => {
    if (typeof at === 'number' && Number.isFinite(at) && (newest === null || at > newest)) {
      newest = at
    }
  }
  for (const r of records) {
    switch (r.kind) {
      case 'session':
      case 'activity':
      case 'turn-ended':
        see(r.at)
        break
      case 'entries':
        for (const e of r.entries) see(e.providerTime)
        break
      case 'usage':
        see(r.usage.providerTime)
        break
      case 'closed':
        break
    }
  }
  return newest
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
