// layer: L1
// L1 (17 §1.1): the Host's composed end of life (wiring/hostLifecycle.ts; ADR-002 D7) stops the
// module routes that must not run once the Host is closing (ISSUE-140: the asking routes) before
// the clean exit starts, on every way in: a direct `closeCleanly` and the OS session end.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../kernel/fakes/RecordingShutdownCheckpoint'
import { ConnectionRegistry } from '../transport/connectionRegistry'
import { composeHostLifecycle } from './hostLifecycle'

function lifecycle() {
  const journal: string[] = []
  const sessionEnds: Array<() => void> = []
  const exits: number[] = []
  const composed = composeHostLifecycle({
    checkpoint: new RecordingShutdownCheckpoint(journal),
    connections: new ConnectionRegistry(),
    endpoint: {
      close: () => {
        journal.push('endpoint.close')
        return Promise.resolve()
      }
    },
    scheduler: new FakeScheduler(new FakeClock(0)),
    log: new RecordingDiagnosticsLog(),
    sessionEnd: { onSessionEnd: (listener) => sessionEnds.push(listener) },
    stopRoutes: () => journal.push('routes.stopped'),
    exit: (code) => exits.push(code)
  })
  return { composed, journal, sessionEnds, exits }
}

describe('composeHostLifecycle', () => {
  it('[ADR-002] the clean exit stops the module routes before its checkpoint and its endpoint close', async () => {
    const { composed, journal, exits } = lifecycle()

    await composed.closeCleanly('stop-all')

    expect(journal[0]).toBe('routes.stopped')
    expect(journal.indexOf('endpoint.close')).toBeGreaterThan(0)
    expect(exits).toEqual([0])
  })

  it('[ADR-002, S12.17] the OS session end stops the module routes too', async () => {
    const { journal, sessionEnds } = lifecycle()

    for (const end of sessionEnds) end()
    await Promise.resolve()

    expect(journal[0]).toBe('routes.stopped')
  })
})
