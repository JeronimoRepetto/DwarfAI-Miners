import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, FolderPath, LaunchId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FAIL_CLOSED_CAPABILITIES } from '../domain/capabilities'
import type { ProviderProfile } from '../domain/profile'
import { FakeDriverRegistry } from '../ports/fakes/FakeDriverRegistry'
import { FakeProviderDriver, type FakeDriverSession } from '../ports/fakes/FakeProviderDriver'
import { RecordingSuppliedEventSink } from '../ports/fakes/RecordingSuppliedEventSink'
import type { DriverLaunchRequest, DriverSession } from '../ports/providerDriver'
import { trackLiveSessions } from './sessionChannels'

const PROFILE: ProviderProfile = {
  id: 'scripted',
  label: 'Scripted',
  binaries: [],
  models: [],
  efforts: [],
  permissionModes: [],
  drivers: ['acp'],
  publicLaunch: 'enabled'
}

const DWARF = '00000000-0000-7000-8000-00000000000a' as DwarfId
const OTHER_DWARF = '00000000-0000-7000-8000-00000000000b' as DwarfId

function request(launchId: string): DriverLaunchRequest {
  return {
    launchId: launchId as LaunchId,
    install: {
      providerId: PROFILE.id,
      binaryPath: 'scripted',
      version: null,
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine' as FolderPath,
    prompt: 'go',
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:install:launch:epoch',
    onSpawned: async () => {}
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function setup() {
  const clock = new FakeClock(5_000)
  const sink = new RecordingSuppliedEventSink()
  const driver = new FakeProviderDriver(PROFILE, 'acp', FAIL_CLOSED_CAPABILITIES)
  const tracked = trackLiveSessions(new FakeDriverRegistry([driver]), { sink, clock })
  const [launcher] = tracked.registry.drivers(PROFILE.id)
  if (launcher === undefined) throw new Error('no driver')
  const session: DriverSession = await launcher.launch(request('launch-1'))
  const scripted = driver.sessions[0] as FakeDriverSession
  return { clock, sink, tracked, session, scripted }
}

const TURN_END = {
  turnKey: 'turn-1',
  kind: 'concluded',
  at: 4_000,
  reliability: 'reliable',
  cancelledFromApp: false
} as const

describe('SessionChannels and the dwarf binding', () => {
  it('[ADR-009, ADR-015] a driver event that reaches the rest of the Host carries the bound DwarfId', async () => {
    const { sink, tracked, session, scripted } = await setup()
    tracked.bindings.bind(session.ref, DWARF)

    scripted.emit({ t: 'turn.ended', end: TURN_END })
    scripted.emit({ t: 'status', value: 'idle' })
    await settle()

    expect(sink.deliveries).toEqual([
      {
        dwarfId: DWARF,
        ref: session.ref,
        event: { t: 'turn.ended', end: { ...TURN_END, dwarfId: DWARF } }
      },
      { dwarfId: DWARF, ref: session.ref, event: { t: 'status', value: 'idle' } }
    ])
  })

  it('[ADR-015, ADR-009] events of a session with no bound dwarf yet are held in order and delivered once it is bound', async () => {
    const { sink, tracked, session, scripted } = await setup()

    scripted.emit({ t: 'status', value: 'working' })
    scripted.emit({ t: 'turn.ended', end: TURN_END })
    await settle()
    expect(sink.deliveries).toEqual([])

    tracked.bindings.bind(session.ref, DWARF)
    scripted.emit({ t: 'status', value: 'idle' })
    await settle()

    expect(sink.deliveries.map((d) => [d.dwarfId, d.event.t])).toEqual([
      [DWARF, 'status'],
      [DWARF, 'turn.ended'],
      [DWARF, 'status']
    ])
  })

  it('[ADR-006] a usage observation leaves suppliers with the bound dwarf and the time suppliers observed it', async () => {
    const { clock, sink, tracked, session, scripted } = await setup()
    tracked.bindings.bind(session.ref, DWARF)
    const observation = {
      sourceKey: 'scripted:s:1',
      unitKey: 'unit-1',
      fidelity: 2,
      tokens: { inputNet: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      sealed: true,
      providerTime: 4_500
    } as const

    scripted.emit({ t: 'usage', observation })
    await settle()

    expect(sink.deliveries.map((d) => d.event)).toEqual([
      { t: 'usage', observation: { ...observation, dwarfId: DWARF, observedAt: clock.now() } }
    ])
  })

  it('[ADR-006, ADR-015] a usage observation held before the binding keeps the time suppliers received it', async () => {
    const { clock, sink, tracked, session, scripted } = await setup()
    const received = clock.now()
    scripted.emit({
      t: 'usage',
      observation: {
        sourceKey: 'scripted:s:2',
        unitKey: 'unit-2',
        fidelity: 1,
        tokens: { inputNet: 0, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sealed: true,
        providerTime: null
      }
    })
    await settle()
    clock.advance(1_000)
    tracked.bindings.bind(session.ref, DWARF)

    expect(sink.deliveries.map((d) => d.event)).toEqual([
      { t: 'usage', observation: expect.objectContaining({ dwarfId: DWARF, observedAt: received }) }
    ])
  })

  it('[ADR-015] a session already bound to one dwarf is never rebound to another', async () => {
    const { tracked, session } = await setup()
    tracked.bindings.bind(session.ref, DWARF)
    tracked.bindings.bind(session.ref, DWARF)

    expect(() => tracked.bindings.bind(session.ref, OTHER_DWARF)).toThrow(HostInvariantError)
    expect(() =>
      tracked.bindings.bind({ providerId: PROFILE.id, providerSessionId: 'never-launched' }, DWARF)
    ).toThrow(HostInvariantError)
  })

  it('[ADR-009] sessionFor reaches a launched session until its exited left suppliers', async () => {
    const { sink, tracked, session, scripted } = await setup()
    expect(tracked.channels.sessionFor({ ...session.ref })).toBe(session)

    tracked.bindings.bind(session.ref, DWARF)
    scripted.emit({ t: 'exited', code: 0 })
    await settle()

    expect(sink.deliveries.map((d) => d.event)).toEqual([{ t: 'exited', code: 0 }])
    expect(tracked.channels.sessionFor(session.ref)).toBeNull()
  })

  it('[ADR-009] suppliers is the one consumer of a session event stream', async () => {
    const { session } = await setup()
    expect(() => session.events()).toThrow(HostInvariantError)
  })

  it('[ADR-009] a stream that throws becomes error transport-lost then exited', async () => {
    const { sink, tracked, session, scripted } = await setup()
    tracked.bindings.bind(session.ref, DWARF)

    scripted.breakStream(new Error('driver defect'))
    await settle()

    expect(sink.deliveries.map((d) => d.event)).toEqual([
      { t: 'error', cause: { kind: 'transport-lost', detail: 'event stream failed' } },
      { t: 'exited', code: null }
    ])
    expect(tracked.channels.sessionFor(session.ref)).toBeNull()
  })
})
