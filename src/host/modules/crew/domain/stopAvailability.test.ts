// layer: L1
// L1 (17 §1.1): whether "Stop dwarf…" is available for a dwarf (16 §4.2 `CrewCommands.stop`
// precondition; 06 INV-31 as amended by AMENDMENT-2, OQ-54; 07 S15.18): only a stop already in
// flight makes it unavailable. An open turn, an open ask or an observed session never does.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { arriveDwarf, type Dwarf } from './dwarf'
import { classifyDwarfStatus } from './status'
import { askOpened, turnStarted } from './statusFacts'
import { stopAvailability, stopUnavailableReason } from './stopAvailability'

const T0 = 1_790_000_000_000

function dwarf(status: 'working' | 'idle' = 'idle'): Dwarf {
  return arriveDwarf({
    id: '00000000-0000-7000-8000-000000000171' as DwarfId,
    mineId: '00000000-0000-7000-8000-0000000001f1' as MineId,
    identity: { providerId: 'codex', providerSessionId: 'thread-171' },
    baseName: 'Borin',
    delegated: false,
    parentDwarfId: null,
    rank: 'foreman',
    status,
    at: T0
  })
}

describe('stopAvailability (16 §4.2 stop precondition, INV-31)', () => {
  it('[US-MSG-016.AC01, INV-31, S15.18] Stop dwarf is available while a turn is open', () => {
    const working = { ...dwarf('idle'), facts: turnStarted(dwarf('idle').facts, T0 + 1_000) }
    expect(classifyDwarfStatus(working.facts, T0 + 2_000)).toBe('working')

    expect(stopAvailability(working)).toBe('available')
    expect(stopUnavailableReason(stopAvailability(working))).toBeNull()
    // An open ask during the turn changes nothing either: the whole session ends (OQ-54).
    const asking = {
      ...working,
      facts: askOpened(working.facts, { kind: 'permission', askedAt: T0 + 1_500, state: 'open' })
    }
    expect(stopAvailability(asking)).toBe('available')
  })

  it('[US-MSG-016.AC02, INV-31] Stop dwarf is unavailable with already-stopping only while a stop is in flight', () => {
    const stopping = { ...dwarf('working'), stopInFlight: true }
    expect(stopAvailability(stopping)).toBe('unavailable-stop-in-flight')
    expect(stopUnavailableReason(stopAvailability(stopping))).toBe('already-stopping')

    // The stop settled (failed, S15.15): available again.
    const settled = { ...stopping, stopInFlight: false }
    expect(stopAvailability(settled)).toBe('available')
    expect(stopUnavailableReason(stopAvailability(settled))).toBeNull()
  })

  it('[US-MSG-016.AC04] an idle observed dwarf can be stopped exactly like any other', () => {
    // `arrive` binds an observed dwarf (usage path `transcript`); it is idle with no turn yet.
    const observed = dwarf('idle')
    expect(observed.usagePath).toBe('transcript')
    expect(classifyDwarfStatus(observed.facts, T0)).toBe('idle')

    expect(stopAvailability(observed)).toBe('available')
    expect(stopAvailability(observed)).toBe(stopAvailability(dwarf('working')))
  })
})
