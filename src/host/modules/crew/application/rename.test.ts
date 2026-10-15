// layer: L2
// L2 (17 §1.2): `CrewCommands.rename` and `resetName` (16 §4.2; AMENDMENT-2, SC-AR-05) over
// InMemoryDwarfRepository, RecordingEventBus, FakeClock and SequenceIdGenerator: the `DwarfName`
// stored as the custom name, the base name and an empty text, `DwarfRenamed` after commit and only
// on a change (08 §0), a departed dwarf left as it is (16 §2.1).
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { CREW_EPOCH, CREW_T0, inMemoryCrew } from '../testing/inMemoryCrew'

const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const ROOT: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }
const BASE = 'claude-session-'

function arrived() {
  const crew = inMemoryCrew()
  const dwarfId = crew.commands.arrive({
    mineId: MINE,
    identity: ROOT,
    rank: 'foreman',
    status: 'idle'
  })
  return { crew, dwarfId }
}

const renamed = (crew: ReturnType<typeof inMemoryCrew>) =>
  crew.bus.ofType('DwarfRenamed').map((event) => event.payload)

describe('CrewCommands rename and resetName (16 §4.2)', () => {
  it('[US-MSG-005.AC02, US-MSG-005.AC07, INV-29] rename stores the normalized name and publishes DwarfRenamed after the commit', () => {
    const { crew, dwarfId } = arrived()
    expect(crew.queries.get(dwarfId)?.baseName).toBe(BASE)

    expect(crew.commands.rename(dwarfId, '  Watcher   of seals ')).toStrictEqual({
      ok: true,
      value: 'Watcher of seals'
    })

    expect(crew.repository.byId(dwarfId)?.customName).toBe('Watcher of seals')
    expect(crew.queries.displayName(dwarfId)).toBe('Watcher of seals')
    const [event] = crew.bus.ofType('DwarfRenamed')
    expect(event).toMatchObject({
      type: 'DwarfRenamed',
      v: 1,
      at: CREW_T0,
      hostEpoch: CREW_EPOCH,
      payload: { dwarfId, customName: 'Watcher of seals' }
    })
    // The base name, the only agent-facing name, never changes (NFR-PRIV-03).
    expect(crew.repository.byId(dwarfId)?.baseName).toBe(BASE)
  })

  it('[US-MSG-005.AC04] a rename to the base name is a reset answering null, and an empty text is refused as empty', () => {
    const { crew, dwarfId } = arrived()
    crew.commands.rename(dwarfId, 'Gimli')

    expect(crew.commands.rename(dwarfId, `  ${BASE} 🪓`)).toStrictEqual({ ok: true, value: null })
    expect(crew.repository.byId(dwarfId)?.customName).toBeNull()
    expect(renamed(crew)).toStrictEqual([
      { dwarfId, customName: 'Gimli' },
      { dwarfId, customName: null }
    ])

    crew.commands.rename(dwarfId, 'Gimli')
    for (const text of ['', '   ', '🪓\u0007']) {
      expect(crew.commands.rename(dwarfId, text), JSON.stringify(text)).toStrictEqual({
        ok: false,
        error: 'empty'
      })
    }
    // Nothing stored for a refused name: the previous one stays.
    expect(crew.repository.byId(dwarfId)?.customName).toBe('Gimli')
    expect(renamed(crew)).toHaveLength(3)
  })

  it('[US-MSG-006.AC03] resetName clears the custom name at once and publishes DwarfRenamed with no name', () => {
    const { crew, dwarfId } = arrived()
    crew.commands.rename(dwarfId, 'Gimli')

    crew.commands.resetName(dwarfId)

    expect(crew.repository.byId(dwarfId)?.customName).toBeNull()
    expect(crew.queries.displayName(dwarfId)).toBe(BASE)
    expect(renamed(crew).at(-1)).toStrictEqual({ dwarfId, customName: null })
  })

  it('[US-MSG-005.AC04] DwarfRenamed is published only on a change of the custom name', () => {
    const { crew, dwarfId } = arrived()

    crew.commands.resetName(dwarfId)
    crew.commands.rename(dwarfId, BASE)
    crew.commands.rename(dwarfId, 'Gimli')
    crew.commands.rename(dwarfId, ' Gimli ')
    crew.commands.resetName(dwarfId)
    crew.commands.resetName(dwarfId)

    expect(renamed(crew)).toStrictEqual([
      { dwarfId, customName: 'Gimli' },
      { dwarfId, customName: null }
    ])
  })

  it('[US-MSG-005.AC13] a departed dwarf keeps its custom name and a later rename or reset changes nothing', () => {
    const { crew, dwarfId } = arrived()
    crew.commands.rename(dwarfId, 'Gimli')
    crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')

    expect(crew.commands.rename(dwarfId, 'Ori')).toStrictEqual({ ok: true, value: 'Gimli' })
    crew.commands.resetName(dwarfId)

    expect(crew.repository.byId(dwarfId)?.customName).toBe('Gimli')
    expect(renamed(crew)).toHaveLength(1)
  })

  it('[INV-29] a name above 24 graphemes, which UI main and the transport refuse first, is a programming error that stores nothing', () => {
    const { crew, dwarfId } = arrived()

    expect(() => crew.commands.rename(dwarfId, 'a'.repeat(25))).toThrow(HostInvariantError)
    expect(() =>
      crew.commands.rename('01890a5d-ac96-774b-bcce-000000000999' as DwarfId, 'Ori')
    ).toThrow(HostInvariantError)
    expect(crew.repository.byId(dwarfId)?.customName).toBeNull()
    expect(renamed(crew)).toStrictEqual([])
  })
})
