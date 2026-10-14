// The harness's own negative tests (ISSUE-144): each purpose-built broken driver must fail the
// case it violates, while its conformant twin passes the same case.
import { describe, expect, it } from 'vitest'
import type { DriverEvent, DriverSession, ProviderDriver } from '../ports/providerDriver'
import { runCase, type DriverFactory } from './driverConformance'
import {
  SIMULATED_OPTIONS,
  readReferenceFixtures,
  simulatedFactory
} from './driverConformance.simulated'

/** A session whose event stream is rewritten by `map` (one input event → zero or more events). */
function mapEvents(
  session: DriverSession,
  map: (event: DriverEvent) => readonly DriverEvent[]
): DriverSession {
  const source = session.events()
  const mapped: AsyncIterable<DriverEvent> = {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) yield* map(event)
    }
  }
  return { ...session, events: () => mapped }
}

/** A driver built over the reference one whose launched sessions are rewritten by `wrap`. */
function brokenSimulated(wrap: (session: DriverSession) => DriverSession): DriverFactory {
  return (rig) => {
    const inner = simulatedFactory(rig)
    const driver: ProviderDriver = {
      profile: inner.profile,
      transport: inner.transport,
      detect: () => inner.detect(),
      probe: (install) => inner.probe(install),
      launch: async (req) => wrap(await inner.launch(req))
    }
    return driver
  }
}

describe('driverConformance harness', () => {
  const fixtures = readReferenceFixtures()

  it('[C-05] a driver that emits turn.ended twice for one turnKey fails the harness', async () => {
    const twice = brokenSimulated((session) =>
      mapEvents(session, (event) => (event.t === 'turn.ended' ? [event, event] : [event]))
    )

    const broken = await runCase('C-05', twice, fixtures, SIMULATED_OPTIONS)
    const twin = await runCase('C-05', simulatedFactory, fixtures, SIMULATED_OPTIONS)

    expect(broken.ok).toBe(false)
    expect(broken.failures.join('\n')).toMatch(/turn\.ended .* more than once/)
    expect(twin).toEqual({ ok: true, failures: [] })
  })
})
