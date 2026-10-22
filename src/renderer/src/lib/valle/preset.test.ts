// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ValleTopBar from '../../components/valle/ValleTopBar.vue'
import {
  defaultValleLayouts,
  stepValle,
  valleChatWidth,
  valleListWidth,
  VALLE_CONTROL_CHAT_WIDTH,
  VALLE_LIST_FOLDED_WIDTH,
  VALLE_LIST_WIDTH,
  type ValleEffect,
  type ValleFacts,
  type ValleInput,
  type ValleLayouts,
  type ValleView
} from './preset'
import { restoreValleView } from './restore'

/*
 * 07 machine 28 (ISSUE-300; US-VALLE-001; 17 §1.1 diagram-conformance walk): the preset switch, the Work front's folded
 * list, a nav page over the main zone, a resize, Reset metrics and a crash, each an edge of the machine; an input the
 * machine does not list is refused. The dive and climb motion between the presets is ISSUE-301's.
 */

const ENTERABLE: ValleFacts = { enterableMine: true }

const view = (over: Partial<ValleView> = {}): ValleView => ({
  preset: 'control',
  page: null,
  layouts: defaultValleLayouts(),
  ...over
})

/** Steps each input in turn, refusing none; answers the last view and every effect. */
function walk(
  start: ValleView,
  inputs: readonly ValleInput[],
  facts: ValleFacts = ENTERABLE
): { view: ValleView; ids: string[]; effects: ValleEffect[] } {
  let at = start
  const ids: string[] = []
  const effects: ValleEffect[] = []
  for (const input of inputs) {
    const step = stepValle(at, input, facts)
    expect(step.ok, JSON.stringify(input)).toBe(true)
    if (!step.ok) break
    at = step.view
    ids.push(step.id)
    effects.push(...step.effects)
  }
  return { view: at, ids, effects }
}

const CHANGED: ValleLayouts = {
  control: { chatWidth: 520, split: false, foldedList: false, zones: {} },
  front: { chatWidth: 610, split: true, foldedList: false, zone: { content: 'mine' } }
}

describe('machine 28 diagram conformance (presets)', () => {
  it("[US-VALLE-001.AC01, S28.06, S28.11] the other preset's tab, or the matching arrow key on a focused tab, switches the preset and the top bar highlights it", async () => {
    const byTab = walk(view(), [{ kind: 'tab', preset: 'front' }])
    expect(byTab.ids).toEqual(['S28.06'])
    expect(byTab.view.preset).toBe('front')
    expect(walk(byTab.view, [{ kind: 'tab', preset: 'control' }]).ids).toEqual(['S28.11'])

    const byKey = walk(view(), [{ kind: 'arrow', key: 'ArrowRight' }])
    expect(byKey.ids).toEqual(['S28.06'])
    expect(byKey.view.preset).toBe('front')
    const back = walk(byKey.view, [{ kind: 'arrow', key: 'ArrowLeft' }])
    expect(back.ids).toEqual(['S28.11'])
    expect(back.view.preset).toBe('control')
    // Each switch is written at once (S28.26).
    expect(byTab.effects).toContainEqual({ kind: 'write-preset', preset: 'front' })
    expect(back.effects).toContainEqual({ kind: 'write-preset', preset: 'control' })
    // The Work front tab needs a mine to dive into (S28.06 guard).
    expect(stepValle(view(), { kind: 'tab', preset: 'front' }, { enterableMine: false })).toEqual({
      ok: false,
      reason: 'not-listed'
    })

    // The top bar highlights the preset shown.
    const bar = mount(ValleTopBar, { props: { preset: 'control', chat: null } })
    const selected = (): string[] =>
      bar.findAll('[role="tab"][aria-selected="true"]').map((tab) => tab.text())
    expect(selected()).toEqual(['Control room'])
    await bar.setProps({ preset: byTab.view.preset })
    expect(selected()).toEqual(['Work front'])
    // The bar hands the click and the arrow key on a focused tab to the machine above.
    await bar.get('[data-preset-tab="control"]').trigger('click')
    await bar.get('[data-preset-tab="front"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(bar.emitted('tab')).toEqual([['control']])
    expect(bar.emitted('arrow')).toEqual([['ArrowLeft']])
    bar.unmount()
  })

  it('[US-VALLE-001.AC02, S28.11] Esc on the Work front with no other layer open returns to the Control room', () => {
    const front = view({ preset: 'front' })
    const step = walk(front, [{ kind: 'escape', layerOpen: false }])
    expect(step.ids).toEqual(['S28.11'])
    expect(step.view.preset).toBe('control')
    // A layer open closes first: Esc does not leave the Work front (NFR-A11Y-02).
    expect(stepValle(front, { kind: 'escape', layerOpen: true }, ENTERABLE).ok).toBe(false)
  })

  it('[US-VALLE-001.AC03] a preset shows the exact layout it held, untouched by changes made in the other preset', () => {
    const start = view({ layouts: CHANGED })
    // Into the Work front, fold its list, back to the Control room: the Control room's layout is as it was.
    const there = walk(start, [{ kind: 'tab', preset: 'front' }, { kind: 'fold' }])
    expect(there.view.layouts.front).toEqual({ ...CHANGED.front, foldedList: true })
    const back = walk(there.view, [{ kind: 'tab', preset: 'control' }])
    expect(back.view.layouts.control).toEqual(CHANGED.control)
    // And the Work front, switched to again, shows exactly what it held.
    const again = walk(back.view, [{ kind: 'tab', preset: 'front' }])
    expect(again.view.layouts.front).toEqual({ ...CHANGED.front, foldedList: true })
    expect(again.view.layouts.control).toEqual(CHANGED.control)
  })

  it('[US-VALLE-001.AC04, US-VALLE-001.AC06, S28.16] folding the Work front list sets the flag on the Work front preset alone and shows a 44 px MINES strip', () => {
    const front = view({ preset: 'front', layouts: CHANGED })
    expect(valleListWidth(front.layouts)).toBe(VALLE_LIST_WIDTH)
    const folded = walk(front, [{ kind: 'fold' }])
    expect(folded.ids).toEqual(['S28.16'])
    expect(folded.view.layouts.front.foldedList).toBe(true)
    expect(folded.view.layouts.control).toEqual(CHANGED.control)
    expect(valleListWidth(folded.view.layouts)).toBe(VALLE_LIST_FOLDED_WIDTH)
    expect(VALLE_LIST_FOLDED_WIDTH).toBe(44)
    // Written at once, the Control room's layout as it was (S28.26).
    expect(folded.effects).toEqual([
      {
        kind: 'write-layouts',
        layouts: { control: CHANGED.control, front: { ...CHANGED.front, foldedList: true } }
      }
    ])
    // The Control room has no compact list to fold, and a folded list cannot fold again.
    expect(stepValle(view({ layouts: CHANGED }), { kind: 'fold' }, ENTERABLE).ok).toBe(false)
    expect(stepValle(folded.view, { kind: 'fold' }, ENTERABLE).ok).toBe(false)
  })

  it('[US-VALLE-001.AC07, S28.17] Show the mines list unfolds it to 232 px and clears the flag for this preset', () => {
    const folded = view({
      preset: 'front',
      layouts: { ...CHANGED, front: { ...CHANGED.front, foldedList: true } }
    })
    const shown = walk(folded, [{ kind: 'unfold' }])
    expect(shown.ids).toEqual(['S28.17'])
    expect(shown.view.layouts.front.foldedList).toBe(false)
    expect(valleListWidth(shown.view.layouts)).toBe(232)
    expect(shown.effects).toEqual([{ kind: 'write-layouts', layouts: CHANGED }])
    expect(stepValle(shown.view, { kind: 'unfold' }, ENTERABLE).ok).toBe(false)
  })

  it('[S28.19, S28.20] a nav page takes the main zone and Esc returns to the preset beneath', () => {
    for (const preset of ['control', 'front'] as const) {
      const start = view({ preset, layouts: CHANGED })
      const paged = walk(start, [{ kind: 'nav', page: 'map' }])
      expect(paged.ids).toEqual(['S28.19'])
      expect(paged.view).toEqual({ ...start, page: 'map' })
      // Nothing is written for a page: the preset beneath and its layout stay as they were.
      expect(paged.effects).toEqual([])
      const back = walk(paged.view, [{ kind: 'escape', layerOpen: false }])
      expect(back.ids).toEqual(['S28.20'])
      expect(back.view).toEqual(start)
      // A layer open over the page closes first.
      expect(stepValle(paged.view, { kind: 'escape', layerOpen: true }, ENTERABLE).ok).toBe(false)
    }
  })

  it('[S28.18, S28.25, S28.26] a resize re-clamps, Reset metrics returns to control, and a crash keeps the persisted preset', () => {
    for (const preset of ['control', 'front'] as const) {
      const start = view({ preset, layouts: CHANGED })
      const resized = walk(start, [{ kind: 'resize' }])
      expect(resized.ids).toEqual(['S28.18'])
      expect(resized.view).toEqual(start)
      expect(resized.effects).toEqual([{ kind: 'reclamp', preset }])
    }

    // Reset metrics from the Work front with a page open: the Control room on its defaults. UI main rewrote the
    // stores (S39.10), so nothing is written back.
    const reset = walk(view({ preset: 'front', page: 'settings', layouts: CHANGED }), [
      { kind: 'reset' }
    ])
    expect(reset.ids).toEqual(['S28.25'])
    expect(reset.view).toEqual({ preset: 'control', page: null, layouts: defaultValleLayouts() })
    expect(reset.effects).toEqual([])

    // A crash after a run of changes: what was written on every change opens again as left (S28.26, then S28.02).
    const run = walk(view(), [
      { kind: 'tab', preset: 'front' },
      { kind: 'fold' },
      { kind: 'nav', page: 'mines' }
    ])
    let stored: { preset: ValleView['preset']; layout: ValleLayouts | null } = {
      preset: 'control',
      layout: null
    }
    for (const effect of run.effects) {
      if (effect.kind === 'write-preset') stored = { ...stored, preset: effect.preset }
      if (effect.kind === 'write-layouts') stored = { ...stored, layout: effect.layouts }
    }
    const reopened = restoreValleView(stored)
    expect(reopened.preset).toBe('front')
    expect(reopened.layouts).toEqual(run.view.layouts)
    // A page is not persisted: the next open shows the preset itself.
    expect(reopened.page).toBeNull()
  })

  it('[ADR-024] a transition not listed in 07 machine 28 is rejected', () => {
    const control = view()
    const front = view({ preset: 'front' })
    const paged = view({ page: 'map' })
    const refused: [ValleView, ValleInput][] = [
      [control, { kind: 'tab', preset: 'control' }],
      [front, { kind: 'tab', preset: 'front' }],
      [control, { kind: 'arrow', key: 'ArrowLeft' }],
      [front, { kind: 'arrow', key: 'ArrowRight' }],
      [control, { kind: 'escape', layerOpen: false }],
      [control, { kind: 'unfold' }],
      [paged, { kind: 'tab', preset: 'front' }],
      [paged, { kind: 'fold' }],
      [paged, { kind: 'nav', page: 'settings' }],
      [paged, { kind: 'resize' }]
    ]
    for (const [at, input] of refused) {
      expect(stepValle(at, input, ENTERABLE), JSON.stringify([at.preset, at.page, input])).toEqual({
        ok: false,
        reason: 'not-listed'
      })
    }
  })
})

describe('the chat zone width of each preset (ISSUE-300)', () => {
  it("[US-VALLE-001.AC03, S28.02] the chat zone shows the preset's own stored width, or the default when none was set", () => {
    const stored = view({ layouts: CHANGED })
    expect(valleChatWidth(stored)).toBe(520)
    expect(valleChatWidth({ ...stored, preset: 'front' })).toBe(610)
    // Never set: the Control room's 440 px default (07 machine 33).
    expect(valleChatWidth(view())).toBe(VALLE_CONTROL_CHAT_WIDTH)
    expect(VALLE_CONTROL_CHAT_WIDTH).toBe(440)
  })
})
