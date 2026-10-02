// layer: L2
// L2 (17 §1.2): the CrewQueries read models (16 §4.2; 06 §5.1 `DwarfView`) over the crew
// application and its in-memory doubles: `displayName = customName ?? baseName` (INV-104 titles,
// NFR-PRIV-03), the present crew and, on request, the departed one (AMENDMENT-10, OQ-78).
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { rankForDepth } from '../domain/rank'
import { inMemoryCrew } from '../testing/inMemoryCrew'

const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const OTHER_MINE = '00000000-0000-7000-8000-0000000000f2' as MineId

const session = (n: number, mineId: MineId = MINE) => ({
  mineId,
  identity: { providerId: 'codex', providerSessionId: `thread-${n}` } satisfies ProviderIdentity,
  rank: rankForDepth(0),
  status: 'working' as const
})

/** The `14` §3.6 `DwarfWire` fields crew fills; `outcome` is conversation's, `workplace` mines'. */
const WIRE_FIELDS_CREW_FILLS = [
  'id',
  'mineId',
  'providerId',
  'baseName',
  'customName',
  'rank',
  'parentDwarfId',
  'delegated',
  'sessionProfile',
  'presence',
  'processState',
  'status',
  'needsYou',
  'canReceiveMessages',
  'stopInFlight',
  'stopUnavailableReason',
  'owned',
  'arrivedAt'
]

describe('CrewQueries', () => {
  it('[NFR-PRIV-03] displayName is the custom name when set and the base name otherwise, and crewOf lists only present dwarfs', () => {
    const crew = inMemoryCrew()
    const plain = crew.commands.arrive(session(1))
    const named = crew.commands.arrive(session(2))
    const left = crew.commands.arrive(session(3))
    crew.commands.arrive(session(4, OTHER_MINE))
    const stored = crew.repository.byId(named)
    if (stored === null) return expect.fail('the arrived dwarf is not stored')
    crew.transactionRunner.inTransaction(() =>
      crew.repository.save({ ...stored, customName: 'Gimli' })
    )
    crew.commands.sessionClosed(left, 'closed-elsewhere')

    expect(crew.queries.displayName(plain)).toBe('codex-thread-1')
    expect(crew.queries.displayName(named)).toBe('Gimli')
    // The base name stays the agent-facing name; only the display name changes (NFR-PRIV-03).
    expect(crew.queries.get(named)).toMatchObject({
      baseName: 'codex-thread-2',
      displayName: 'Gimli'
    })
    expect(crew.queries.crewOf(MINE).map((d) => [d.id, d.displayName])).toEqual([
      [plain, 'codex-thread-1'],
      [named, 'Gimli']
    ])
  })

  it('[US-MINE-006.AC01] crewOf with includeDeparted also lists the dwarfs that left the mine, each marked departed', () => {
    const crew = inMemoryCrew()
    const stays = crew.commands.arrive(session(1))
    const left = crew.commands.arrive(session(2))
    crew.commands.sessionClosed(left, 'closed-elsewhere')

    const everyone = crew.queries.crewOf(MINE, { includeDeparted: true })

    expect(everyone.map((d) => [d.id, d.departed])).toEqual([
      [stays, false],
      [left, true]
    ])
    expect(everyone[1]).toMatchObject({
      departureCause: 'closed-elsewhere',
      presence: 'walking-out'
    })
    expect(crew.queries.crewOf(MINE, { includeDeparted: false }).map((d) => d.id)).toEqual([stays])
  })

  it('[ADR-032] get fills every DwarfWire field crew owns, with the derived ones read at the clock now', () => {
    const crew = inMemoryCrew()
    const dwarfId = crew.commands.arrive(session(1))
    crew.owned.add(dwarfId)
    crew.routed.add(dwarfId)

    const view = crew.queries.get(dwarfId)

    expect(Object.keys(view ?? {})).toEqual(expect.arrayContaining(WIRE_FIELDS_CREW_FILLS))
    expect(view).toMatchObject({
      id: dwarfId,
      providerId: 'codex',
      status: 'working',
      needsYou: false,
      canReceiveMessages: true,
      stopUnavailableReason: null,
      owned: true
    })
    expect(crew.queries.get('00000000-0000-7000-8000-0000000000aa' as DwarfId)).toBeNull()
  })

  it('[INV-29] displayName of a dwarf that never existed is a programming error', () => {
    const crew = inMemoryCrew()
    expect(() =>
      crew.queries.displayName('00000000-0000-7000-8000-0000000000aa' as DwarfId)
    ).toThrow(HostInvariantError)
  })
})
