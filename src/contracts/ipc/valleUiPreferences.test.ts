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
    for (const [key, value] of Object.entries(VALLE_ANSWER)) {
      expect(uiPreferenceWriteSchema.safeParse({ key, value }).success, key).toBe(false)
    }
  })
})
