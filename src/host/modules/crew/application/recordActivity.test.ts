// layer: L2
// L2 (17 §1.2): `CrewCommands.recordActivity` (16 §4.2 rows `recordActivity` / `startAsking` /
// `stopAsking`; 07 §1 S1.06, S1.08, S1.20) over InMemoryDwarfRepository, RecordingEventBus,
// FakeClock and FakeScheduler: the activity moves the dwarf's persisted status facts, the status is
// derived from them (INV-23), and `DwarfStatusChanged` is published only on a status change, after
// the commit (16 §2.3).
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { ASLEEP_AFTER_MS } from '../domain/status'
import { inMemoryCrew } from '../testing/inMemoryCrew'

const MINE = '00000000-0000-7000-8000-0000000000f2' as MineId
const ROOT: ProviderIdentity = { providerId: 'codex', providerSessionId: 'session-activity' }

function idleDwarf() {
  const crew = inMemoryCrew()
  const dwarfId = crew.commands.arrive({
    mineId: MINE,
    identity: ROOT,
    rank: 'foreman',
    status: 'idle'
  })
  return { crew, dwarfId }
}

describe('CrewCommands.recordActivity', () => {
  it('[S1.08] a turn start makes an idle dwarf working, persisted and published once', () => {
    const { crew, dwarfId } = idleDwarf()
    crew.clock.advance(10_000)

    crew.commands.recordActivity(dwarfId, 'turn-started')
    crew.commands.recordActivity(dwarfId, 'turn-started')

    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload)).toEqual([
      { dwarfId, from: 'idle', to: 'working' }
    ])
    expect(crew.repository.byId(dwarfId)?.facts).toMatchObject({
      turn: { state: 'active' },
      lastActivityAt: crew.clock.now()
    })
    // A working dwarf has no wake-up: it never falls asleep by time alone (ADR-032 item 3).
    crew.clock.advance(ASLEEP_AFTER_MS * 2)
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('working')
  })

  it('[S1.06] activity that is not a turn start keeps an idle dwarf idle and moves its wake-up', () => {
    const { crew, dwarfId } = idleDwarf()
    crew.clock.advance(ASLEEP_AFTER_MS - 10_000)

    crew.commands.recordActivity(dwarfId, 'message')

    // 60 s after the arrival the dwarf is still idle: the message moved its wake-up …
    crew.clock.advance(10_000)
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('idle')
    expect(crew.bus.ofType('DwarfStatusChanged')).toEqual([])
    expect(crew.repository.byId(dwarfId)?.facts.lastActivityAt).toBe(crew.clock.now() - 10_000)
    // … to 60 s after the message.
    crew.clock.advance(ASLEEP_AFTER_MS - 10_000)
    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload)).toEqual([
      { dwarfId, from: 'idle', to: 'asleep' }
    ])
  })

  it('[S1.20] activity reported for a departed dwarf writes nothing and publishes nothing', () => {
    const { crew, dwarfId } = idleDwarf()
    crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    const before = crew.repository.byId(dwarfId)

    crew.commands.recordActivity(dwarfId, 'turn-started')

    expect(crew.repository.byId(dwarfId)).toEqual(before)
    expect(crew.bus.ofType('DwarfStatusChanged')).toEqual([])
    expect(crew.statusTimer.statusOf(dwarfId)).toBeNull()
  })
})

// Amended: 05 §3.2 / 16 §4.2 recordActivity end (owner amendment C, 2026-10-06): a `'turn-finished'`
// carries the end's own instant and reliability (`TurnEnded.at` / `.reliability`, ADR-021), which
// 09 `dwarfs` persists (turn_state 'ended' ⇔ turn_end_reliability).
describe('CrewCommands.recordActivity turn-finished', () => {
  function workingDwarf() {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive({
      mineId: MINE,
      identity: ROOT,
      rank: 'foreman',
      status: 'working'
    })
    return { crew, dwarfId }
  }

  it('[S1.03, INV-25] a reliable turn end makes a working dwarf idle at the provider instant, asleep 60 s after it', () => {
    const { crew, dwarfId } = workingDwarf()
    // The provider ended the turn 20 s before the Host read it.
    const endedAt = crew.clock.now() + 10_000
    crew.clock.advance(30_000)

    crew.commands.recordActivity(dwarfId, 'turn-finished', { at: endedAt, reliability: 'reliable' })

    expect(crew.repository.byId(dwarfId)?.facts.turn).toEqual({
      state: 'ended',
      endedAt,
      reliability: 'reliable'
    })
    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload)).toEqual([
      { dwarfId, from: 'working', to: 'idle' }
    ])
    // INV-25: the asleep timer counts from the end's own instant, not from when it was read.
    crew.clock.advance(ASLEEP_AFTER_MS - 20_000 - 1)
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('idle')
    crew.clock.advance(1)
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('asleep')
  })

  it('[S1.04, ADR-032] an inferred turn end moves a working dwarf to idle as well, persisted inferred', () => {
    const { crew, dwarfId } = workingDwarf()
    crew.clock.advance(30_000)

    crew.commands.recordActivity(dwarfId, 'turn-finished', {
      at: crew.clock.now(),
      reliability: 'inferred'
    })

    expect(crew.repository.byId(dwarfId)?.facts.turn).toEqual({
      state: 'ended',
      endedAt: crew.clock.now(),
      reliability: 'inferred'
    })
    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload)).toEqual([
      { dwarfId, from: 'working', to: 'idle' }
    ])
  })

  it('[S1.03] a turn-finished without its end is a programming error and writes nothing', () => {
    const { crew, dwarfId } = workingDwarf()
    const before = crew.repository.byId(dwarfId)

    expect(() => crew.commands.recordActivity(dwarfId, 'turn-finished')).toThrow(HostInvariantError)
    expect(() =>
      crew.commands.recordActivity(dwarfId, 'message', { at: 1, reliability: 'reliable' })
    ).toThrow(HostInvariantError)

    expect(crew.repository.byId(dwarfId)).toEqual(before)
    expect(crew.bus.ofType('DwarfStatusChanged')).toEqual([])
  })

  it('[S1.20] a turn end reported for a departed dwarf writes nothing and publishes nothing', () => {
    const { crew, dwarfId } = workingDwarf()
    crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    const before = crew.repository.byId(dwarfId)

    crew.commands.recordActivity(dwarfId, 'turn-finished', {
      at: crew.clock.now(),
      reliability: 'reliable'
    })

    expect(crew.repository.byId(dwarfId)).toEqual(before)
    expect(crew.bus.ofType('DwarfStatusChanged')).toEqual([])
  })
})
