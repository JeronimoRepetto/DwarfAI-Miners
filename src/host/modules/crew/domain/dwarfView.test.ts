import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { applyPresence, arriveDwarf, type Dwarf } from './dwarf'
import { displayNameOf, viewOf, type SessionLinksOf } from './dwarfView'
import { rankForDepth } from './rank'
import { ASLEEP_AFTER_MS } from './status'
import { askOpened } from './statusFacts'

const T0 = 1_790_000_000_000
const LINKED: SessionLinksOf = { owned: false, hasDeliveryRoute: true }

const dwarf = (): Dwarf =>
  arriveDwarf({
    id: 'dwarf-1' as DwarfId,
    mineId: 'mine-1' as MineId,
    identity: { providerId: 'codex', providerSessionId: 'session-1' },
    baseName: 'codex-session-',
    delegated: false,
    parentDwarfId: null,
    rank: rankForDepth(0),
    status: 'idle',
    at: T0
  })

describe('the DwarfView read model (06 §5.1)', () => {
  it('[INV-33] canReceiveMessages only while the process runs and a delivery route exists', () => {
    const running = dwarf()
    const unrecovered = applyPresence(running, { type: 'listed-unrecovered' })
    const closed = applyPresence(running, {
      type: 'session-closed',
      cause: 'closed-elsewhere',
      at: T0 + 1
    })
    if (!unrecovered.ok || !closed.ok) throw new Error('fixture transitions refused')

    expect(viewOf(running, T0, LINKED).canReceiveMessages).toBe(true)
    expect(viewOf(running, T0, { ...LINKED, hasDeliveryRoute: false }).canReceiveMessages).toBe(
      false
    )
    expect(viewOf(unrecovered.value, T0, LINKED).canReceiveMessages).toBe(false)
    expect(viewOf(closed.value, T0, LINKED).canReceiveMessages).toBe(false)
  })

  it('[INV-31] stop is unavailable as already-stopping only while a stop is in flight', () => {
    expect(viewOf(dwarf(), T0, LINKED).stopUnavailableReason).toBeNull()
    expect(viewOf({ ...dwarf(), stopInFlight: true }, T0, LINKED).stopUnavailableReason).toBe(
      'already-stopping'
    )
  })

  it('[ADR-032] the status is derived at the instant asked, needsYou iff asking, with askedAt', () => {
    const idle = dwarf()
    expect(viewOf(idle, T0, LINKED)).toMatchObject({ status: 'idle', needsYou: false })
    expect(viewOf(idle, T0 + ASLEEP_AFTER_MS, LINKED)).toMatchObject({
      status: 'asleep',
      needsYou: false
    })
    const asking: Dwarf = {
      ...idle,
      facts: askOpened(idle.facts, { kind: 'question', askedAt: T0 + 5, state: 'open' })
    }
    expect(viewOf(asking, T0 + 6, LINKED)).toMatchObject({
      status: 'asking',
      needsYou: true,
      askedAt: T0 + 5
    })
    expect(viewOf(idle, T0, LINKED)).not.toHaveProperty('askedAt')
  })

  it('[INV-30] owned comes from the session links, never from a Dwarf field', () => {
    expect(viewOf(dwarf(), T0, { ...LINKED, owned: true }).owned).toBe(true)
    expect(viewOf(dwarf(), T0, LINKED).owned).toBe(false)
  })

  it('[US-MINE-006.AC01] a departed dwarf is marked departed, a present one is not', () => {
    const left = applyPresence(dwarf(), { type: 'session-closed', cause: 'crashed', at: T0 + 1 })
    if (!left.ok) throw new Error('fixture transition refused')
    expect(viewOf(dwarf(), T0, LINKED).departed).toBe(false)
    expect(viewOf(left.value, T0 + 1, LINKED)).toMatchObject({
      departed: true,
      departureCause: 'crashed'
    })
  })

  it('[INV-29] the display name is the custom name when set and the base name otherwise', () => {
    expect(displayNameOf(dwarf())).toBe('codex-session-')
    expect(displayNameOf({ ...dwarf(), customName: 'Gimli' })).toBe('Gimli')
    expect(viewOf({ ...dwarf(), customName: 'Gimli' }, T0, LINKED).displayName).toBe('Gimli')
  })
})
