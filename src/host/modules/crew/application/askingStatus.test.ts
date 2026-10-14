// layer: L2
// L2 (17 §1.2): `CrewCommands.startAsking` / `stopAsking` (16 §4.2 rows `recordActivity` /
// `startAsking` / `stopAsking`; 07 §1 S1.10–S1.16, S1.20; INV-23, INV-24) over
// InMemoryDwarfRepository, RecordingEventBus, FakeClock and FakeScheduler. The open ask is Host
// memory (09 §4.2 has no column for it: the repository drops `facts.openAsk`), so the status the
// timer publishes and the one the read model derives must both keep it across the dwarf's other
// commands.
import { describe, expect, it } from 'vitest'
import type { MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { ASLEEP_AFTER_MS } from '../domain/status'
import { inMemoryCrew } from '../testing/inMemoryCrew'

const MINE = '00000000-0000-7000-8000-0000000000f3' as MineId
const ROOT: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-asking' }

function dwarf(status: 'working' | 'idle') {
  const crew = inMemoryCrew()
  const dwarfId = crew.commands.arrive({ mineId: MINE, identity: ROOT, rank: 'foreman', status })
  return { crew, dwarfId }
}

describe('CrewCommands.startAsking / stopAsking', () => {
  it('[S1.10, INV-24] an ask makes an idle dwarf asking, published once with its instant and read back asking', () => {
    const { crew, dwarfId } = dwarf('idle')
    crew.clock.advance(5_000)

    crew.commands.startAsking(dwarfId, 'permission')

    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload)).toEqual([
      { dwarfId, from: 'idle', to: 'asking', askedAt: crew.clock.now() }
    ])
    expect(crew.queries.get(dwarfId)?.status).toBe('asking')
    // An asking dwarf has no wake-up: it never falls asleep by time alone (ADR-032 item 3).
    crew.clock.advance(ASLEEP_AFTER_MS * 2)
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('asking')
  })

  it('[S1.11, INV-24] a working dwarf asking stays asking through its later activity, a turn start included', () => {
    const { crew, dwarfId } = dwarf('working')

    crew.commands.startAsking(dwarfId, 'question')
    crew.commands.recordActivity(dwarfId, 'message')
    crew.commands.recordActivity(dwarfId, 'turn-started')

    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload.to)).toEqual(['asking'])
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('asking')
    expect(crew.queries.get(dwarfId)?.status).toBe('asking')
  })

  it('[S1.15] a second ask while one is open keeps the front ask and publishes nothing more', () => {
    const { crew, dwarfId } = dwarf('idle')
    const askedAt = crew.clock.now()
    crew.commands.startAsking(dwarfId, 'permission')
    crew.clock.advance(1_000)

    crew.commands.startAsking(dwarfId, 'question')

    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload)).toEqual([
      { dwarfId, from: 'idle', to: 'asking', askedAt }
    ])
  })

  it('[S1.13] the ask closing while the turn is active makes the dwarf working', () => {
    const { crew, dwarfId } = dwarf('working')
    crew.commands.startAsking(dwarfId, 'permission')

    crew.commands.stopAsking(dwarfId)

    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload.to)).toEqual([
      'asking',
      'working'
    ])
    expect(crew.queries.get(dwarfId)?.status).toBe('working')
  })

  it('[S1.14, INV-25] the ask closing with no active turn makes the dwarf idle, asleep 60 s after its last activity', () => {
    const { crew, dwarfId } = dwarf('idle')
    crew.commands.startAsking(dwarfId, 'question')
    crew.clock.advance(10_000)

    crew.commands.stopAsking(dwarfId)

    expect(crew.bus.ofType('DwarfStatusChanged').map((e) => e.payload.to)).toEqual([
      'asking',
      'idle'
    ])
    crew.clock.advance(ASLEEP_AFTER_MS - 10_000)
    expect(crew.statusTimer.statusOf(dwarfId)).toBe('asleep')
  })

  it('[INV-23] closing an ask the dwarf does not have changes nothing and publishes nothing', () => {
    const { crew, dwarfId } = dwarf('idle')

    crew.commands.stopAsking(dwarfId)

    expect(crew.bus.ofType('DwarfStatusChanged')).toEqual([])
    expect(crew.queries.get(dwarfId)?.status).toBe('idle')
  })

  it('[S1.20] an ask reported for a departed dwarf writes nothing and publishes nothing', () => {
    const { crew, dwarfId } = dwarf('idle')
    crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    const before = crew.repository.byId(dwarfId)

    crew.commands.startAsking(dwarfId, 'permission')
    crew.commands.stopAsking(dwarfId)

    expect(crew.repository.byId(dwarfId)).toEqual(before)
    expect(crew.bus.ofType('DwarfStatusChanged')).toEqual([])
    expect(crew.statusTimer.statusOf(dwarfId)).toBeNull()
  })
})
