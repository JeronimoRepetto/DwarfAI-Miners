import { describe, expect, it } from 'vitest'
import { defaultValleLayouts, VALLE_CHAT_WIDTH_UNSET, type ValleLayouts } from './preset'
import {
  effectiveWidth,
  shownWidth,
  splitterDefault,
  splitterRange,
  SPLITTER_REST,
  stepSplitter,
  withChatWidth,
  type SplitterEffect,
  type SplitterFacts,
  type SplitterGeometry,
  type SplitterInput,
  type SplitterSet
} from './splitter'

/*
 * 07 machine 33 `SplitterState` (ISSUE-305; US-VALLE-005; UC-057; ADR-024 items 1, 4): the 12 px bar between the mines
 * and the chats sets the chat zone's width per preset. A drag follows the pointer, clamped; the release saves it for
 * the preset shown (A-N21 `valleLayout[preset].chatWidth`); ← / → move it 16 px and Home / End jump to the ends, each
 * committed at once; Enter or a double click resets that preset alone. The widths below are the body's content width
 * (Valle's width less its 6 px padding each side), as the body's observer reports it.
 * TC-305-01: dragged, keyed or reset, the width stays inside the preset's range and commits for that preset only.
 * TC-305-02: a resize, a fold, a split or a roster change moves the range; the effective width re-clamps and a stored
 * width is kept until the next commit.
 */

/** A 1440 px Valle: 1428 px of body (`DS/docs/screens/valle.md` Layout, the worked example). */
const WIDE = 1428

/** The body's geometry: four portraits on the Work front's mine (its minimum 320 px), the list unfolded, no split. */
function geometry(overrides: Partial<SplitterGeometry> = {}): SplitterGeometry {
  return { body: WIDE, foldedList: false, portraits: 4, split: false, ...overrides }
}

function facts(
  preset: SplitterFacts['preset'],
  stored: number = VALLE_CHAT_WIDTH_UNSET,
  at: Partial<SplitterGeometry> = {}
): SplitterFacts {
  return { preset, stored, geometry: geometry(at) }
}

/** Steps one input, which must be taken. */
function take(
  set: SplitterSet,
  input: SplitterInput,
  at: SplitterFacts
): { id: string; set: SplitterSet; effects: readonly SplitterEffect[] } {
  const step = stepSplitter(set, input, at)
  expect(step.ok, `refused: ${JSON.stringify(input)}`).toBe(true)
  return step as { id: string; set: SplitterSet; effects: readonly SplitterEffect[] }
}

/** A drag pressed at x = 1000 on the splitter. */
function pressed(at: SplitterFacts): SplitterSet {
  return take(SPLITTER_REST, { kind: 'press', x: 1000 }, at).set
}

describe('machine 33 diagram conformance', () => {
  it('[US-VALLE-005.AC01, S33.01] a drag moves the width with the pointer, with no easing, clamped to the range', () => {
    const at = facts('control')
    const press = take(SPLITTER_REST, { kind: 'press', x: 1000 }, at)
    expect(press.id).toBe('S33.01')
    expect(press.set.state).toBe('dragging')
    expect(shownWidth(press.set, at)).toBe(440)

    // The chat zone sits after the bar: dragging left widens it. Each move lands at once, nothing in between.
    const rows: readonly [x: number, width: number][] = [
      [1000, 440],
      [900, 540],
      [1084, 356],
      [1100, 340], // the minimum
      [1101, 340],
      [1600, 340],
      [346, 1094], // the maximum: 1428 − 56 − 12 − 3 × 6 − 248
      [345, 1094],
      [0, 1094]
    ]
    for (const [x, width] of rows) {
      const move = take(press.set, { kind: 'move', x }, at)
      expect(move.id, `x ${x}`).toBe('S33.01')
      expect(shownWidth(move.set, at), `x ${x}`).toBe(width)
      expect(move.effects, 'a move commits nothing').toEqual([])
    }
  })

  it('[US-VALLE-005.AC02, S33.02, S33.03] a release saves the width for this preset; a cancel returns to the width at the press', () => {
    const at = facts('front', 600)
    const moved = take(pressed(at), { kind: 'move', x: 900 }, at).set
    expect(shownWidth(moved, at)).toBe(700)

    const release = take(moved, { kind: 'release' }, at)
    expect(release.id).toBe('S33.02')
    expect(release.set.state).toBe('rest')
    expect(release.effects).toEqual([{ kind: 'commit', preset: 'front', chatWidth: 700 }])

    const cancel = take(moved, { kind: 'cancel' }, at)
    expect(cancel.id).toBe('S33.03')
    expect(cancel.set.state).toBe('rest')
    expect(cancel.effects).toEqual([])
    expect(shownWidth(cancel.set, at)).toBe(600)
  })

  it('[US-VALLE-005.AC03, S33.04] ← or → change the width by 16 px and commit at once', () => {
    const rows: readonly [stored: number, key: 'ArrowLeft' | 'ArrowRight', width: number][] = [
      [440, 'ArrowLeft', 456],
      [440, 'ArrowRight', 424],
      [1090, 'ArrowLeft', 1094], // clamped at the maximum
      [350, 'ArrowRight', 340] // clamped at the minimum
    ]
    for (const [stored, key, width] of rows) {
      const step = take(SPLITTER_REST, { kind: 'key', key }, facts('control', stored))
      expect(step.id, `${key} from ${stored}`).toBe('S33.04')
      expect(step.set.state).toBe('rest')
      expect(step.effects).toEqual([{ kind: 'commit', preset: 'control', chatWidth: width }])
    }
  })

  it('[US-VALLE-005.AC04, S33.05] Home or End jump to the minimum or maximum and commit', () => {
    const at = facts('front', 600)
    const home = take(SPLITTER_REST, { kind: 'key', key: 'Home' }, at)
    expect(home.id).toBe('S33.05')
    expect(home.effects).toEqual([{ kind: 'commit', preset: 'front', chatWidth: 340 }])
    const end = take(SPLITTER_REST, { kind: 'key', key: 'End' }, at)
    expect(end.id).toBe('S33.05')
    expect(end.effects).toEqual([{ kind: 'commit', preset: 'front', chatWidth: 784 }])
  })

  it('[US-VALLE-005.AC06] the Control room ranges from 340 px to what leaves 248 px for the mines, default 440 px', () => {
    const rows: readonly [body: number, min: number, max: number][] = [
      [WIDE, 340, 1094],
      [675, 340, 341],
      [674, 340, 340], // the boundary: the mines keep 248 px beside a 340 px chat zone
      [1914, 340, 1580]
    ]
    for (const [body, min, max] of rows) {
      expect(splitterRange('control', geometry({ body })), `body ${body}`).toEqual({ min, max })
      expect(splitterDefault('control', geometry({ body })), `body ${body}`).toBe(440)
    }
    // The roster, the list and the split are the Work front's: they never move the Control room's range.
    expect(
      splitterRange('control', geometry({ portraits: 0, foldedList: true, split: true }))
    ).toEqual({ min: 340, max: 1094 })
    expect(effectiveWidth(facts('control'))).toBe(440)
    // Before the body is measured, the design's 900 px stands in for the maximum.
    expect(splitterRange('control', geometry({ body: null }))).toEqual({ min: 340, max: 900 })
  })

  it("[US-VALLE-005.AC07, US-VALLE-001.AC06, S33.08] the Work front ranges from 340 px, or 640 px with a split, to what leaves the mine its minimum, and a folded list's freed width goes to the chat zone", () => {
    // body − nav 56 − splitter 12 − 3 × 6 − list (232, or 44 folded) − 6 − the mine's minimum.
    const rows: readonly [
      at: Partial<SplitterGeometry>,
      min: number,
      max: number,
      byDefault: number
    ][] = [
      [{}, 340, 784, 704], // the worked example: 704 px of chat
      [{ foldedList: true }, 340, 972, 892],
      [{ split: true }, 640, 784, 704],
      [{ portraits: 0 }, 340, 804, 704], // the mine's minimum floors at 300 px
      [{ portraits: 9 }, 340, 736, 704], // portraits counted up to 5: 16 + 5 × 48 + 112 = 368 px
      [{ body: 985 }, 340, 341, 340],
      [{ body: 984 }, 340, 340, 340], // the boundary: 340 px beside the mine at its minimum
      [{ body: 1284, split: true }, 640, 640, 640] // the split's own boundary (machine 30's 640 px)
    ]
    for (const [at, min, max, byDefault] of rows) {
      const label = JSON.stringify(at)
      expect(splitterRange('front', geometry(at)), label).toEqual({ min, max })
      expect(effectiveWidth(facts('front', VALLE_CHAT_WIDTH_UNSET, at)), label).toBe(byDefault)
    }
    // The default leaves the mine max(its minimum, 400 px).
    expect(splitterDefault('front', geometry())).toBe(704)
    expect(splitterDefault('front', geometry({ foldedList: true })) - 704).toBe(232 - 44)

    // A fold, a split, a resize or a roster change re-clamps the effective width; the stored width is kept.
    const stored = 900
    expect(effectiveWidth(facts('front', stored))).toBe(784)
    expect(effectiveWidth(facts('front', stored, { foldedList: true }))).toBe(900)
    expect(effectiveWidth(facts('front', 500, { split: true }))).toBe(640)
    expect(effectiveWidth(facts('front', 500))).toBe(500)
    const reflow = take(SPLITTER_REST, { kind: 'reflow' }, facts('front', stored))
    expect(reflow.id).toBe('S33.08')
    expect(reflow.set).toEqual(SPLITTER_REST)
    expect(reflow.effects, 'a moving range never writes the stored width').toEqual([])
  })

  it("[US-VALLE-005.AC09, S33.06, S33.09] a reset restores this preset's default and leaves the other preset's width untouched", () => {
    const layouts: ValleLayouts = {
      control: { ...defaultValleLayouts().control, chatWidth: 520 },
      front: { ...defaultValleLayouts().front, chatWidth: 610 }
    }
    for (const key of ['Enter', 'double-click'] as const) {
      const input: SplitterInput =
        key === 'Enter' ? { kind: 'key', key: 'Enter' } : { kind: 'double-click' }
      const reset = take(SPLITTER_REST, input, facts('front', 610))
      expect(reset.id, key).toBe('S33.06')
      expect(reset.set.state).toBe('resetting')
      // The stored value cleared: the default applies.
      expect(reset.effects).toEqual([
        { kind: 'flip' },
        { kind: 'commit', preset: 'front', chatWidth: VALLE_CHAT_WIDTH_UNSET }
      ])
      const settled = take(reset.set, { kind: 'settled' }, facts('front', VALLE_CHAT_WIDTH_UNSET))
      expect(settled.id).toBe('S33.07')
      expect(settled.set).toEqual(SPLITTER_REST)
    }

    const written = withChatWidth(layouts, 'front', VALLE_CHAT_WIDTH_UNSET)
    expect(written.front.chatWidth).toBe(VALLE_CHAT_WIDTH_UNSET)
    expect(written.front.split).toBe(layouts.front.split)
    expect(written.control, 'the Control room layout untouched').toBe(layouts.control)
    expect(effectiveWidth(facts('front', written.front.chatWidth))).toBe(704)
    expect(effectiveWidth(facts('control', written.control.chatWidth))).toBe(520)

    // A preset switch shows that preset's own width; the other one's stays as stored.
    const control = withChatWidth(layouts, 'control', 480)
    expect(control.front).toBe(layouts.front)
    expect(control.control.chatWidth).toBe(480)
    const preset = take(SPLITTER_REST, { kind: 'preset' }, facts('control', 480))
    expect(preset.id).toBe('S33.09')
    expect(preset.effects).toEqual([])
    expect(shownWidth(preset.set, facts('control', control.control.chatWidth))).toBe(480)
    expect(shownWidth(preset.set, facts('front', control.front.chatWidth))).toBe(610)
  })

  it("[S33.10, S33.12] a reset preset or Reset metrics gives the default; a body narrower than both minimums keeps the mine's minimum", () => {
    const after = facts('front', VALLE_CHAT_WIDTH_UNSET)
    const dragging = pressed(facts('front', 600))
    const resetting = take(SPLITTER_REST, { kind: 'double-click' }, facts('front', 600)).set
    for (const set of [SPLITTER_REST, dragging, resetting]) {
      const step = take(set, { kind: 'reset' }, after)
      expect(step.id, set.state).toBe('S33.10')
      expect(step.set).toEqual(SPLITTER_REST)
      expect(step.effects).toEqual([])
      expect(shownWidth(step.set, after)).toBe(704)
    }

    // The mine's minimum wins: the chat zone takes what is left beside it, its own floor giving way.
    expect(splitterRange('front', geometry({ body: 900 }))).toEqual({ min: 256, max: 256 })
    expect(effectiveWidth(facts('front', 600, { body: 900 }))).toBe(256)
    expect(splitterRange('front', geometry({ body: 1100, split: true }))).toEqual({
      min: 456,
      max: 456
    })
    expect(splitterRange('control', geometry({ body: 600 }))).toEqual({ min: 266, max: 266 })
    expect(effectiveWidth(facts('control', 440, { body: 600 }))).toBe(266)
    expect(splitterRange('control', geometry({ body: 200 }))).toEqual({ min: 0, max: 0 })
  })

  it('[ADR-024] a transition not listed in 07 machine 33 is rejected', () => {
    const at = facts('control', 500)
    const dragging = pressed(at)
    const resetting = take(SPLITTER_REST, { kind: 'key', key: 'Enter' }, at).set
    const refused: readonly [SplitterSet, SplitterInput][] = [
      [SPLITTER_REST, { kind: 'move', x: 10 }],
      [SPLITTER_REST, { kind: 'release' }],
      [SPLITTER_REST, { kind: 'cancel' }],
      [SPLITTER_REST, { kind: 'settled' }],
      [dragging, { kind: 'press', x: 10 }],
      [dragging, { kind: 'key', key: 'ArrowLeft' }],
      [dragging, { kind: 'double-click' }],
      [dragging, { kind: 'reflow' }],
      [dragging, { kind: 'preset' }],
      [resetting, { kind: 'press', x: 10 }],
      [resetting, { kind: 'key', key: 'End' }],
      [resetting, { kind: 'reflow' }]
    ]
    for (const [set, input] of refused) {
      expect(stepSplitter(set, input, at), `${set.state} + ${JSON.stringify(input)}`).toEqual({
        ok: false,
        reason: 'not-listed'
      })
    }
  })
})
