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
import { fixtureSetFromFiles } from './fixtureSet'

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

  describe('fixture set refusal', () => {
    const location = { provider: 'canary', driver: 'acp', providerVersion: '1.0.0' }
    const meta = (overrides: Record<string, unknown> = {}): string =>
      JSON.stringify({
        providerVersion: '1.0.0',
        capturedAt: '2026-10-15',
        capturedBy: 'ci-synthetic',
        os: 'any',
        scrubbed: true,
        capabilities: {},
        ...overrides
      })
    const expected = JSON.stringify({ case: 'C-01', script: [{ do: 'launch' }] })
    const line = '{"type":"ready"}\n'
    const complete = (): Map<string, string> =>
      new Map([
        ['meta.json', meta()],
        ['c-01-launch.jsonl', line],
        ['c-01-launch-with-extra.jsonl', '{"type":"ready","dwarfaiUnknownField":"extra"}\n'],
        ['c-01-launch-crlf.jsonl', line.replace('\n', '\r\n')],
        ['c-01-launch.expected.json', expected]
      ])
    const refusal = (files: Map<string, string>): string => {
      try {
        fixtureSetFromFiles(location, files)
        return 'accepted'
      } catch (error) {
        return (error as Error).message
      }
    }

    it('[ADR-009] a fixture set without its -with-extra variant is refused by the harness', () => {
      const files = complete()
      files.delete('c-01-launch-with-extra.jsonl')

      expect(refusal(complete())).toBe('accepted')
      expect(refusal(files)).toMatch(/c-01-launch\.jsonl has no c-01-launch-with-extra\.jsonl/)
    })

    it('[ADR-009] a fixture set without meta.json, without scrubbed true or without the CRLF variant of a JSONL case is refused', () => {
      const noMeta = complete()
      noMeta.delete('meta.json')
      const unscrubbed = complete()
      unscrubbed.set('meta.json', meta({ scrubbed: false }))
      const person = complete()
      person.set('meta.json', meta({ capturedBy: 'someone' }))
      const noCrlf = complete()
      noCrlf.delete('c-01-launch-crlf.jsonl')

      expect(refusal(noMeta)).toMatch(/no meta\.json/)
      expect(refusal(unscrubbed)).toMatch(/scrubbed/)
      expect(refusal(person)).toMatch(/capturedBy/)
      expect(refusal(noCrlf)).toMatch(/c-01-launch\.jsonl has no CRLF variant/)
    })
  })
})
