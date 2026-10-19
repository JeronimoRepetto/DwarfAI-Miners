import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { baseNameFor } from './baseName'
import { applyPresence, arriveDwarf, rebindDwarf, type DwarfArrival } from './dwarf'
import { rankForDepth } from './rank'

const T0 = 1_790_000_000_000
const ID = 'dwarf-1' as DwarfId
const MINE = 'mine-1' as MineId

/** One arrival of a root session (ISSUE-069 adds the mine, the identity and the names). */
const ARRIVAL: DwarfArrival = {
  id: ID,
  mineId: MINE,
  identity: { providerId: 'claude', providerSessionId: 'session-1' },
  baseName: 'claude-session-',
  delegated: false,
  parentDwarfId: null,
  rank: rankForDepth(0),
  status: 'working',
  at: T0
}

/**
 * The fields of the aggregate (06 §5.1); none is an origin. ISSUE-069 added the stored fields
 * beyond machines 1 and 2 (mine, identity, names, profile, stop flag, usage path); `workplace`
 * joins with the mines issue that stamps it.
 */
const FIELDS = [
  'arrivedAt',
  'baseName',
  'customName',
  'delegated',
  'departedAt',
  'departureCause',
  'facts',
  'id',
  'identity',
  'mineId',
  'parentDwarfId',
  'pendingEnd',
  'presence',
  'previousProviderSessionId',
  'processState',
  'rank',
  'sessionProfile',
  'stopInFlight',
  'usagePath'
]

describe('the Dwarf aggregate (06 §5.1)', () => {
  it('[INV-30] no Dwarf field tells a launched dwarf from an observed one', () => {
    // The launch route arrives with its first message pending; the observation route with a turn
    // already in progress (US-OBS-006). Both are the same arrival, so both are the same dwarf.
    const arrival: DwarfArrival = { ...ARRIVAL }
    const launched = arriveDwarf({ ...arrival })
    const observed = arriveDwarf({ ...arrival })
    expect(launched).toEqual(observed)
    expect(Object.keys(launched).sort()).toEqual(FIELDS)
    expect(
      Object.keys(launched).filter((k) => /origin|launch|observ|owned|source/i.test(k))
    ).toEqual([])
    // Departing keeps the same field set: the cause says why it left, never how it came.
    const left = applyPresence(launched, { type: 'session-closed', cause: 'crashed', at: T0 + 1 })
    expect(left.ok && Object.keys(left.value).sort()).toEqual(FIELDS)
  })
})

describe('rebinding a dwarf (06 §5.1; ADR-015 item 7)', () => {
  const root: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }

  it('[INV-22] rebinding keeps the id, the custom name and the rank, and stores the previous provider session id', () => {
    const dwarf = {
      ...arriveDwarf({ ...ARRIVAL, identity: root }),
      customName: 'Gimli'
    }
    const next: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-2' }

    const rebound = rebindDwarf(dwarf, next)

    expect(rebound).toEqual({ ...dwarf, identity: next, previousProviderSessionId: 'session-1' })
  })

  it('[INV-22] a rebind that keeps the session id keeps the stored previous session id', () => {
    const dwarf = {
      ...arriveDwarf({ ...ARRIVAL, identity: root }),
      previousProviderSessionId: 'session-0'
    }
    const sameSession: ProviderIdentity = { ...root, providerAgentId: 'agent-1' }

    expect(rebindDwarf(dwarf, sameSession)).toEqual({ ...dwarf, identity: sameSession })
  })
})

describe('the base name (06 §5.1 `baseName`)', () => {
  it('[INV-20] the base name comes from the provider identity, never from the dwarf id', () => {
    expect(baseNameFor({ providerId: 'codex', providerSessionId: '0199aabbccddeeff' })).toBe(
      'codex-0199aabb'
    )
    expect(
      baseNameFor({
        providerId: 'claude',
        providerSessionId: '0199aabbccddeeff',
        providerAgentId: 'a7f3c2d19e'
      })
    ).toBe('claude-a7f3c2d1')
    expect(
      baseNameFor({ providerId: 'opencode', providerSessionId: 's1', providerAgentId: '' })
    ).toBe('opencode-s1')
  })
})
