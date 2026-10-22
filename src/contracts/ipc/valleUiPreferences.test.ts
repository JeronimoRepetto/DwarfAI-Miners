import { describe, expect, it } from 'vitest'
import {
  VALLE_BOUNDS,
  VALLE_ON_SCREEN_RATIO,
  uiPreferencesAnswerSchema,
  uiPreferenceWriteSchema
} from './windowApi'

/**
 * The Valle half of 14 §3.9 (ISSUE-299; ADR-024 items 1, 4, 6, 7): the two named Valle constants, and the six persisted
 * Valle keys A-N20 answers, each in its 14 §3.9 shape. None is renderer-writable yet: each becomes writable (A-N21) in
 * the issue that first writes it (ISSUE-300…ISSUE-310).
 */
const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02'
const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01'

const VALLE_ANSWER = {
  vallePreset: 'front',
  valleLayout: {
    control: {
      chatWidth: 380,
      split: false,
      foldedList: false,
      zones: { [MINE]: { content: 'map' } }
    },
    front: {
      chatWidth: 420,
      split: true,
      foldedList: true,
      zone: { content: 'mine', mineId: MINE }
    }
  },
  valleLastFrontMineId: MINE,
  valleMosaicOrder: [MINE],
  pins: [{ dwarfId: DWARF, mineId: MINE, order: 0 }],
  mutedMineIds: [MINE]
}

describe('the Valle preferences of 14 §3.9 (ISSUE-299)', () => {
  it('[S39.01, S39.05, ADR-024] the Valle constants are the 14 §3.9 values: half the viewport, and the work area', () => {
    expect(VALLE_ON_SCREEN_RATIO).toBe(0.5)
    expect(VALLE_BOUNDS).toBe('work-area')
  })

  it('[S39.03, ADR-024] A-N20 answers the six Valle keys in their 14 §3.9 shapes, never-written values included, and nothing else', () => {
    expect(uiPreferencesAnswerSchema.safeParse(VALLE_ANSWER).success).toBe(true)
    // `null` = never written for the order, the pins and the last Work front mine; `[]` = emptied.
    expect(
      uiPreferencesAnswerSchema.safeParse({
        vallePreset: 'control',
        valleLastFrontMineId: null,
        valleMosaicOrder: null,
        pins: null,
        mutedMineIds: []
      }).success
    ).toBe(true)
    // Strict: an unknown preset, a field 14 §3.9 does not list, a zone content outside `ZoneContent`, a mine id that
    // is not one, or a list that may not be null is refused.
    for (const wrong of [
      { vallePreset: 'mosaic' },
      { pins: [{ dwarfId: DWARF, mineId: MINE, order: 0, kind: 'chat' }] },
      {
        valleLayout: {
          ...VALLE_ANSWER.valleLayout,
          front: { ...VALLE_ANSWER.valleLayout.front, zone: { content: 'lab' } }
        }
      },
      { valleMosaicOrder: ['not-a-mine-id'] },
      { mutedMineIds: null }
    ]) {
      expect(uiPreferencesAnswerSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false)
    }
  })

  it('[ADR-024] no Valle key is renderer-writable before the issue that first writes it', () => {
    // AMENDED for ISSUE-300 (was: every Valle key refused): the preset and the layouts are written from ISSUE-300 on
    // (asserted below). AMENDED for ISSUE-302 (was: `pins` refused too): the pins are written from ISSUE-302 on
    // (asserted below); the other three are still refused. AMENDED for ISSUE-301 (was: `valleLastFrontMineId` refused
    // too): the dive writes the last mine worked in from ISSUE-301 on (asserted below).
    const written = ['vallePreset', 'valleLayout', 'pins', 'valleLastFrontMineId']
    for (const [key, value] of Object.entries(VALLE_ANSWER).filter(([k]) => !written.includes(k))) {
      expect(uiPreferenceWriteSchema.safeParse({ key, value }).success, key).toBe(false)
    }
  })
})

// APPENDED for ISSUE-300: the Valle window writes the preset in use and each preset's layout (07 machine 28).
describe('the Valle preset and layouts written by the Valle window (ISSUE-300)', () => {
  it('[S28.16, S28.17, ADR-024] vallePreset and valleLayout are renderer-writable in their 14 §3.9 shapes, strictly; the other Valle keys are not yet', () => {
    expect(uiPreferenceWriteSchema.safeParse({ key: 'vallePreset', value: 'front' }).success).toBe(
      true
    )
    expect(
      uiPreferenceWriteSchema.safeParse({ key: 'valleLayout', value: VALLE_ANSWER.valleLayout })
        .success
    ).toBe(true)
    for (const wrong of [
      { key: 'vallePreset', value: 'mosaic' },
      { key: 'valleLayout', value: null },
      {
        key: 'valleLayout',
        value: {
          ...VALLE_ANSWER.valleLayout,
          front: { ...VALLE_ANSWER.valleLayout.front, scrollLeft: 0 }
        }
      },
      { key: 'vallePreset', value: 'front', extra: true }
    ]) {
      expect(uiPreferenceWriteSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false)
    }
    // AMENDED for ISSUE-302 (was: `pins` in this list): the pins are renderer-writable from ISSUE-302 on.
    // AMENDED for ISSUE-301 (was: `valleLastFrontMineId` in this list): written by the dive from ISSUE-301 on.
    for (const key of ['valleMosaicOrder', 'mutedMineIds']) {
      const value = VALLE_ANSWER[key as keyof typeof VALLE_ANSWER]
      expect(uiPreferenceWriteSchema.safeParse({ key, value }).success, key).toBe(false)
    }
  })
})

// APPENDED for ISSUE-301: the dive and a Work front swap write the last mine worked in (07 S28.03, S28.15; N-15).
describe('the last mine worked in written by the Valle window (ISSUE-301)', () => {
  it('[S28.03, S28.15, ADR-024] valleLastFrontMineId is renderer-writable as a mine id, strictly; never null, which only Reset metrics restores', () => {
    expect(
      uiPreferenceWriteSchema.safeParse({ key: 'valleLastFrontMineId', value: MINE }).success
    ).toBe(true)
    for (const wrong of [
      { key: 'valleLastFrontMineId', value: null },
      { key: 'valleLastFrontMineId', value: 'not-a-mine-id' },
      { key: 'valleLastFrontMineId', value: MINE, extra: true }
    ]) {
      expect(uiPreferenceWriteSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false)
    }
  })
})

// APPENDED for ISSUE-302: the Valle window writes the pins on every change (07 machine 29, S29.08, S29.10, TC-302-01).
describe('the Valle pins written by the Valle window (ISSUE-302)', () => {
  it('[S29.08, S29.10, INV-117, ADR-024] pins is renderer-writable in its 14 §3.9 shape, chat pins only and strictly; the other three Valle keys are not yet', () => {
    expect(
      uiPreferenceWriteSchema.safeParse({ key: 'pins', value: VALLE_ANSWER.pins }).success
    ).toBe(true)
    expect(uiPreferenceWriteSchema.safeParse({ key: 'pins', value: [] }).success).toBe(true)
    for (const wrong of [
      // `null` is "never written": only Reset metrics returns the store to it (S29.20), never a renderer.
      { key: 'pins', value: null },
      // An Add pin has no dwarf: it is the session's (`valle.addPins`), never `pins` (R5B-27).
      { key: 'pins', value: [{ mineId: MINE, order: 0 }] },
      { key: 'pins', value: [{ dwarfId: DWARF, mineId: MINE, order: 0, focused: true }] },
      { key: 'pins', value: [{ dwarfId: DWARF, mineId: MINE, order: -1 }] },
      { key: 'pins', value: VALLE_ANSWER.pins, extra: true }
    ]) {
      expect(uiPreferenceWriteSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false)
    }
    // AMENDED for ISSUE-301 (was: `valleLastFrontMineId` in this list): written by the dive from ISSUE-301 on.
    for (const key of ['valleMosaicOrder', 'mutedMineIds']) {
      const value = VALLE_ANSWER[key as keyof typeof VALLE_ANSWER]
      expect(uiPreferenceWriteSchema.safeParse({ key, value }).success, key).toBe(false)
    }
  })
})

// APPENDED for ISSUE-301: the dive and a Work front swap write the last mine worked in (07 S28.03, S28.15; N-15).
describe('the last mine worked in written by the Valle window (ISSUE-301)', () => {
  it('[S28.03, S28.15, ADR-024] valleLastFrontMineId is renderer-writable as a mine id, strictly; never null, which only Reset metrics restores', () => {
    expect(
      uiPreferenceWriteSchema.safeParse({ key: 'valleLastFrontMineId', value: MINE }).success
    ).toBe(true)
    for (const wrong of [
      { key: 'valleLastFrontMineId', value: null },
      { key: 'valleLastFrontMineId', value: 'not-a-mine-id' },
      { key: 'valleLastFrontMineId', value: MINE, extra: true }
    ]) {
      expect(uiPreferenceWriteSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false)
    }
  })
})
