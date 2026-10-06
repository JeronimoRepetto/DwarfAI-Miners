// layer: L2
// L2 (17 §1.2): `CrewCommands.recordActivity` (16 §4.2 rows `recordActivity` / `startAsking` /
// `stopAsking`; 07 §1 S1.06, S1.08, S1.20) over InMemoryDwarfRepository, RecordingEventBus,
// FakeClock and FakeScheduler: the activity moves the dwarf's persisted status facts, the status is
// derived from them (INV-23), and `DwarfStatusChanged` is published only on a status change, after
// the commit (16 §2.3).
import { describe, expect, it } from 'vitest'
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
