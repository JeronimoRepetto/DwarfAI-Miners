// layer: L2
// L2 (17 §1.2): a subagent its `<task-notification>` ended, then resumed by its coordinator
// (Claude Code's SendMessage appends to the same `agent-<id>.jsonl`), comes back present as its
// resumed generation (owner amendment I; 07 S4.41) while its session runs, and the ended identity
// itself never arrives again (INV-36). The adapter states the resume as a fresh `session` fact of
// the agent at the coordinator's message (`fixtures/claude/observer/2.1.x/resumed-subagent.jsonl`);
// here a scripted `FakeObservationAdapter` plays it over the module's in-memory doubles.
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
import type { ObservedEvent, SourceFile } from '../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import type { ObservationEvent } from './events'
import { OBSERVATION_POLL_MS, ObservationLoop, type ObservedPresence } from './observationLoop'

const INSTALLED = 1_790_000_000_000
const AFTER = INSTALLED + 60_000
/** When the agent's first run ended: its notification's own time. */
const ENDED = AFTER + 20_000
/** When its coordinator messaged it again. */
const RESUMED = AFTER + 60_000
const MINE = '/work/moria' as FolderPath

const SESSION: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-1' }
const WORKER: ProviderIdentity = { ...SESSION, providerAgentId: 'worker-1' }
/** A resumed generation of the worker: owner amendment I's naming on its agent id. */
const generation = (departedAt: Instant): ProviderIdentity => ({
  ...SESSION,
  providerAgentId: `worker-1~resumed-${Math.floor(departedAt / 1_000)}`
})

const source = (streamId: string): SourceFile => ({
  streamId,
  adapterId: 'simulated',
  path: `/provider/${streamId}.jsonl`,
  fileIdentity: `file-${streamId}`,
  // Large enough for every batch a test writes: a cursor past it would start a new generation.
  size: 1_000_000
})

/** The worker's records of one stretch: a message, one usage unit, a record of activity. */
function work(who: ProviderIdentity, at: Instant, tag: string): ObservedEvent[] {
  return [
    {
      kind: 'entries',
      sourceEventId: `${tag}-1`,
      identity: who,
      cwd: MINE,
      entries: [{ sourceKey: `simulated:${tag}:1`, role: 'dwarf', text: 'Dug', providerTime: at }]
    },
    {
      kind: 'usage',
      sourceEventId: `${tag}-2`,
      identity: who,
      cwd: MINE,
      usage: {
        sourceKey: `simulated:${tag}:2`,
        unitKey: `${tag}-unit`,
        fidelity: 1,
        tokens: { inputNet: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sealed: true,
        providerTime: at
      }
    },
    {
      kind: 'activity',
      sourceEventId: `${tag}-3`,
      identity: who,
      cwd: MINE,
      at,
      activity: 'record'
    }
  ]
}

/** The `session` fact an agent's transcript states when it starts, or when its coordinator resumes it. */
function started(who: ProviderIdentity, at: Instant, tag: string): ObservedEvent {
  return {
    kind: 'session',
    sourceEventId: `${tag}-0`,
    identity: who,
    cwd: MINE,
    at,
    parentIdentity: SESSION
  }
}

/** A `<task-notification>` of the worker, read in its session's transcript. */
const ending = (at: Instant, tag: string): ObservedEvent => ({
  kind: 'closed',
  sourceEventId: `${tag}:ended:worker-1`,
  identity: WORKER,
  at
})

class ScriptedPresence implements ObservedPresence {
  says: 'live' | 'not-live' | 'unknown' = 'live'
  presenceOf(): 'live' | 'not-live' | 'unknown' {
    return this.says
  }
}

function world() {
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
    hostEpoch: 'epoch-resumed',
    log: new RecordingDiagnosticsLog(),
    presence: [presence],
    installMoment: () => INSTALLED
  }
  /** A stream that grows: each `write` is one more batch, read from the cursor the last one left. */
  const stream = (streamId: string) => {
    const batches: ObservedEvent[][] = []
    adapter.sources.push(source(streamId))
    adapter.onRead(streamId, (from) => {
      const at = from === null ? 0 : from.value / 1_000
      const events = batches[at]
      if (events === undefined) return { events: [], next: from!, warnings: [] }
      const next = {
        adapterId: 'simulated',
        kind: 'byte-offset' as const,
        value: (at + 1) * 1_000,
        fileIdentity: `file-${streamId}`
      }
      return { events, next, warnings: [] }
    })
    return { write: (events: ObservedEvent[]) => batches.push(events) }
  }
  const announced = () =>
    bus.published.flatMap((e) => (e.type === 'SessionObserved' ? [e.payload] : []))
  const closings = () =>
    bus.published.flatMap((e) => (e.type === 'SessionClosedObserved' ? [e.payload.identity] : []))
  /** The dwarfs each written batch went to, in order. */
  const written = () => sink.applied.map((b) => b.dwarfId)
  return {
    deps,
    dwarfs,
    sessions,
    ended,
    sink,
    bus,
    clock,
    presence,
    stream,
    announced,
    closings,
    written
  }
}

/**
 * The common start: the session and its worker run, the worker's first run ends with its
 * notification. Returns the world, the two streams and the worker's first dwarf.
 */
async function endedWorker() {
  const w = world()
  const parent = w.stream('s1')
  const child = w.stream('s1-worker')
  parent.write([
    { kind: 'session', sourceEventId: 'p-0', identity: SESSION, cwd: MINE, at: AFTER },
    ...work(SESSION, AFTER, 'p')
  ])
  child.write([started(WORKER, AFTER, 'w'), ...work(WORKER, AFTER + 5_000, 'w')])
  const loop = new ObservationLoop(w.deps)
  const poll = async (on: ObservationLoop = loop) => {
    w.clock.advance(OBSERVATION_POLL_MS)
    await on.catchUp()
  }
  await poll()
  w.dwarfs.bind(SESSION, MINE, AFTER)
  const first = w.dwarfs.bind(WORKER, MINE, AFTER)
  await poll()
  parent.write([ending(ENDED, 'n1')])
  await poll()
  expect(w.closings()).toEqual([WORKER])
  expect(w.ended.has(WORKER)).toBe(true)
  return { w, parent, child, loop, poll, first }
}

describe('ObservationLoop brings a resumed subagent back as its resumed generation', () => {
  it('[INV-36, S4.41, FM-059] a subagent its notification ended, messaged again by its coordinator while its session runs, arrives present as its resumed generation with its parent, and its records are written to it', async () => {
    const { w, child, poll, first } = await endedWorker()
    child.write([started(WORKER, RESUMED, 'r'), ...work(WORKER, RESUMED + 1_000, 'r')])
    await poll()

    const resumed = generation(ENDED)
    // The session's own id is kept: its ending departs this generation too (crew's #1260 route).
    expect(resumed.providerSessionId).toBe(SESSION.providerSessionId)
    expect(w.announced().map((a) => [a.identity, a.parentIdentity])).toEqual([
      [SESSION, undefined],
      [WORKER, SESSION],
      [resumed, SESSION]
    ])
    expect(w.closings()).toEqual([WORKER])
    const second = w.dwarfs.bind(resumed, MINE, RESUMED)
    await poll()
    expect(w.written().slice(-1)).toEqual([second])
    expect(w.sink.applied.at(-1)!.usage.map((u) => u.unitKey)).toEqual(['r-unit'])
    expect(second).not.toBe(first)
    // The ended identity itself never arrives again (INV-36).
    expect(w.ended.has(WORKER)).toBe(true)
    expect(w.sessions.byIdentity(WORKER)?.closedAt).not.toBeNull()
  })

  it('[INV-36, S4.40] the tail of an ending never brings a subagent back: records written before its notification, or after it with no message from its coordinator', async () => {
    const { w, child, poll } = await endedWorker()
    // Its last records, read after the notification that ended it.
    child.write(work(WORKER, ENDED - 1_000, 'tail'))
    await poll()
    // A record written after the notification that no coordinator's message opened.
    child.write(work(WORKER, ENDED + 5_000, 'late'))
    await poll()
    // The agent's own start, read again (a stream read from its start): older than its ending.
    child.write([started(WORKER, AFTER, 'again'), ...work(WORKER, ENDED + 6_000, 'again')])
    await poll()

    expect(w.announced().map((a) => a.identity)).toEqual([SESSION, WORKER])
    expect(w.closings()).toEqual([WORKER])
  })

  it('[INV-36, FM-059] a resumed subagent never comes back while its session is not known to run, nor once its session ended', async () => {
    for (const says of ['not-live', 'unknown'] as const) {
      const { w, child, poll } = await endedWorker()
      w.presence.says = says
      child.write([started(WORKER, RESUMED, 'r'), ...work(WORKER, RESUMED + 1_000, 'r')])
      await poll()
      expect(
        w.announced().map((a) => a.identity),
        says
      ).toEqual([SESSION, WORKER])
    }

    const { w, parent, child, poll } = await endedWorker()
    parent.write([{ kind: 'closed', sourceEventId: 'gone', identity: SESSION, at: ENDED + 1_000 }])
    await poll()
    child.write([started(WORKER, RESUMED, 'r'), ...work(WORKER, RESUMED + 1_000, 'r')])
    await poll()
    expect(w.announced().map((a) => a.identity)).toEqual([SESSION, WORKER])
  })

  it('[INV-36, S4.41] a resumed generation ends on its own next notification, not on a late copy of the one before, and the next resume is the next generation', async () => {
    const { w, parent, child, poll } = await endedWorker()
    child.write([started(WORKER, RESUMED, 'r'), ...work(WORKER, RESUMED + 1_000, 'r')])
    await poll()
    const resumed = generation(ENDED)
    w.dwarfs.bind(resumed, MINE, RESUMED)
    await poll()

    // Claude Code writes one ending twice (queued, then delivered): a copy read late ends nothing.
    parent.write([ending(ENDED + 13, 'n1-copy')])
    await poll()
    expect(w.closings()).toEqual([WORKER])

    const again = RESUMED + 30_000
    parent.write([ending(again, 'n2')])
    await poll()
    expect(w.closings()).toEqual([WORKER, resumed])
    expect(w.ended.has(resumed)).toBe(true)
    expect(w.sessions.byIdentity(resumed)?.closedAt).toBe(again)

    // Its records after that ending, with no new message, stay with nobody.
    child.write(work(WORKER, again + 1_000, 'after'))
    await poll()
    expect(w.announced().map((a) => a.identity)).toEqual([SESSION, WORKER, resumed])

    // Messaged once more: the next generation, named after this one's departure.
    child.write([started(WORKER, again + 60_000, 'r2'), ...work(WORKER, again + 61_000, 'r2')])
    await poll()
    expect(w.announced().map((a) => a.identity)).toEqual([
      SESSION,
      WORKER,
      resumed,
      generation(again)
    ])
  })

  it('[INV-36, S4.41] a resumed generation departs with its session: its next records close it and no further generation arrives', async () => {
    const { w, parent, child, poll } = await endedWorker()
    child.write([started(WORKER, RESUMED, 'r'), ...work(WORKER, RESUMED + 1_000, 'r')])
    await poll()
    const resumed = generation(ENDED)
    w.dwarfs.bind(resumed, MINE, RESUMED)
    await poll()

    parent.write([
      { kind: 'closed', sourceEventId: 'gone', identity: SESSION, at: RESUMED + 10_000 }
    ])
    await poll()
    expect(w.closings()).toEqual([WORKER, SESSION])
    child.write([started(WORKER, RESUMED + 20_000, 'r2'), ...work(WORKER, RESUMED + 21_000, 'r2')])
    await poll()

    expect(w.closings()).toEqual([WORKER, SESSION, resumed])
    expect(w.announced().map((a) => a.identity)).toEqual([SESSION, WORKER, resumed])
  })

  it('[FM-059, S4.41] a subagent that arrived departed as not live and writes again while its session runs comes back under the same naming, its session id kept', async () => {
    const w = world()
    w.presence.says = 'not-live'
    const child = w.stream('s1-worker')
    child.write([started(WORKER, AFTER, 'w'), ...work(WORKER, AFTER + 5_000, 'w')])
    const loop = new ObservationLoop(w.deps)
    await loop.catchUp()
    const first = w.dwarfs.bind(WORKER, MINE, AFTER)
    w.dwarfs.depart(first, ENDED)
    await loop.catchUp()

    w.presence.says = 'live'
    child.write(work(WORKER, RESUMED, 'r'))
    await loop.catchUp()
    expect(w.announced().map((a) => a.identity)).toEqual([WORKER, generation(ENDED)])
  })

  it('[INV-36, S4.41, ADR-015] the resumed generation is the same after a Host restart: a new Host writes to it, and one that sees the resume first names it the same', async () => {
    // Restart after it arrived: its records still go to the same dwarf.
    {
      const { w, child, poll } = await endedWorker()
      child.write([started(WORKER, RESUMED, 'r'), ...work(WORKER, RESUMED + 1_000, 'r')])
      await poll()
      const second = w.dwarfs.bind(generation(ENDED), MINE, RESUMED)
      await poll()
      const next = new ObservationLoop(w.deps)
      child.write(work(WORKER, RESUMED + 5_000, 'r-more'))
      await poll(next)
      expect(w.written().slice(-1)).toEqual([second])
      expect(w.announced().map((a) => a.identity)).toEqual([SESSION, WORKER, generation(ENDED)])
    }
    // Restart between the ending and the resume: the new Host names it the same.
    {
      const { w, child, poll } = await endedWorker()
      const next = new ObservationLoop(w.deps)
      child.write([started(WORKER, RESUMED, 'r'), ...work(WORKER, RESUMED + 1_000, 'r')])
      await poll(next)
      expect(w.announced().map((a) => a.identity)).toEqual([SESSION, WORKER, generation(ENDED)])
    }
  })
})
