import type { MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { BELEGOST, EREBOR, IRONHILLS, KHAZAD, MORIA } from '../veta/testing/vetaFixtures'
import {
  mosaicOrder,
  openMosaic,
  slotMenu,
  stepMosaic,
  type Mosaic,
  type MosaicFacts,
  type MosaicInput,
  type MosaicMine
} from './mosaic'

/*
 * 07 machine 32 (ISSUE-304; US-VALLE-006, US-VALLE-009.AC03; UC-058; 17 §1.1 diagram-conformance walk): which mines the
 * Control room mosaic shows and in what order, "Close this column", the dashed "Add a mine here" slot and its folder
 * flow, and S32.15 (Reset preset recomputes the order; ISSUE-309). An input the machine does not list is refused.
 */

const mine = (
  mineId: MineId,
  name: string,
  over: Partial<Omit<MosaicMine, 'mineId' | 'name'>> = {}
): MosaicMine => ({ mineId, name, tier: 'silver', enterable: true, crew: 1, ...over })

/** Five mines in the Host's data order: Erebor has no crew, Khazad cannot be entered and has never been measured. */
const FACTS: MosaicFacts = {
  preset: 'control',
  mines: [
    mine(MORIA, 'Moria'),
    mine(EREBOR, 'Erebor', { crew: 0, tier: 'gold' }),
    mine(KHAZAD, 'Khazad', { enterable: false, tier: null }),
    mine(IRONHILLS, 'Iron Hills', { crew: 2, tier: 'copper' }),
    mine(BELEGOST, 'Belegost', { crew: 0, tier: null })
  ]
}

/** A mosaic at rest; `arranged` false: the person never arranged it (owner ruling 2026-10-23, VQA-07). */
const idle = (order: readonly MineId[], arranged = true): Mosaic => ({
  state: 'idle',
  order,
  arranged
})
const at = (state: Mosaic['state'], order: readonly MineId[], arranged = true): Mosaic => ({
  state,
  order,
  arranged
})

describe('machine 32 diagram conformance', () => {
  it('[US-VALLE-009.AC03, S32.03] Close this column takes the mine out of the mosaic with its toast while the mine, its dwarfs and their sessions keep running', () => {
    const step = stepMosaic(
      idle([MORIA, KHAZAD, IRONHILLS]),
      { kind: 'close', mineId: KHAZAD },
      FACTS
    )
    // The order without it, written at once, and the toast: nothing else, so nothing reaches the Host (TC-304-02).
    expect(step).toEqual({
      ok: true,
      id: 'S32.03',
      mosaic: idle([MORIA, IRONHILLS]),
      effects: [
        { kind: 'write-order', order: [MORIA, IRONHILLS] },
        { kind: 'toast', text: 'Khazad left the Control room · its dwarfs keep working' }
      ]
    })
    // A mine not in the mosaic has no column to close.
    expect(stepMosaic(idle([MORIA]), { kind: 'close', mineId: EREBOR }, FACTS).ok).toBe(false)
  })

  it('[US-VALLE-006.AC01, S32.04] the add slot lists every mine not in the mosaic with its tier, or disabled and not enterable, then A new project…', () => {
    const open = stepMosaic(idle([MORIA, IRONHILLS]), { kind: 'slot' }, FACTS)
    expect(open).toEqual({
      ok: true,
      id: 'S32.04',
      mosaic: at('slot-menu', [MORIA, IRONHILLS]),
      effects: []
    })
    // In data order; a mine already in the mosaic is never offered; a tier never measured reads as Bronze.
    expect(slotMenu(at('slot-menu', [MORIA, IRONHILLS]), FACTS)).toEqual([
      { kind: 'mine', mineId: EREBOR, name: 'Erebor', note: 'Gold', disabled: false },
      { kind: 'mine', mineId: KHAZAD, name: 'Khazad', note: 'not enterable', disabled: true },
      { kind: 'mine', mineId: BELEGOST, name: 'Belegost', note: 'Bronze', disabled: false },
      { kind: 'rule' },
      { kind: 'new-project', label: 'A new project…' }
    ])
  })

  it('[US-VALLE-006.AC02, S32.05] picking an enterable mine appends it and the stored order includes it', () => {
    expect(stepMosaic(at('slot-menu', [MORIA]), { kind: 'pick', mineId: EREBOR }, FACTS)).toEqual({
      ok: true,
      id: 'S32.05',
      mosaic: idle([MORIA, EREBOR]),
      effects: [{ kind: 'write-order', order: [MORIA, EREBOR] }]
    })
    // A mine already shown is not offered, so it is never appended twice.
    expect(stepMosaic(at('slot-menu', [MORIA]), { kind: 'pick', mineId: MORIA }, FACTS).ok).toBe(
      false
    )
  })

  it('[US-VALLE-006.AC05, S32.06] picking a not enterable mine does nothing', () => {
    expect(stepMosaic(at('slot-menu', [MORIA]), { kind: 'pick', mineId: KHAZAD }, FACTS)).toEqual({
      ok: true,
      id: 'S32.06',
      mosaic: at('slot-menu', [MORIA]),
      effects: []
    })
  })

  it('[US-VALLE-006.AC06, S32.07] Esc or an outside click closes the slot menu and nothing else changes', () => {
    expect(stepMosaic(at('slot-menu', [MORIA, KHAZAD]), { kind: 'dismiss' }, FACTS)).toEqual({
      ok: true,
      id: 'S32.07',
      mosaic: idle([MORIA, KHAZAD]),
      effects: []
    })
  })

  it('[S32.08, S32.09, S32.10, S32.11, S32.12] A new project… runs the folder flow and appends the mine it declares', () => {
    expect(stepMosaic(at('slot-menu', [MORIA]), { kind: 'new-project' }, FACTS)).toEqual({
      ok: true,
      id: 'S32.08',
      mosaic: at('choosing-folder', [MORIA]),
      effects: [{ kind: 'pick-folder' }]
    })
    expect(stepMosaic(at('choosing-folder', [MORIA]), { kind: 'folder-cancelled' }, FACTS)).toEqual(
      {
        ok: true,
        id: 'S32.09',
        mosaic: idle([MORIA]),
        effects: []
      }
    )
    expect(stepMosaic(at('choosing-folder', [MORIA]), { kind: 'folder-picked' }, FACTS)).toEqual({
      ok: true,
      id: 'S32.10',
      mosaic: at('declaring', [MORIA]),
      effects: []
    })
    // A new mine (never in the facts yet) is appended; an existing one already shown is not appended twice.
    const NEW = '01920000-0000-7000-8000-00000000a0ff' as MineId
    expect(stepMosaic(at('declaring', [MORIA]), { kind: 'declared', mineId: NEW }, FACTS)).toEqual({
      ok: true,
      id: 'S32.11',
      mosaic: idle([MORIA, NEW]),
      effects: [{ kind: 'write-order', order: [MORIA, NEW] }]
    })
    expect(
      stepMosaic(at('declaring', [MORIA]), { kind: 'declared', mineId: MORIA }, FACTS)
    ).toEqual({
      ok: true,
      id: 'S32.11',
      mosaic: idle([MORIA]),
      effects: []
    })
    expect(stepMosaic(at('declaring', [MORIA]), { kind: 'declare-failed' }, FACTS)).toEqual({
      ok: true,
      id: 'S32.12',
      mosaic: idle([MORIA]),
      effects: []
    })
  })

  it('[S32.01, S32.13, S32.14, S32.16] the first order, a removed mine, a column added for a jump and Reset metrics follow 07 machine 32', () => {
    // S32.01: no stored order: every mine with at least one dwarf, in the Host's data order.
    // AMENDED for owner ruling 2026-10-23 (VQA-07) (was: persisted at once): not arranged by the person, so computed
    // live and never written.
    expect(openMosaic(null, FACTS)).toEqual({
      ok: true,
      id: 'S32.01',
      mosaic: idle([MORIA, KHAZAD, IRONHILLS], false),
      effects: []
    })
    // S32.13: a mosaic mine removed: its column leaves, the entry dropped.
    expect(
      stepMosaic(idle([MORIA, KHAZAD]), { kind: 'mine-removed', mineId: MORIA }, FACTS)
    ).toEqual({
      ok: true,
      id: 'S32.13',
      mosaic: idle([KHAZAD]),
      effects: [{ kind: 'write-order', order: [KHAZAD] }]
    })
    // S32.14: a jump, a reveal, a history request or a map marker for a mine not in the mosaic appends its column and
    // scrolls to it; the Control room only.
    expect(stepMosaic(idle([MORIA]), { kind: 'reveal', mineId: EREBOR }, FACTS)).toEqual({
      ok: true,
      id: 'S32.14',
      mosaic: idle([MORIA, EREBOR]),
      effects: [
        { kind: 'write-order', order: [MORIA, EREBOR] },
        { kind: 'scroll-to', mineId: EREBOR }
      ]
    })
    expect(
      stepMosaic(idle([MORIA]), { kind: 'reveal', mineId: EREBOR }, { ...FACTS, preset: 'front' })
        .ok
    ).toBe(false)
    // S32.16: Reset metrics, from any state: the order "never written" again (UI main rewrote it), the next open S32.01.
    for (const state of ['idle', 'slot-menu', 'choosing-folder', 'declaring'] as const) {
      expect(stepMosaic(at(state, [MORIA]), { kind: 'reset-metrics' }, FACTS)).toEqual({
        ok: true,
        id: 'S32.16',
        mosaic: null,
        effects: []
      })
    }
  })

  it('[US-VALLE-006.AC08, S32.01, S32.02] after the first visit a mine whose first dwarf arrives does not join the mosaic by itself', () => {
    // OQ-77 (owner answer A; 07 I-31): after the first visit the mosaic is the person's.
    const first = openMosaic(null, FACTS)
    expect(first).toMatchObject({ id: 'S32.01', mosaic: idle([MORIA, KHAZAD, IRONHILLS], false) })
    // Erebor gets its first dwarf: the next open restores the order as stored (S32.02), nothing written, nothing added.
    const later: MosaicFacts = {
      ...FACTS,
      mines: FACTS.mines.map((each) => (each.mineId === EREBOR ? { ...each, crew: 1 } : each))
    }
    expect(openMosaic([MORIA, KHAZAD, IRONHILLS], later)).toEqual({
      ok: true,
      id: 'S32.02',
      mosaic: idle([MORIA, KHAZAD, IRONHILLS]),
      effects: []
    })
    // AMENDED for owner ruling 2026-10-23 (VQA-07) (was: a stored `[]` stays empty, the person's): a stored `[]` is
    // what a first visit with no mine wrote, so it reads as not arranged and the mosaic is computed again. Known risk,
    // accepted: someone who closed every column gets the mines back on the next open.
    expect(openMosaic([], later)).toEqual({
      ok: true,
      id: 'S32.01',
      mosaic: idle([MORIA, EREBOR, KHAZAD, IRONHILLS], false),
      effects: []
    })
    // An entry whose mine no longer exists is dropped on the way in, the stored value never rewritten.
    expect(openMosaic([EREBOR, '01920000-0000-7000-8000-00000000a0fe' as MineId], later)).toEqual({
      ok: true,
      id: 'S32.02',
      mosaic: idle([EREBOR]),
      effects: []
    })
  })

  // Owner ruling 2026-10-23 (VQA-07): until the person arranges the order themselves, every new mine joins the Control
  // room; their first close, pick, reveal, declare or Reset preset writes the order and it is theirs from then on.
  it('[US-VALLE-006.AC08, S32.01] a mosaic the person never arranged follows the mines live, written only when the person arranges it', () => {
    const empty: MosaicFacts = { preset: 'control', mines: [] }
    const first = openMosaic(null, empty)
    expect(first).toEqual({ ok: true, id: 'S32.01', mosaic: idle([], false), effects: [] })
    if (!first.ok || first.mosaic === null) throw new Error('opened')
    // The first mine with a crew appears: it joins, nothing written.
    const one: MosaicFacts = { preset: 'control', mines: [mine(MORIA, 'Moria')] }
    expect(mosaicOrder(first.mosaic, one)).toEqual([MORIA])
    // Every mine with a crew joins, in the Host's data order; a mine with no crew yet does not.
    expect(mosaicOrder(first.mosaic, FACTS)).toEqual([MORIA, KHAZAD, IRONHILLS])
    // A mine removed while not arranged leaves by itself: nothing written, still not arranged.
    const removed = stepMosaic(first.mosaic, { kind: 'mine-removed', mineId: MORIA }, FACTS)
    expect(removed).toEqual({
      ok: true,
      id: 'S32.13',
      mosaic: idle([KHAZAD, IRONHILLS], false),
      effects: []
    })
    // Close this column arranges it: the live order without the mine, written, the person's from then on.
    const closed = stepMosaic(first.mosaic, { kind: 'close', mineId: KHAZAD }, FACTS)
    expect(closed).toMatchObject({
      ok: true,
      id: 'S32.03',
      mosaic: idle([MORIA, IRONHILLS]),
      effects: [{ kind: 'write-order', order: [MORIA, IRONHILLS] }, { kind: 'toast' }]
    })
    if (!closed.ok || closed.mosaic === null) throw new Error('closed')
    const later: MosaicFacts = {
      ...FACTS,
      mines: FACTS.mines.map((each) => (each.mineId === EREBOR ? { ...each, crew: 1 } : each))
    }
    expect(mosaicOrder(closed.mosaic, later)).toEqual([MORIA, IRONHILLS])
    // A reveal, a pick and Reset preset arrange it too.
    const live = idle([], false)
    expect(stepMosaic(live, { kind: 'reveal', mineId: EREBOR }, FACTS)).toMatchObject({
      id: 'S32.14',
      mosaic: idle([MORIA, KHAZAD, IRONHILLS, EREBOR]),
      effects: [
        { kind: 'write-order', order: [MORIA, KHAZAD, IRONHILLS, EREBOR] },
        { kind: 'scroll-to' }
      ]
    })
    expect(
      stepMosaic(at('slot-menu', [], false), { kind: 'pick', mineId: EREBOR }, FACTS)
    ).toMatchObject({ id: 'S32.05', mosaic: idle([MORIA, KHAZAD, IRONHILLS, EREBOR]) })
    expect(stepMosaic(live, { kind: 'reset-preset' }, FACTS)).toMatchObject({
      id: 'S32.15',
      mosaic: idle([MORIA, KHAZAD, IRONHILLS]),
      effects: [{ kind: 'write-order', order: [MORIA, KHAZAD, IRONHILLS] }]
    })
    // A declared mine with a crew already shown live: arranged and written as shown.
    expect(
      stepMosaic(at('declaring', [], false), { kind: 'declared', mineId: MORIA }, FACTS)
    ).toMatchObject({
      id: 'S32.11',
      mosaic: idle([MORIA, KHAZAD, IRONHILLS]),
      effects: [{ kind: 'write-order', order: [MORIA, KHAZAD, IRONHILLS] }]
    })
    // The slot's menu offers what the live order does not show.
    expect(slotMenu(at('slot-menu', [], false), FACTS).filter((e) => e.kind === 'mine')).toEqual([
      { kind: 'mine', mineId: EREBOR, name: 'Erebor', note: 'Gold', disabled: false },
      { kind: 'mine', mineId: BELEGOST, name: 'Belegost', note: 'Bronze', disabled: false }
    ])
  })

  it('[US-VALLE-010.AC03, S32.15] Reset preset in the Control room recomputes the order from every mine with a crew in data order, written at once', () => {
    // The person had closed one column and arranged the rest their own way (Iron Hills first, Erebor added).
    const step = stepMosaic(idle([IRONHILLS, EREBOR]), { kind: 'reset-preset' }, FACTS)
    expect(step).toEqual({
      ok: true,
      id: 'S32.15',
      mosaic: idle([MORIA, KHAZAD, IRONHILLS]),
      effects: [{ kind: 'write-order', order: [MORIA, KHAZAD, IRONHILLS] }]
    })
    // An emptied mosaic is recomputed too: it is not the person's order that survives a reset.
    expect(stepMosaic(idle([]), { kind: 'reset-preset' }, FACTS)).toMatchObject({
      ok: true,
      id: 'S32.15',
      mosaic: idle([MORIA, KHAZAD, IRONHILLS])
    })
    // The Work front keeps no mosaic of its own: the Control room's reset alone recomputes it.
    expect(
      stepMosaic(idle([EREBOR]), { kind: 'reset-preset' }, { ...FACTS, preset: 'front' })
    ).toEqual({ ok: false, reason: 'not-listed' })
  })

  it('[ADR-024] a transition not listed in 07 machine 32 is rejected', () => {
    const refused: readonly [Mosaic, MosaicInput][] = [
      // The slot's own inputs need its menu open, the folder's the picker open, the declare's a declare in flight.
      [idle([MORIA]), { kind: 'pick', mineId: EREBOR }],
      [idle([MORIA]), { kind: 'dismiss' }],
      [idle([MORIA]), { kind: 'new-project' }],
      [at('slot-menu', [MORIA]), { kind: 'slot' }],
      [at('slot-menu', [MORIA]), { kind: 'folder-picked' }],
      [idle([MORIA]), { kind: 'folder-cancelled' }],
      [at('choosing-folder', [MORIA]), { kind: 'declared', mineId: EREBOR }],
      [idle([MORIA]), { kind: 'declare-failed' }],
      // A column closes, a mine is removed or revealed only at rest.
      [at('slot-menu', [MORIA]), { kind: 'close', mineId: MORIA }],
      [at('declaring', [MORIA]), { kind: 'reveal', mineId: EREBOR }],
      // A removed mine that has no column, and a reveal of a mine already shown, change nothing.
      [idle([MORIA]), { kind: 'mine-removed', mineId: EREBOR }],
      [idle([MORIA]), { kind: 'reveal', mineId: MORIA }],
      // S32.15 is `idle` → `idle`: with the slot's menu or the folder flow open, nothing is recomputed.
      [at('slot-menu', [MORIA]), { kind: 'reset-preset' }],
      [at('choosing-folder', [MORIA]), { kind: 'reset-preset' }],
      [at('declaring', [MORIA]), { kind: 'reset-preset' }]
    ]
    for (const [mosaic, input] of refused) {
      expect(stepMosaic(mosaic, input, FACTS), `${mosaic.state} ${input.kind}`).toEqual({
        ok: false,
        reason: 'not-listed'
      })
    }
  })
})
