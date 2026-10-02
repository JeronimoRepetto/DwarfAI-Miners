// layer: L2
// L2 (17 §1.2): the CrewCommands arrival members (16 §4.2 `arrive`, `rebind`, `sessionClosed`,
// `markUnrecovered`) over InMemoryDwarfRepository, InMemoryLifecycleFactLog, RecordingEventBus,
// FakeClock and SequenceIdGenerator: one dwarf per identity, lifecycle facts once, events after
// commit (16 §2.2, §2.3; 09 §5.6; 06 INV-20, INV-21, INV-22, INV-26, INV-33).
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { rankForDepth } from '../domain/rank'
import { ASLEEP_AFTER_MS } from '../domain/status'
import { CREW_EPOCH, CREW_T0, inMemoryCrew } from '../testing/inMemoryCrew'

const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const ROOT: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const arrival = (identity: ProviderIdentity = ROOT, parent?: DwarfId) => ({
  mineId: MINE,
  identity,
  ...(parent === undefined ? {} : { parent }),
  rank: rankForDepth(parent === undefined ? 0 : 1),
  status: 'idle' as const
})

describe('CrewCommands arrival', () => {
  it('[INV-20, INV-21] arriving twice with one identity returns the same dwarf and publishes DwarfArrived once', () => {
    const crew = inMemoryCrew()

    const first = crew.commands.arrive(arrival())
    const second = crew.commands.arrive(arrival({ ...ROOT, providerAgentId: '' }))

    expect(second).toBe(first)
    expect(first).toMatch(UUID)
    expect(first).not.toContain(ROOT.providerSessionId)
    expect(crew.repository.inMine(MINE).map((d) => d.id)).toEqual([first])
    expect(crew.facts.rows().filter((f) => f.type === 'DwarfArrived')).toHaveLength(1)
    const arrived = crew.bus.ofType('DwarfArrived')
    expect(arrived).toHaveLength(1)
    expect(arrived[0]).toMatchObject({
      type: 'DwarfArrived',
      v: 1,
      at: CREW_T0,
      hostEpoch: CREW_EPOCH,
      payload: {
        dwarfId: first,
        mineId: MINE,
        identity: ROOT,
        rank: 'foreman',
        parentDwarfId: null,
        delegated: false,
        status: 'idle',
        baseName: 'claude-session-'
      }
    })
  })

  it("[INV-21] a subagent in its parent's session arrives as its own dwarf with its parent", () => {
    const crew = inMemoryCrew()
    const parent = crew.commands.arrive(arrival())

    const subagent = crew.commands.arrive(arrival({ ...ROOT, providerAgentId: 'agent-7' }, parent))

    expect(subagent).not.toBe(parent)
    expect(crew.repository.byId(subagent)).toMatchObject({ parentDwarfId: parent, rank: 'worker' })
    expect(crew.bus.ofType('DwarfArrived')).toHaveLength(2)
  })

  it('[ADR-032] an arrival schedules the status timer: an idle dwarf turns asleep after 60 s', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(arrival())
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('idle')

    crew.clock.advance(ASLEEP_AFTER_MS)

    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload)).toEqual([
      { dwarfId, from: 'idle', to: 'asleep' }
    ])
  })

  it('[ADR-006] a second departure of a dwarf writes no fact and publishes nothing', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(arrival())
    crew.clock.advance(1_000)
    crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    const stored = crew.repository.byId(dwarfId)
    const published = crew.bus.published.length

    crew.clock.advance(1_000)
    crew.commands.sessionClosed(dwarfId, 'crashed')

    expect(crew.facts.rows().filter((f) => f.type === 'DwarfDeparted')).toHaveLength(1)
    expect(crew.repository.byId(dwarfId)).toEqual(stored)
    expect(stored).toMatchObject({
      presence: 'walking-out',
      processState: 'closed',
      departedAt: CREW_T0 + 1_000,
      departureCause: 'closed-elsewhere'
    })
    expect(crew.bus.published).toHaveLength(published)
    expect(crew.bus.ofType('DwarfDeparted').map((e) => e.payload)).toEqual([
      { dwarfId, mineId: MINE, cause: 'closed-elsewhere' }
    ])
  })

  it('[INV-33] a closed dwarf cannot receive messages', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(arrival())
    crew.routed.add(dwarfId)
    expect(crew.queries.get(dwarfId)?.canReceiveMessages).toBe(true)

    crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')

    expect(crew.queries.get(dwarfId)).toMatchObject({
      processState: 'closed',
      canReceiveMessages: false
    })
  })

  it('[INV-22] rebind keeps the id and the custom name, stores the previous session id and publishes DwarfRebound once', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(arrival())
    const named = crew.repository.byId(dwarfId)
    if (named === null) return expect.fail('the arrived dwarf is not stored')
    crew.transactionRunner.inTransaction(() =>
      crew.repository.save({ ...named, customName: 'Gimli' })
    )
    const next: ProviderIdentity = { ...ROOT, providerSessionId: 'session-2' }

    crew.commands.rebind(dwarfId, next)
    crew.commands.rebind(dwarfId, next)

    expect(crew.repository.byId(dwarfId)).toMatchObject({
      id: dwarfId,
      customName: 'Gimli',
      identity: next,
      previousProviderSessionId: 'session-1'
    })
    expect(crew.facts.rows().filter((f) => f.type === 'DwarfRebound')).toHaveLength(1)
    expect(crew.bus.ofType('DwarfRebound').map((e) => e.payload)).toEqual([
      { dwarfId, previous: ROOT, next }
    ])
    expect(crew.commands.arrive(arrival(next))).toBe(dwarfId)
  })

  it('[INV-26] markUnrecovered keeps the dwarf present with processState unrecovered and publishes nothing', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(arrival())
    const published = crew.bus.published.length

    crew.commands.markUnrecovered(dwarfId)

    expect(crew.repository.byId(dwarfId)).toMatchObject({
      presence: 'present',
      processState: 'unrecovered',
      departedAt: null
    })
    expect(crew.bus.published).toHaveLength(published)
  })

  it('[S2.10] a resuming dwarf listed unrecovered is present again and DwarfPresenceChanged says so', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(arrival())
    const stored = crew.repository.byId(dwarfId)
    if (stored === null) return expect.fail('the arrived dwarf is not stored')
    crew.transactionRunner.inTransaction(() =>
      crew.repository.save({ ...stored, presence: 'resuming' })
    )

    crew.commands.markUnrecovered(dwarfId)

    expect(crew.repository.byId(dwarfId)).toMatchObject({
      presence: 'present',
      processState: 'unrecovered'
    })
    expect(crew.bus.ofType('DwarfPresenceChanged').map((e) => e.payload)).toEqual([
      { dwarfId, presence: 'present' }
    ])
  })

  it('[INV-26] a departed dwarf is neither rebound nor marked unrecovered', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(arrival())
    crew.commands.sessionClosed(dwarfId, 'crashed')
    const stored = crew.repository.byId(dwarfId)
    expect(stored?.departureCause).toBe('crashed')
    const published = crew.bus.published.length

    crew.commands.markUnrecovered(dwarfId)
    crew.commands.rebind(dwarfId, { ...ROOT, providerSessionId: 'session-2' })

    expect(crew.repository.byId(dwarfId)).toEqual(stored)
    expect(crew.bus.published).toHaveLength(published)
  })

  it('[ADR-015] a command for a dwarf that never existed is a programming error', () => {
    const crew = inMemoryCrew()
    const unknown = '00000000-0000-7000-8000-0000000000aa' as DwarfId

    expect(() => crew.commands.sessionClosed(unknown, 'crashed')).toThrow(HostInvariantError)
    expect(() => crew.commands.markUnrecovered(unknown)).toThrow(HostInvariantError)
    expect(() => crew.commands.rebind(unknown, ROOT)).toThrow(HostInvariantError)
  })
})
