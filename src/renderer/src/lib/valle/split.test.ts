import { describe, expect, it } from 'vitest'
import { BORIN, DAIN, FLOI, NALI } from '../veta/testing/vetaFixtures'
import { addKey, type PinKey } from './pins'
import {
  SPLIT_OFF,
  controlMinimum,
  mineMinimum,
  restoredSplit,
  splitButton,
  splitPanes,
  splitRoom,
  stepSplit,
  type SplitEffect,
  type SplitFacts,
  type SplitInput,
  type SplitSet
} from './split'

/*
 * 07 machine 30 `SplitState` (ISSUE-303; US-VALLE-008; UC-056; ADR-024 items 1, 4): "⫽" shows two pinned chats side
 * by side, never more; below 640 px of room beside the mine the split steps back to the focused pane and comes back by
 * itself. Each step names the 07 transition taken and the effects the window carries out: the wish written with the
 * Work front layout (A-N21 `valleLayout.front.split`) and the second pane's chat in the session (A-N18).
 * TC-303-01: pins, room and presses follow machine 30, at most two panes, the wish persisted through A-N21.
 */

const MINE = '01920000-0000-7000-8000-00000000a001'
const ADD = addKey(MINE as never)

/** The facts machine 30 reads: the pins in tab order (`needing` need the person), the focused pin, the room. */
function facts(
  focus: PinKey | null,
  options: { room?: number; needing?: readonly PinKey[]; pins?: readonly PinKey[] } = {}
): SplitFacts {
  const pins = options.pins ?? [BORIN, DAIN, NALI, FLOI]
  return {
    pins: pins.map((key) => ({
      key,
      dwarfId: key.startsWith('add:') ? null : (key as never),
      needs: (options.needing ?? []).includes(key)
    })),
    focus,
    room: options.room ?? 900
  }
}

/** Steps one input, which must be taken. */
function take(
  set: SplitSet,
  input: SplitInput,
  at: SplitFacts
): { id: string; set: SplitSet; effects: readonly SplitEffect[] } {
  const step = stepSplit(set, input, at)
  if (!step.ok) throw new Error(`refused: ${JSON.stringify(input)}`)
  return step
}

/** A split on, `first` focused in the first pane, `second` beside it. */
function on(first: PinKey, second: PinKey, at: SplitFacts = facts(first)): SplitSet {
  const step = take(SPLIT_OFF, { kind: 'press' }, { ...at, focus: first })
  const set: SplitSet = { ...step.set, panes: [first, second] }
  return set
}

describe('machine 30 diagram conformance', () => {
  it('[US-VALLE-008.AC01, S30.01] with two pins and room ⫽ opens a second pane holding a needing pin, else the next pin, the first pane keeping the focused chat', () => {
    // FLOI needs the person: it takes the second pane over BORIN, the first other pin in tab order.
    const needing = take(SPLIT_OFF, { kind: 'press' }, facts(DAIN, { needing: [FLOI] }))
    expect(needing.id).toBe('S30.01')
    expect(needing.set.state).toBe('on')
    expect(splitPanes(needing.set, DAIN)).toEqual([DAIN, FLOI])
    expect(needing.effects).toEqual([
      { kind: 'write-wish', split: true },
      { kind: 'session', patch: { secondPaneDwarfId: FLOI } }
    ])
    // The focused chat itself needing the person does not count: it already holds the first pane.
    const self = take(SPLIT_OFF, { kind: 'press' }, facts(DAIN, { needing: [DAIN] }))
    expect(splitPanes(self.set, DAIN)).toEqual([DAIN, BORIN])
    // Nobody else needs the person: the first other pin in tab order.
    const plain = take(SPLIT_OFF, { kind: 'press' }, facts(NALI))
    expect(splitPanes(plain.set, NALI)).toEqual([NALI, BORIN])
    // An Add panel is a pin too (07 §22.4 V-11); the session holds a dwarf's id only.
    const add = take(SPLIT_OFF, { kind: 'press' }, facts(BORIN, { pins: [BORIN, ADD] }))
    expect(splitPanes(add.set, BORIN)).toEqual([BORIN, ADD])
    expect(add.effects).toContainEqual({ kind: 'session', patch: { secondPaneDwarfId: null } })
  })

  it("[US-VALLE-008.AC02, S30.02] ⫽ again turns the split off and keeps the first pane's chat", () => {
    const off = take(on(DAIN, FLOI), { kind: 'press' }, facts(DAIN))
    expect(off.id).toBe('S30.02')
    expect(off.set.state).toBe('off')
    expect(splitPanes(off.set, DAIN)).toEqual([DAIN])
    expect(off.effects).toEqual([
      { kind: 'write-wish', split: false },
      { kind: 'session', patch: { secondPaneDwarfId: null } }
    ])
  })

  it('[US-VALLE-008.AC03, S30.07] a dive or a list pick with the split on moves the first pane to the new chat and keeps the previous one in the second pane if still pinned, else the next tab', () => {
    // BORIN showed in the first pane; the dive's new order puts NALI first and selects it.
    const kept = take(
      on(BORIN, DAIN),
      { kind: 'follow', before: BORIN },
      facts(NALI, { pins: [NALI, BORIN, DAIN, FLOI] })
    )
    expect(kept.id).toBe('S30.07')
    expect(splitPanes(kept.set, NALI)).toEqual([NALI, BORIN])
    expect(kept.effects).toEqual([{ kind: 'session', patch: { secondPaneDwarfId: BORIN } }])
    // BORIN is no longer pinned: the next tab in the new order after the new chat takes the second pane.
    const next = take(
      on(BORIN, DAIN),
      { kind: 'follow', before: BORIN },
      facts(NALI, { pins: [FLOI, NALI, DAIN] })
    )
    expect(splitPanes(next.set, NALI)).toEqual([NALI, DAIN])
    // With focus in the second pane, the first pane's chat is the one kept; focus returns to the first pane.
    const fromSecond = take(on(BORIN, DAIN), { kind: 'focused' }, facts(DAIN))
    const dived = take(
      fromSecond.set,
      { kind: 'follow', before: BORIN },
      facts(NALI, { pins: [NALI, DAIN, BORIN] })
    )
    expect(dived.set.pane).toBe(0)
    expect(splitPanes(dived.set, NALI)).toEqual([NALI, BORIN])
  })

  it('[US-VALLE-008.AC04, S30.05] room below 640 px suspends the split to the focused pane and disables ⫽ titled Split · needs a wider window', () => {
    const split = on(DAIN, FLOI)
    // 640 px is enough: nothing changes.
    expect(stepSplit(split, { kind: 'resize' }, facts(DAIN, { room: 640 })).ok).toBe(false)
    const narrowed = take(split, { kind: 'resize' }, facts(DAIN, { room: 639 }))
    expect(narrowed.id).toBe('S30.05')
    expect(narrowed.set.state).toBe('suspended')
    expect(splitPanes(narrowed.set, DAIN)).toEqual([DAIN])
    // The wish stays on, the second pane's chat stays in the session: nothing is written.
    expect(narrowed.effects).toEqual([])
    expect(splitButton(narrowed.set, facts(DAIN, { room: 639 }))).toEqual({
      disabled: true,
      pressed: true,
      title: 'Split · needs a wider window'
    })
  })

  it('[US-VALLE-008.AC05, S30.06] room back above 640 px restores the split with the same second chat, with no press', () => {
    const suspended = take(on(DAIN, FLOI), { kind: 'resize' }, facts(DAIN, { room: 639 })).set
    // Still too narrow: nothing changes.
    expect(stepSplit(suspended, { kind: 'resize' }, facts(DAIN, { room: 639 })).ok).toBe(false)
    const back = take(suspended, { kind: 'resize' }, facts(DAIN, { room: 640 }))
    expect(back.id).toBe('S30.06')
    expect(back.set.state).toBe('on')
    expect(splitPanes(back.set, DAIN)).toEqual([DAIN, FLOI])
    expect(back.effects).toEqual([])
    expect(splitButton(back.set, facts(DAIN, { room: 640 }))).toEqual({
      disabled: false,
      pressed: true,
      title: 'Split · two chats side by side'
    })
    // The chat it held was unpinned meanwhile: the next tab after the focused one.
    const unpinned = take(
      suspended,
      { kind: 'resize' },
      facts(DAIN, { room: 700, pins: [BORIN, DAIN, NALI] })
    )
    expect(splitPanes(unpinned.set, DAIN)).toEqual([DAIN, NALI])
    expect(unpinned.effects).toEqual([{ kind: 'session', patch: { secondPaneDwarfId: NALI } }])
  })

  it('[US-VALLE-008.AC06, S30.03, S30.04] with fewer than two pins ⫽ stays disabled titled Split · two chats side by side', () => {
    for (const pins of [[BORIN], []] as PinKey[][]) {
      const at = facts(pins[0] ?? null, { pins })
      const pressed = take(SPLIT_OFF, { kind: 'press' }, at)
      expect(pressed.id, `${pins.length} pins`).toBe('S30.03')
      expect(pressed.set).toEqual(SPLIT_OFF)
      expect(pressed.effects).toEqual([])
      expect(splitButton(SPLIT_OFF, at)).toEqual({
        disabled: true,
        pressed: false,
        title: 'Split · two chats side by side'
      })
    }
    // Fewer than two pins wins the title even when the room is short too.
    expect(splitButton(SPLIT_OFF, facts(BORIN, { pins: [BORIN], room: 100 })).title).toBe(
      'Split · two chats side by side'
    )
    // S30.04: two pins but no room: nothing, titled for the room.
    const narrow = facts(BORIN, { room: 639 })
    const refused = take(SPLIT_OFF, { kind: 'press' }, narrow)
    expect(refused.id).toBe('S30.04')
    expect(refused.set).toEqual(SPLIT_OFF)
    expect(refused.effects).toEqual([])
    expect(splitButton(SPLIT_OFF, narrow)).toEqual({
      disabled: true,
      pressed: false,
      title: 'Split · needs a wider window'
    })
    expect(splitButton(SPLIT_OFF, facts(BORIN, { room: 640 }))).toEqual({
      disabled: false,
      pressed: false,
      title: 'Split · two chats side by side'
    })
  })

  it('[US-VALLE-008.AC08] a split never shows more than two panes', () => {
    let set = on(BORIN, DAIN)
    let focus: PinKey = BORIN
    // Every tab selected in turn, the other pane clicked, a dive: two panes throughout, never the same chat twice.
    const inputs: [SplitInput, PinKey][] = [
      [{ kind: 'focused' }, NALI],
      [{ kind: 'focused' }, FLOI],
      [{ kind: 'focused' }, DAIN],
      [{ kind: 'focused' }, BORIN],
      [{ kind: 'follow', before: BORIN }, NALI]
    ]
    for (const [input, next] of inputs) {
      const step = take(set, input, facts(next))
      set = step.set
      focus = next
      const panes = splitPanes(set, focus)
      expect(panes, JSON.stringify(input)).toHaveLength(2)
      expect(new Set(panes).size).toBe(2)
      expect(set.panes).toHaveLength(2)
    }
    // ⫽ while on turns it off; it never adds a pane.
    expect(splitPanes(take(set, { kind: 'press' }, facts(focus)).set, focus)).toHaveLength(1)
  })

  it('[US-VALLE-008.AC07, S30.09] a click in the other pane moves focus there and keeps both chats where they are', () => {
    const moved = take(on(BORIN, DAIN), { kind: 'focused' }, facts(DAIN))
    expect(moved.id).toBe('S30.09')
    expect(moved.set.pane).toBe(1)
    expect(splitPanes(moved.set, DAIN)).toEqual([BORIN, DAIN])
    expect(moved.effects).toEqual([])
    const back = take(moved.set, { kind: 'focused' }, facts(BORIN))
    expect(back.id).toBe('S30.09')
    expect(back.set.pane).toBe(0)
  })

  it('[S30.08, S30.10, S30.11, S30.12, S30.13] a tab replaces the focused pane; losing the second pin refills or turns off; Reset preset, Reset metrics and a restart follow 07 machine 30', () => {
    // S30.08: a tab not shown replaces the focused pane, whichever pane holds focus.
    const first = take(on(BORIN, DAIN), { kind: 'focused' }, facts(NALI))
    expect(first.id).toBe('S30.08')
    expect(splitPanes(first.set, NALI)).toEqual([NALI, DAIN])
    expect(first.effects).toEqual([])
    const inSecond = take(on(BORIN, DAIN), { kind: 'focused' }, facts(DAIN)).set
    const second = take(inSecond, { kind: 'focused' }, facts(NALI))
    expect(second.id).toBe('S30.08')
    expect(splitPanes(second.set, NALI)).toEqual([BORIN, NALI])
    expect(second.effects).toEqual([{ kind: 'session', patch: { secondPaneDwarfId: NALI } }])

    // S30.10: the second pane's pin unpinned with two or more left: the next tab after the focused one.
    const refilled = take(
      on(BORIN, DAIN),
      { kind: 'pins' },
      facts(BORIN, { pins: [BORIN, NALI, FLOI] })
    )
    expect(refilled.id).toBe('S30.10')
    expect(splitPanes(refilled.set, BORIN)).toEqual([BORIN, NALI])
    expect(refilled.effects).toEqual([{ kind: 'session', patch: { secondPaneDwarfId: NALI } }])
    // The focused pane's pin unpinned, focus moved onto the other pane's chat: the focused pane keeps it, refilled.
    const focusLost = take(on(BORIN, DAIN), { kind: 'pins' }, facts(DAIN, { pins: [DAIN, NALI] }))
    expect(focusLost.id).toBe('S30.10')
    expect(splitPanes(focusLost.set, DAIN)).toEqual([DAIN, NALI])
    // Fewer than two left: off, the wish written off (07 §24 I-30), never `suspended`.
    const alone = take(on(BORIN, DAIN), { kind: 'pins' }, facts(BORIN, { pins: [BORIN] }))
    expect(alone.id).toBe('S30.10')
    expect(alone.set).toEqual(SPLIT_OFF)
    expect(alone.effects).toEqual([
      { kind: 'write-wish', split: false },
      { kind: 'session', patch: { secondPaneDwarfId: null } }
    ])
    // Both panes still pinned: not machine 30's.
    expect(stepSplit(on(BORIN, DAIN), { kind: 'pins' }, facts(BORIN)).ok).toBe(false)

    // S30.11: Reset preset in the Work front, from `on` or `suspended`: off, the wish written off.
    const suspended = take(on(BORIN, DAIN), { kind: 'resize' }, facts(BORIN, { room: 500 })).set
    for (const from of [on(BORIN, DAIN), suspended]) {
      const reset = take(from, { kind: 'reset-preset' }, facts(BORIN))
      expect(reset.id).toBe('S30.11')
      expect(reset.set).toEqual(SPLIT_OFF)
      expect(reset.effects).toEqual([
        { kind: 'write-wish', split: false },
        { kind: 'session', patch: { secondPaneDwarfId: null } }
      ])
    }
    // S30.12: Reset metrics: off; UI main already returned the stores to their defaults, nothing is written back.
    const metrics = take(suspended, { kind: 'reset' }, facts(BORIN))
    expect(metrics.id).toBe('S30.12')
    expect(metrics.set).toEqual(SPLIT_OFF)
    expect(metrics.effects).toEqual([])

    // S30.13: the persisted wish re-evaluated against the room and the pins, the session's second pane kept if pinned.
    expect(restoredSplit(true, DAIN, facts(BORIN))).toEqual({
      state: 'on',
      panes: [BORIN, DAIN],
      pane: 0
    })
    expect(restoredSplit(true, null, facts(BORIN, { needing: [NALI] })).panes).toEqual([
      BORIN,
      NALI
    ])
    expect(restoredSplit(true, DAIN, facts(BORIN, { room: 600 }))).toEqual({
      state: 'suspended',
      panes: [BORIN, DAIN],
      pane: 0
    })
    expect(restoredSplit(true, DAIN, facts(BORIN, { pins: [BORIN] }))).toEqual(SPLIT_OFF)
    expect(restoredSplit(false, DAIN, facts(BORIN))).toEqual(SPLIT_OFF)
  })

  it('[ADR-024] a transition not listed in 07 machine 30 is rejected', () => {
    const suspended = take(on(BORIN, DAIN), { kind: 'resize' }, facts(BORIN, { room: 500 })).set
    const refused: [string, SplitSet, SplitInput, SplitFacts][] = [
      ['⫽ while suspended (disabled)', suspended, { kind: 'press' }, facts(BORIN, { room: 500 })],
      ['a tab while off (machine 29 alone)', SPLIT_OFF, { kind: 'focused' }, facts(DAIN)],
      ['a dive while off', SPLIT_OFF, { kind: 'follow', before: BORIN }, facts(DAIN)],
      ['a resize while off', SPLIT_OFF, { kind: 'resize' }, facts(BORIN, { room: 100 })],
      ['an unpin while off', SPLIT_OFF, { kind: 'pins' }, facts(BORIN, { pins: [BORIN] })],
      ['the focused pane focused again', on(BORIN, DAIN), { kind: 'focused' }, facts(BORIN)],
      ['Reset preset while off', SPLIT_OFF, { kind: 'reset-preset' }, facts(BORIN)]
    ]
    for (const [what, set, input, at] of refused) {
      expect(stepSplit(set, input, at), what).toEqual({ ok: false, reason: 'not-listed' })
    }
  })

  it("[S30.01] the room formula uses the nav, splitter, gaps, list and the mine's minimum with at most five portraits", () => {
    // body − nav 56 − splitter 12 − 3 × 6 − list − 6 − max(300, 16 + 48 × portraits (≤ 5) + 112)
    const table: [number, boolean, number, number][] = [
      [1600, false, 0, 1600 - 56 - 12 - 18 - 232 - 6 - 300],
      [1600, false, 3, 1600 - 56 - 12 - 18 - 232 - 6 - 300],
      [1600, false, 4, 1600 - 56 - 12 - 18 - 232 - 6 - 320],
      [1600, false, 5, 1600 - 56 - 12 - 18 - 232 - 6 - 368],
      [1600, false, 9, 1600 - 56 - 12 - 18 - 232 - 6 - 368],
      [1600, true, 5, 1600 - 56 - 12 - 18 - 44 - 6 - 368]
    ]
    for (const [body, foldedList, portraits, room] of table) {
      expect(splitRoom({ body, foldedList, portraits }), `${portraits} ${foldedList}`).toBe(room)
    }
  })
})

// APPENDED for the zones' plates (EPIC-20 package gap): a zone is never narrower than its roster
// (`DS/docs/screens/valle.md` Layout, VA3; `organisms/mine-zone` `mineZoneMin`).
describe("a mine zone's minimum width", () => {
  it('a Control room column keeps 232 px, or its roster (16 px of plate, 48 px a portrait up to five, 48 px of tools) when wider', () => {
    const table: readonly [portraits: number, control: number, front: number][] = [
      [0, 232, 300],
      [1, 232, 300],
      [3, 232, 300],
      [4, 256, 320],
      [5, 304, 368],
      [9, 304, 368]
    ]
    for (const [portraits, control, front] of table) {
      expect(controlMinimum(portraits), `${portraits}`).toBe(control)
      expect(mineMinimum(portraits), `${portraits}`).toBe(front)
    }
  })
})
