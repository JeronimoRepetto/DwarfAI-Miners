// layer: L2
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../host/kernel/fakes/FakeClock'
import { FakeScheduler } from '../host/kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../host/kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../host/kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../host/kernel/fakes/SequenceIdGenerator'
import type { FolderPath, ProviderIdentity } from '../host/kernel/domain/values'
import type { FileSystem } from '../host/kernel/ports/fileSystem'
import {
  SimulatedObservationAdapter,
  SimulatedSessionLog
} from '../host/modules/observation/adapters/simulated/SimulatedObservationAdapter'
import type { ObservationEvent } from '../host/modules/observation/application/events'
import {
  OBSERVATION_POLL_MS,
  ObservationLoop
} from '../host/modules/observation/application/observationLoop'
import { InMemoryCursorStore } from '../host/modules/observation/ports/fakes/InMemoryCursorStore'
import { InMemoryObservedSessionStore } from '../host/modules/observation/ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../host/modules/observation/ports/fakes/RecordingObservedBatchSink'
import { InMemoryBoundDwarfs } from '../host/modules/observation/testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../host/modules/observation/testing/inMemoryTransactions'
import type { ProviderSnapshot } from '../main/domain/types'
import type { EndLaunchVerdict } from '../main/sessionLaunch/launchedSessions'
import {
  createLegacyAgentRegistryFeed,
  LEGACY_FEED_PROVIDERS_CUT_1
} from './LegacyAgentRegistryFeed'
import type { LegacyLaunch, LegacyLaunchedSessions } from './LegacyEndFirstAdapter'
import { createLegacyLaunchObservation } from './LegacyLaunchObservation'

// L2 (17 §1): `LegacyLaunchObservation` (21 §3, cuts 1–4b; 14 §5; 13 FM-094). The fake legacy launch writes its
// session into the simulated provider's own files (`SimulatedSessionLog`) and holds it in today's launched register;
// the Host observer is the observation loop over `SimulatedObservationAdapter` with its in-memory doubles, crew's
// route played by binding the dwarf on `SessionObserved`. TC-087-02.

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath
const SESSION = 'legacy-launched-1'
const IDENTITY: ProviderIdentity = { providerId: 'simulated', providerSessionId: SESSION }

/** Today's runtime launching a session: its provider writes the session's files, its register keeps the launch. */
function fakeLegacyLaunch(log: SimulatedSessionLog) {
  const live: LegacyLaunch[] = []
  const ended: string[] = []
  const register: LegacyLaunchedSessions = {
    liveLaunches: async () => [...live],
    endLaunch: async (launchId): Promise<EndLaunchVerdict> => {
      ended.push(launchId)
      return 'ended'
    }
  }
  return {
    register,
    ended,
    launch(sessionId: string, at: number) {
      live.push({ launchId: `launch:${sessionId}` })
      log.open(sessionId, MINE, at)
      log.message(sessionId, 'person', 'Dig the north seam', at)
    }
  }
}

/** The Host observer: the observation loop over the simulated provider's files (ISSUE-070). */
function hostObserver(log: SimulatedSessionLog) {
  const transactions = new InMemoryTransactions()
  const dwarfs = new InMemoryBoundDwarfs()
  const cursors = new InMemoryCursorStore(transactions)
  const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
  const sink = new RecordingObservedBatchSink(transactions)
  for (const participant of [cursors, sessions, sink]) transactions.enlist(participant)
  const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
  const clock = new FakeClock(T0)
  const loop = new ObservationLoop({
    adapters: [new SimulatedObservationAdapter({ providerId: 'simulated', log })],
    fs: {} as FileSystem,
    cursors,
    sessions,
    sink,
    transactions,
    bus,
    clock,
    scheduler: new FakeScheduler(clock),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0087',
    log: new RecordingDiagnosticsLog()
  })
  // Crew's route: an observed session gets its dwarf (`crew.arrive`).
  bus.subscribe('SessionObserved', (event) => {
    dwarfs.bind(event.payload.identity, event.payload.cwd, T0)
  })
  const poll = async () => {
    clock.advance(OBSERVATION_POLL_MS)
    await loop.whenIdle()
  }
  return { loop, poll, bus, sessions, sink, dwarfs }
}

describe('LegacyLaunchObservation', () => {
  it('[FM-094] a legacy-launched fixture session appears once, as an observed dwarf, and the legacy runtime keeps its channel', async () => {
    const files = new SimulatedSessionLog()
    const legacy = fakeLegacyLaunch(files)
    const host = hostObserver(files)
    const observation = createLegacyLaunchObservation({ launches: legacy.register })
    // Today's runtime also lists its own launch through the registry-only discovery, for the rows still `legacy`.
    const registry: ProviderSnapshot[][] = []
    const feed = createLegacyAgentRegistryFeed({
      legacy: {
        pollIntervalMs: 2_000,
        discovery: [
          {
            kind: 'claude',
            scan: async () =>
              files.sessions().map((sessionId) => ({
                provider: 'claude',
                sessionId,
                cwd: MINE,
                status: 'busy',
                dwarfs: [],
                updatedAt: T0
              }))
          }
        ],
        registry: { replace: (sessions) => void registry.push([...sessions]) },
        board: { publish: () => {} },
        ledger: { credit: () => {} },
        projects: { record: () => {} },
        notifier: { update: () => {} }
      },
      modes: LEGACY_FEED_PROVIDERS_CUT_1,
      timers: { every: () => () => {} }
    })

    legacy.launch(SESSION, T0)
    host.loop.start()
    await host.loop.whenIdle()
    await feed.refresh()
    // The session keeps writing; the Host reads it again on later cycles, and the registry is refreshed as well.
    files.message(SESSION, 'dwarf', 'Digging.', T0 + 1)
    await host.poll()
    await feed.refresh()
    await host.poll()

    // Once, by its identity, as an observed dwarf: one SessionObserved and one observed session (S4.41, not S4.31).
    const observed = host.bus.ofType('SessionObserved')
    expect(observed.map((e) => e.payload.identity)).toEqual([IDENTITY])
    const dwarf = host.dwarfs.bound(IDENTITY)
    expect(host.sessions.byIdentity(IDENTITY)?.dwarfId).toBe(dwarf?.dwarfId)
    expect(new Set(host.sink.applied.map((batch) => batch.dwarfId))).toEqual(
      new Set([dwarf?.dwarfId])
    )
    // The legacy rows still find it through the registry …
    expect(registry.at(-1)?.map((s) => s.sessionId)).toEqual([SESSION])
    // … and the legacy runtime keeps its channel: the launch is still its own, and ending it reaches today's register.
    expect(await observation.channel.liveLaunches()).toEqual([{ launchId: `launch:${SESSION}` }])
    expect(await observation.channel.endLaunch(`launch:${SESSION}`)).toBe('ended')
    expect(legacy.ended).toEqual([`launch:${SESSION}`])

    host.loop.stop()
  })
})
