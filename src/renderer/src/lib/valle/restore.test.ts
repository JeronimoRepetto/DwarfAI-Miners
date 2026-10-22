import type { DwarfId, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { defaultValleLayouts, stepValle, type ValleLayouts } from './preset'
import { restoreMosaicOrder, restorePins, restoreSplit, restoreValleView } from './restore'

/*
 * What Valle restores when it opens (ISSUE-300; 07 S28.01, S28.02, S29.02, S18.05, S32.02, S30.13; ADR-024 items 1, 4;
 * INV-117): the preset and both layouts as they were left, the pins in their order (a dwarf ended meanwhile `gone`), the
 * mosaic order, and the split wish re-evaluated.
 */

const MORIA = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a11' as MineId
const EREBOR = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a12' as MineId
const LOST_MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a13' as MineId
const BORIN = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a21' as DwarfId
const DAIN = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a22' as DwarfId
const THRAIN = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a23' as DwarfId
const NALI = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a24' as DwarfId
const ORI = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a25' as DwarfId

const LEFT: ValleLayouts = {
  control: {
    chatWidth: 520,
    split: false,
    foldedList: false,
    zones: { [MORIA]: { content: 'map' } }
  },
  front: {
    chatWidth: 610,
    split: true,
    foldedList: true,
    zone: { content: 'mine', mineId: EREBOR }
  }
}

describe('restoring Valle on open (ISSUE-300)', () => {
  it("[US-VALLE-001.AC08, S28.02] after leaving Valle or a restart each preset's chat width, split wish and folded list come back as left", () => {
    for (const preset of ['control', 'front'] as const) {
      const opened = restoreValleView({ preset, layout: LEFT })
      expect(opened).toEqual({ preset, page: null, layouts: LEFT })
    }
    // Leaving Valle changes nothing in the layouts it wrote: the same stores open the same view again.
    const before = restoreValleView({ preset: 'front', layout: LEFT })
    // AMENDED for ISSUE-301 (was: `{ enterableMine: true }`): machine 28's facts now name the mines, the mosaic, the
    // last mine worked in, the scroll and the chat in focus (07 S28.03, S28.06).
    const left = stepValle(
      before,
      { kind: 'leave', move: { mode: 'panel' } },
      {
        mines: [{ mineId: MORIA, enterable: true }],
        mosaic: [],
        lastMine: null,
        scrollLeft: 0,
        focus: null
      }
    )
    expect(left).toMatchObject({ ok: true, id: 'S28.21', view: before })
  })

  it('[US-VALLE-001.AC09, S29.02, S18.05, S32.02, INV-117] pins and the mosaic order come back in order; a pin whose dwarf ended meanwhile returns gone, and one whose dwarf row is gone is dropped', () => {
    const alive = new Set([BORIN, DAIN])
    const deleted = new Set([NALI])
    const mines = new Set([MORIA, EREBOR])
    const facts = {
      mineExists: (mineId: MineId) => mines.has(mineId),
      dwarf: (dwarfId: DwarfId) =>
        alive.has(dwarfId)
          ? ('alive' as const)
          : deleted.has(dwarfId)
            ? ('deleted' as const)
            : ('ended' as const)
    }
    // Stored out of their order: the order field wins.
    const pins = restorePins(
      [
        { dwarfId: DAIN, mineId: EREBOR, order: 3 },
        { dwarfId: NALI, mineId: MORIA, order: 1 },
        { dwarfId: THRAIN, mineId: MORIA, order: 2 },
        { dwarfId: ORI, mineId: LOST_MINE, order: 4 },
        { dwarfId: BORIN, mineId: MORIA, order: 0 }
      ],
      facts
    )
    expect(pins).toEqual([
      { dwarfId: BORIN, mineId: MORIA, state: 'live' },
      // Ended meanwhile: back, read-only, until the person closes it.
      { dwarfId: THRAIN, mineId: MORIA, state: 'gone' },
      { dwarfId: DAIN, mineId: EREBOR, state: 'live' }
      // NALI's row is gone and ORI's mine is gone: both dropped.
    ])
    // Never written: the start-up pins apply (S29.01), not an empty set.
    expect(restorePins(null, facts)).toBeNull()
    expect(restorePins([], facts)).toEqual([])

    // The mosaic order as arranged, a mine that no longer exists dropped (S32.02); `null` = the first mosaic applies.
    expect(restoreMosaicOrder([EREBOR, LOST_MINE, MORIA], facts.mineExists)).toEqual([
      EREBOR,
      MORIA
    ])
    expect(restoreMosaicOrder(null, facts.mineExists)).toBeNull()
    expect(restoreMosaicOrder([], facts.mineExists)).toEqual([])
  })

  it('[S28.01] with no stored preset Valle opens on the Control room', () => {
    // UI main answers the Control room for a preset never written, and no layout at all (useValleStores defaults).
    expect(restoreValleView({ preset: 'control', layout: null })).toEqual({
      preset: 'control',
      page: null,
      layouts: defaultValleLayouts()
    })
  })

  it('[S30.13] the persisted split wish is re-evaluated against the room and the pins when Valle opens', () => {
    expect(restoreSplit(false, { pins: 3, room: 900 })).toBe('off')
    expect(restoreSplit(true, { pins: 2, room: 640 })).toBe('on')
    expect(restoreSplit(true, { pins: 2, room: 639 })).toBe('suspended')
    // Fewer than two pins: no second pane to show (S30.10).
    expect(restoreSplit(true, { pins: 1, room: 900 })).toBe('off')
  })
})
