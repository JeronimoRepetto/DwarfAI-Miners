import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { applyPresence, arriveDwarf, type DwarfArrival } from './dwarf'
import { rankForDepth } from './rank'

const T0 = 1_790_000_000_000
const ID = 'dwarf-1' as DwarfId

/** The fields machines 1 and 2 give the aggregate so far (06 §5.1); none is an origin. */
const FIELDS = [
  'arrivedAt',
  'departedAt',
  'departureCause',
  'facts',
  'id',
  'parentDwarfId',
  'pendingEnd',
  'presence',
  'processState',
  'rank'
]

describe('the Dwarf aggregate (06 §5.1)', () => {
  it('[INV-30] no Dwarf field tells a launched dwarf from an observed one', () => {
    // The launch route arrives with its first message pending; the observation route with a turn
    // already in progress (US-OBS-006). Both are the same arrival, so both are the same dwarf.
    const arrival: DwarfArrival = {
      id: ID,
      parentDwarfId: null,
      rank: rankForDepth(0),
      status: 'working',
      at: T0
    }
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
