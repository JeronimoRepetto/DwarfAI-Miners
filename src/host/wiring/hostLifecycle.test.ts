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

function lifecycle(closeIngress: () => Promise<void> = () => Promise.resolve()) {
  const journal: string[] = []
  const sessionEnds: Array<() => void> = []
  const exits: number[] = []
  const log = new RecordingDiagnosticsLog()
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
    log,
    sessionEnd: { onSessionEnd: (listener) => sessionEnds.push(listener) },
    stopRoutes: () => journal.push('routes.stopped'),
    closeIngress: async () => {
      journal.push('ingress.close')
      await closeIngress()
    },
    exit: (code) => exits.push(code)
  })
  return { composed, journal, sessionEnds, exits, log }
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

  it('[ADR-002, ADR-016] the clean exit closes the hook ingress listener after the routes stop and before its checkpoint', async () => {
    const { composed, journal, exits } = lifecycle()

    await composed.closeCleanly('stop-all')

    expect(journal.slice(0, 2)).toEqual(['routes.stopped', 'ingress.close'])
    expect(journal.indexOf('endpoint.close')).toBeGreaterThan(1)
    expect(exits).toEqual([0])
  })

  it('[ADR-002] a hook ingress that fails to close still lets the Host exit, logged without its text', async () => {
    const { composed, exits, log } = lifecycle(() =>
      Promise.reject(new Error('close failed /home/j'))
    )

    await composed.closeCleanly('upgrade')

    expect(exits).toEqual([0])
    expect(log.byEvent('uncaught')).toEqual([
      expect.objectContaining({ level: 'error', subsystem: 'transport' })
    ])
    expect(JSON.stringify(log.byEvent('uncaught'))).not.toContain('/home/j')
  })
})
