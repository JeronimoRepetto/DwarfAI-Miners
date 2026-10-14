// The harness's own negative tests (ISSUE-144): each purpose-built broken driver must fail the
// case it violates, while its conformant twin passes the same case.
import { describe, expect, it } from 'vitest'
import type { DriverEvent, DriverSession, ProviderDriver } from '../ports/providerDriver'
import { SIMULATED_RECORD } from '../adapters/catalog/profiles'
import { SimulatedDriver } from '../adapters/drivers/simulated/SimulatedDriver'
import {
  CASE_IDS,
  caseTitle,
  runCase,
  type ConformanceOptions,
  type DriverFactory
} from './driverConformance'
import {
  LINE_CEILING,
  LineTestDriver,
  lineFixtureFiles,
  type LineDriverFaults
} from './driverConformance.lineDriver'
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

/** The line test driver, conformant or with the given faults; its probe agrees with its ceiling. */
function lineFactory(faults: LineDriverFaults = {}): DriverFactory {
  return (rig) => new LineTestDriver({ rig, probe: LINE_CEILING, faults })
}

const LINE_OPTIONS: ConformanceOptions = {
  ceiling: LINE_CEILING,
  install: {
    providerId: 'line-test',
    binaryPath: '/usr/local/bin/line-test',
    version: '1.0.0',
    resolvedVia: 'path',
    statMtimeMs: 0
  }
}

const OK = { ok: true, failures: [] }

describe('driverConformance harness', () => {
  const fixtures = readReferenceFixtures()
  const lineFixtures = fixtureSetFromFiles(
    { provider: 'line-test', driver: 'ndjson', providerVersion: '1.0.0' },
    lineFixtureFiles()
  )

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

  describe('recording spawn', () => {
    /** The verdict of `id` for the conformant line driver and for one with `faults`. */
    const twins = async (
      id: Parameters<typeof runCase>[0],
      faults: LineDriverFaults
    ): Promise<{ conformant: unknown; broken: { ok: boolean; failures: readonly string[] } }> => ({
      conformant: await runCase(id, lineFactory(), lineFixtures, LINE_OPTIONS),
      broken: await runCase(id, lineFactory(faults), lineFixtures, LINE_OPTIONS)
    })

    it('[C-02] a driver that spawns anything but the person install fails the harness, and spawn ENOENT is not-installed', async () => {
      const { conformant, broken } = await twins('C-02', { bundledPath: true })

      expect(conformant).toEqual(OK)
      expect(broken.ok).toBe(false)
      expect(broken.failures.join('\n')).toMatch(/\/opt\/dwarfai\/bundled\/line-test/)
    })

    it('[C-03] a driver that reports a spawn EACCES, a refused shim or a handshake timeout as anything but could-not-start with an output tail of at most 400 characters fails the harness', async () => {
      const { conformant, broken } = await twins('C-03', { eaccesAsNotInstalled: true })
      const unbounded = await runCase(
        'C-03',
        lineFactory({ unboundedTail: true }),
        lineFixtures,
        LINE_OPTIONS
      )

      expect(conformant).toEqual(OK)
      expect(broken.failures.join('\n')).toMatch(/EACCES.*not-installed/)
      expect(unbounded.failures.join('\n')).toMatch(/tail of 1000 characters/)
    })

    it('[C-04] a driver that does not report an exit inside 3 s as exited-at-once fails the harness', async () => {
      const { conformant, broken } = await twins('C-04', { noEarlyWindow: true })

      expect(conformant).toEqual(OK)
      expect(broken.failures.join('\n')).toMatch(/2999 ms.*exited-at-once/)
    })

    it('[C-23] a driver that puts the credential value in any captured argv or env fails the harness', async () => {
      const { conformant, broken } = await twins('C-23', { leaksLoginEnv: true })

      expect(conformant).toEqual(OK)
      expect(broken.ok).toBe(false)
      expect(broken.failures.join('\n')).toMatch(/DWARFAI_DELEGATION_TOKEN/)
      expect(broken.failures.join('\n')).toMatch(/ELECTRON_RUN_AS_NODE/)
    })

    it('[C-24] a driver that passes a forbidden auto-approve flag fails the harness', async () => {
      const { conformant, broken } = await twins('C-24', { autoApproveFlag: true })

      expect(conformant).toEqual(OK)
      expect(broken.failures.join('\n')).toMatch(/--yolo/)
    })

    it('[C-29] a driver that resolves launch before calling onSpawned fails the harness', async () => {
      const deferred: DriverFactory = (rig) => {
        const inner = simulatedFactory(rig)
        return {
          profile: inner.profile,
          transport: inner.transport,
          detect: () => inner.detect(),
          probe: (install) => inner.probe(install),
          launch: async (req) => {
            let identity: Parameters<typeof req.onSpawned>[0] | null = null
            const session = await inner.launch({
              ...req,
              onSpawned: async (spawned) => {
                identity = spawned
              }
            })
            // Reported only once the session is used: after launch resolved.
            return {
              ...session,
              sendTurn: async (input) => {
                if (identity !== null) await req.onSpawned(identity)
                return session.sendTurn(input)
              }
            }
          }
        }
      }

      const broken = await runCase('C-29', deferred, fixtures, SIMULATED_OPTIONS)

      expect(await runCase('C-29', simulatedFactory, fixtures, SIMULATED_OPTIONS)).toEqual(OK)
      expect(await runCase('C-29', lineFactory(), lineFixtures, LINE_OPTIONS)).toEqual(OK)
      expect(broken.failures.join('\n')).toMatch(
        /onSpawned was called 0 times before launch resolved/
      )
    })
  })

  it('[ADR-009] the harness defines every 15 §6 case, C-01 to C-29, each titled with its id', () => {
    const ids = Array.from({ length: 29 }, (_, n) => `C-${String(n + 1).padStart(2, '0')}`)

    expect(CASE_IDS).toEqual(ids)
    for (const id of CASE_IDS) expect(caseTitle(id)).toMatch(new RegExp(`^\\[${id}\\] \\S`))
  })

  describe('inapplicable cases', () => {
    it('[C-25] a case the driver capabilities make inapplicable is asserted at its fail-closed value, never skipped', async () => {
      const declared = {
        ...SIMULATED_OPTIONS,
        cases: { 'C-16': { inapplicable: 'resume is none' } }
      }
      const resumable = { ...SIMULATED_OPTIONS.ceiling, resume: 'load' as const }
      const loadFactory: DriverFactory = (rig) =>
        new SimulatedDriver({
          profile: SIMULATED_RECORD.profile,
          transport: 'acp',
          capabilities: resumable,
          seed: 'conformance',
          clock: rig.clock,
          scheduler: rig.scheduler
        })
      const spawning = { ...LINE_OPTIONS, cases: { 'C-23': { inapplicable: 'spawns nothing' } } }

      const honest = await runCase('C-16', simulatedFactory, fixtures, declared)
      const dishonest = await runCase('C-16', loadFactory, fixtures, {
        ...declared,
        ceiling: resumable
      })
      const undeclared = await runCase('C-16', simulatedFactory, fixtures, {
        ...SIMULATED_OPTIONS,
        cases: {}
      })
      const spawned = await runCase('C-23', lineFactory(), lineFixtures, spawning)
      const always = await runCase('C-28', simulatedFactory, fixtures, {
        ...SIMULATED_OPTIONS,
        cases: { 'C-28': { inapplicable: 'never closes' } }
      })

      expect(honest).toEqual(OK)
      expect(dishonest.failures.join('\n')).toMatch(/declared inapplicable.*resume is "load"/)
      expect(undeclared.failures.join('\n')).toMatch(/C-16 has no fixture/)
      expect(spawned.failures.join('\n')).toMatch(/declared inapplicable.*spawned/)
      expect(always.failures.join('\n')).toMatch(/C-28 applies to every driver/)
    })
  })

  describe('events, answers and capabilities', () => {
    it('[C-19] a driver whose sourceKeys differ on replay fails the harness', async () => {
      let launches = 0
      const drifting = brokenSimulated((session) => {
        launches += 1
        const suffix = `:replay-${launches}`
        return mapEvents(session, (event) =>
          event.t === 'message'
            ? [
                {
                  ...event,
                  record: { ...event.record, sourceKey: event.record.sourceKey + suffix }
                }
              ]
            : [event]
        )
      })

      const broken = await runCase('C-19', drifting, fixtures, SIMULATED_OPTIONS)

      expect(await runCase('C-19', simulatedFactory, fixtures, SIMULATED_OPTIONS)).toEqual(OK)
      expect(await runCase('C-19', lineFactory(), lineFixtures, LINE_OPTIONS)).toEqual(OK)
      expect(broken.failures.join('\n')).toMatch(/sourceKeys differ on replay/)
    })

    it('[C-08] a driver whose interrupt mid-turn does not end the turn interrupted and cancelledFromApp, or whose interrupt mid-permission does not resolve the ask cancelled, fails the harness', async () => {
      const notFromApp = brokenSimulated((session) =>
        mapEvents(session, (event) =>
          event.t === 'turn.ended'
            ? [{ ...event, end: { ...event.end, cancelledFromApp: false } }]
            : [event]
        )
      )

      const midTurn = await runCase('C-08', notFromApp, fixtures, SIMULATED_OPTIONS)
      const midAsk = await runCase(
        'C-08',
        lineFactory({ keepsAsksOnInterrupt: true }),
        lineFixtures,
        LINE_OPTIONS
      )

      expect(await runCase('C-08', simulatedFactory, fixtures, SIMULATED_OPTIONS)).toEqual(OK)
      expect(await runCase('C-08', lineFactory(), lineFixtures, LINE_OPTIONS)).toEqual(OK)
      expect(midTurn.failures.join('\n')).toMatch(/interrupted with cancelledFromApp/)
      expect(midAsk.failures.join('\n')).toMatch(/ask r-1 .* not resolved cancelled/)
    })

    it('[C-14] a driver that maps a protocol-error answer reply to anything but refused channel-rejected fails the harness', async () => {
      const broken = await runCase(
        'C-14',
        lineFactory({ errorReplyAccepted: true }),
        lineFixtures,
        LINE_OPTIONS
      )

      expect(await runCase('C-14', lineFactory(), lineFixtures, LINE_OPTIONS)).toEqual(OK)
      expect(broken.failures.join('\n')).toMatch(/not refused channel-rejected/)
    })

    it('[C-25b] a driver whose effective capability is above the lower of the protocol and probe values, or is not the fail-closed value when unordered values differ, fails the harness', async () => {
      const broken = await runCase(
        'C-25',
        lineFactory({ probeOverProtocol: true }),
        lineFixtures,
        LINE_OPTIONS
      )

      expect(await runCase('C-25', lineFactory(), lineFixtures, LINE_OPTIONS)).toEqual(OK)
      expect(await runCase('C-25', simulatedFactory, fixtures, SIMULATED_OPTIONS)).toEqual(OK)
      expect(broken.failures.join('\n')).toMatch(
        /capability interrupt is true, the merge gives false/
      )
      expect(broken.failures.join('\n')).toMatch(
        /capability earlyFailure is "handshake", the merge gives "exit-only"/
      )
    })
  })

  describe('fixture transport faults', () => {
    it('[C-18, CH-04] an early EOF in the fixture transport must surface as error transport-lost then exited', async () => {
      const conformant = await runCase('C-18', lineFactory(), lineFixtures, LINE_OPTIONS)
      const silent = await runCase(
        'C-18',
        lineFactory({ silentEof: true }),
        lineFixtures,
        LINE_OPTIONS
      )

      expect(conformant).toEqual(OK)
      expect(silent.ok).toBe(false)
      expect(silent.failures.join('\n')).toMatch(/error transport-lost/)
    })

    it('[C-15, CH-05] a provider that never acknowledges an answer is failed at 30 s by a FakeClock, never a real timer', async () => {
      const conformant = await runCase('C-15', lineFactory(), lineFixtures, LINE_OPTIONS)
      const eager = await runCase(
        'C-15',
        lineFactory({ acceptsWithoutAck: true }),
        lineFixtures,
        LINE_OPTIONS
      )

      expect(conformant).toEqual(OK)
      expect(eager.ok).toBe(false)
      expect(eager.failures.join('\n')).toMatch(/channel-unavailable/)
    })
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
