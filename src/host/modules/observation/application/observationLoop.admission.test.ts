// layer: L2
// L2 (17 §1.2): which sessions the observation loop admits as present dwarfs (owner decision
// 2026-10-10, resolving a package gap): "A provider transcript whose process is not alive at first
// sight, or whose last record predates `install_moment`, never arrives as a present dwarf and never
// creates a mine. Pre-install history reaches the product only through the coal backfill (ADR-006
// item 8, ADR-029 row 6)." Presence is driven by the process (US-OBS-005; FM-059). Over the
// module's in-memory doubles and a scripted `FakeObservationAdapter`.
import { describe, expect, it } from 'vitest'
import type { FolderPath, Instant, ProviderIdentity } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import { FakeObservationAdapter } from '../ports/fakes/FakeObservationAdapter'
import { InMemoryCursorStore } from '../ports/fakes/InMemoryCursorStore'
import { InMemoryEndedAgentLedger } from '../ports/fakes/InMemoryEndedAgentLedger'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../ports/fakes/RecordingObservedBatchSink'
import type { Cursor, ObservedEvent, SourceFile } from '../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import type { ObservationEvent } from './events'
import { OBSERVATION_POLL_MS, ObservationLoop, type ObservedPresence } from './observationLoop'

/** The install moment of every test: the fresh install of the Host database. */
const INSTALLED = 1_790_000_000_000
const BEFORE = INSTALLED - 86_400_000
const AFTER = INSTALLED + 60_000
const MINE = '/work/moria' as FolderPath

const identity = (n: number, agent?: string): ProviderIdentity => ({
  providerId: 'simulated',
  providerSessionId: `session-${n}`,
  ...(agent === undefined ? {} : { providerAgentId: agent })
})

const source = (streamId: string): SourceFile => ({
  streamId,
  adapterId: 'simulated',
  path: `/provider/${streamId}.jsonl`,
  fileIdentity: `file-${streamId}`,
  size: 1_000
})

const cursorOf = (streamId: string, value: number): Cursor => ({
  adapterId: 'simulated',
  kind: 'byte-offset',
  value,
  fileIdentity: `file-${streamId}`
})

/** A session's transcript as a provider writes it: its start, a person message, one usage unit. */
function transcript(who: ProviderIdentity, at: Instant, tag: string): ObservedEvent[] {
  return [
    { kind: 'session', sourceEventId: `${tag}-0`, identity: who, cwd: MINE, at },
    {
      kind: 'entries',
      sourceEventId: `${tag}-1`,
      identity: who,
      entries: [
        { sourceKey: `simulated:${tag}:1`, role: 'person', text: 'Dig here', providerTime: at }
      ]
    },
    {
      kind: 'usage',
      sourceEventId: `${tag}-2`,
      identity: who,
      usage: {
        sourceKey: `simulated:${tag}:2`,
        unitKey: `${tag}-unit`,
        fidelity: 1,
        tokens: { inputNet: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sealed: true,
        providerTime: at
      }
    },
    { kind: 'activity', sourceEventId: `${tag}-3`, identity: who, at, activity: 'record' }
  ]
}

/** What the scripted presence source says of each session (by session id); unknown otherwise. */
class ScriptedPresence implements ObservedPresence {
  readonly says = new Map<string, 'live' | 'not-live' | 'unknown'>()
  presenceOf(i: ProviderIdentity): 'live' | 'not-live' | 'unknown' {
    return this.says.get(i.providerSessionId) ?? 'unknown'
  }
}

function world(options: { installMoment?: Instant | null } = {}) {
  const transactions = new InMemoryTransactions()
  const dwarfs = new InMemoryBoundDwarfs()
  const cursors = new InMemoryCursorStore(transactions)
  const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
  const ended = new InMemoryEndedAgentLedger(transactions)
  const sink = new RecordingObservedBatchSink(transactions)
  for (const participant of [cursors, sessions, ended, sink]) transactions.enlist(participant)
  const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
  const clock = new FakeClock(AFTER + 3_600_000)
  const adapter = new FakeObservationAdapter('simulated')
  const presence = new ScriptedPresence()
  const moment = options.installMoment === undefined ? INSTALLED : options.installMoment
  const deps = {
    adapters: [adapter],
    fs: {} as FileSystem,
    cursors,
    sessions,
    ended,
    sink,
    transactions,
    bus,
    clock,
    scheduler: new FakeScheduler(clock),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-ghosts',
    log: new RecordingDiagnosticsLog(),
    presence: [presence],
    installMoment: () => moment
  }
  const loop = new ObservationLoop(deps)
  /** Scripts `streamId` to answer `events` from no cursor, and nothing more after it. */
  const place = (streamId: string, events: ObservedEvent[]) => {
    adapter.sources.push(source(streamId))
    adapter.onRead(streamId, (from) =>
      from === null || from.value === 0
        ? { events, next: cursorOf(streamId, 1_000), warnings: [] }
        : { events: [], next: from, warnings: [] }
    )
  }
  const poll = async () => {
    clock.advance(OBSERVATION_POLL_MS)
    await loop.whenIdle()
  }
  const announced = () =>
    bus.published.flatMap((e) => (e.type === 'SessionObserved' ? [e.payload.identity] : []))
  const closings = () =>
    bus.published.flatMap((e) => (e.type === 'SessionClosedObserved' ? [e.payload.identity] : []))
  /** The events that would move a present dwarf or cue the person: none for a departed arrival. */
  const cues = () =>
    bus.published.filter(
      (e) =>
        e.type === 'TranscriptEntriesObserved' ||
        e.type === 'UsageObserved' ||
        e.type === 'SessionActivityObserved' ||
        e.type === 'ObservedTurnEnded'
    )
  return {
    deps,
    cursors,
    dwarfs,
    sessions,
    ended,
    sink,
    bus,
    clock,
    adapter,
    presence,
    loop,
    place,
    poll,
    announced,
    closings,
    cues
  }
}

describe('ObservationLoop admits only live sessions written after the install moment', () => {
  it('[US-OBS-005, ADR-006] a stream whose newest record predates the install moment moves its cursor to its end with no arrival, no write and no ledger row', async () => {
    const w = world()
    w.presence.says.set('session-1', 'live')
    w.place('s1', transcript(identity(1), BEFORE, 'a'))
    w.loop.start()
    await w.loop.whenIdle()
    await w.poll()

    expect(w.announced()).toEqual([])
    expect(w.cursors.get('s1')?.value).toBe(1_000)
    expect(w.sink.applied).toEqual([])
    expect(w.ended.has(identity(1))).toBe(false)
    w.loop.stop()
  })

  it('[US-OBS-005, ADR-006] a stream written after the install moment by a live session arrives', async () => {
    const w = world()
    w.presence.says.set('session-1', 'live')
    w.place('s1', transcript(identity(1), AFTER, 'a'))
    w.loop.start()
    await w.loop.whenIdle()

    expect(w.announced()).toEqual([identity(1)])
    // Its messages wait for its dwarf (the held stream), then are written to it.
    expect(w.cursors.get('s1')).toBeNull()
    w.dwarfs.bind(identity(1), MINE, AFTER)
    await w.poll()
    expect(w.sink.applied).toHaveLength(1)
    expect(w.cursors.get('s1')?.value).toBe(1_000)
    w.loop.stop()
  })

  it('[US-OBS-005, ADR-006] a post-install session its adapter reports not live at first sight arrives already departed: closed with its arrival, its batch written once with no cue, not taken for ended', async () => {
    // Owner decision B (2026-10-10): it earns its ore and joins its mine's history, never present.
    const w = world()
    w.presence.says.set('session-1', 'not-live')
    w.place('s1', transcript(identity(1), AFTER, 'a'))
    w.loop.start()
    await w.loop.whenIdle()

    // Announced and closed in the same batch, so crew's route departs it as it arrives.
    expect(w.announced()).toEqual([identity(1)])
    expect(w.closings()).toEqual([identity(1)])
    expect(w.cursors.get('s1')).toBeNull()

    // The route made its dwarf (here it never departs it: the loop must not close it twice).
    w.dwarfs.bind(identity(1), MINE, AFTER)
    await w.poll()
    await w.poll()

    expect(w.sink.applied).toHaveLength(1)
    expect(w.sink.applied[0]!.usage.map((u) => u.unitKey)).toEqual(['a-unit'])
    expect(w.cues()).toEqual([])
    expect(w.closings()).toEqual([identity(1)])
    expect(w.cursors.get('s1')?.value).toBe(1_000)
    expect(w.sessions.byIdentity(identity(1))?.closedAt).not.toBeNull()
    // Not live is not ended (INV-36 is for endings): nothing is put in the ledger.
    expect(w.ended.has(identity(1))).toBe(false)
    w.loop.stop()
  })

  it('[ADR-006, INV-98] a departed arrival whose batch was not written before a Host restart is written once by the next Host', async () => {
    const w = world()
    w.presence.says.set('session-1', 'not-live')
    w.place('s1', transcript(identity(1), AFTER, 'a'))
    w.loop.start()
    await w.loop.whenIdle()
    w.loop.stop()
    // Crew's route made and departed its dwarf; then the Host stopped before the next cycle.
    const dwarfId = w.dwarfs.bind(identity(1), MINE, AFTER)
    w.dwarfs.depart(dwarfId, AFTER + 1)

    const next = new ObservationLoop(w.deps)
    await next.catchUp()
    await next.catchUp()

    expect(w.sink.applied).toHaveLength(1)
    expect(w.cues()).toEqual([])
    expect(w.cursors.get('s1')?.value).toBe(1_000)
  })

  it('[US-OBS-005] a session whose presence cannot be told arrives (presence fails open)', async () => {
    const w = world()
    w.place('s1', transcript(identity(1), AFTER, 'a'))
    w.loop.start()
    await w.loop.whenIdle()
    expect(w.announced()).toEqual([identity(1)])
    w.loop.stop()
  })

  it('[INV-36, ADR-006] a post-install session whose first batch already states its ending arrives already departed, its batch is written once and its ending joins the ledger with it', async () => {
    const w = world()
    w.presence.says.set('session-1', 'live')
    w.place('s1', [
      ...transcript(identity(1), AFTER, 'a'),
      { kind: 'closed', sourceEventId: 'gone', identity: identity(1), at: AFTER + 5 }
    ])
    w.loop.start()
    await w.loop.whenIdle()
    expect(w.announced()).toEqual([identity(1)])
    expect(w.closings()).toEqual([identity(1)])
    // Its ending waits for its batch: in the ledger first, the batch would never be written.
    expect(w.ended.has(identity(1))).toBe(false)

    w.dwarfs.bind(identity(1), MINE, AFTER)
    await w.poll()
    await w.poll()

    expect(w.sink.applied).toHaveLength(1)
    expect(w.cues()).toEqual([])
    expect(w.closings()).toEqual([identity(1)])
    expect(w.ended.has(identity(1))).toBe(true)
    expect(w.cursors.get('s1')?.value).toBe(1_000)
    w.loop.stop()
  })

  it('[INV-36] the subagent endings a held batch carries join the ledger, so those subagents never arrive', async () => {
    const w = world()
    w.presence.says.set('session-1', 'live')
    const worker = identity(1, 'worker-1')
    // The session's own stream (held for its dwarf) states that its worker ended; the worker's
    // stream is read after it in the same cycle.
    w.place('s1', [
      ...transcript(identity(1), AFTER, 'a'),
      { kind: 'closed', sourceEventId: 'done', identity: worker, at: AFTER + 5 }
    ])
    w.place('s1-worker', transcript(worker, AFTER, 'b'))
    w.loop.start()
    await w.loop.whenIdle()

    expect(w.announced()).toEqual([identity(1)])
    expect(w.ended.has(worker)).toBe(true)
    w.loop.stop()
  })

  it('[US-OBS-005, ADR-029] regression: over a fresh database, pre-install history makes nothing, post-install sessions not running arrive departed, and the running one arrives present', async () => {
    const w = world()
    // 40 sessions of history, before the install moment, none running; a subagent among them.
    for (let n = 1; n <= 40; n++) {
      w.presence.says.set(`session-${n}`, 'not-live')
      w.place(`old-${n}`, transcript(identity(n), BEFORE - n * 1_000, `old-${n}`))
    }
    w.place('old-1-worker', transcript(identity(1, 'worker-1'), BEFORE, 'old-1-worker'))
    // 5 sessions written after the install moment that ended while no Host ran.
    for (let n = 41; n <= 45; n++) {
      w.presence.says.set(`session-${n}`, 'not-live')
      w.place(`late-${n}`, transcript(identity(n), AFTER, `late-${n}`))
    }
    // One session running now.
    w.presence.says.set('session-99', 'live')
    w.place('live-99', transcript(identity(99), AFTER, 'live-99'))

    await w.loop.catchUp()
    w.loop.start()
    await w.loop.whenIdle()
    const late = [41, 42, 43, 44, 45].map((n) => identity(n))
    expect(w.announced()).toEqual([...late, identity(99)])
    expect(w.closings()).toEqual(late)
    for (const who of late) w.dwarfs.bind(who, MINE, AFTER)
    const liveDwarf = w.dwarfs.bind(identity(99), MINE, AFTER)
    for (let n = 0; n < 3; n++) await w.poll()

    for (let n = 1; n <= 40; n++) expect(w.cursors.get(`old-${n}`)?.value, `old-${n}`).toBe(1_000)
    // Every post-install unit is credited once; nothing of the history is.
    const units = w.sink.applied.flatMap((b) => b.usage.map((u) => u.unitKey)).sort()
    expect(units).toEqual(
      ['late-41', 'late-42', 'late-43', 'late-44', 'late-45', 'live-99'].map((t) => `${t}-unit`)
    )
    // Only the running session moved like a present dwarf.
    expect(w.closings()).toEqual(late)
    const cuedFor = w
      .cues()
      .map((e) =>
        e.type === 'UsageObserved'
          ? e.payload.observation.dwarfId
          : e.payload.identity.providerSessionId
      )
    expect(new Set(cuedFor)).toEqual(new Set([liveDwarf, 'session-99']))
    w.loop.stop()
  })

  it('[ADR-006] with no install moment (a reset in flight) the boundary does not apply: presence alone decides', async () => {
    const w = world({ installMoment: null })
    w.presence.says.set('session-1', 'live')
    w.place('s1', transcript(identity(1), BEFORE, 'a'))
    w.loop.start()
    await w.loop.whenIdle()
    expect(w.announced()).toEqual([identity(1)])
    w.loop.stop()
  })
})
