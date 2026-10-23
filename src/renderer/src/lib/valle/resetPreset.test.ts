import type { MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { defaultValleLayouts, VALLE_CHAT_WIDTH_UNSET, type ValleLayouts } from './preset'
import {
  resetPresetLayouts,
  resetToast,
  stepResetPreset,
  type ResetPresetFacts,
  type ResetPresetInput,
  type ResetPresetState,
  type ResetPresetStep
} from './resetPreset'

/*
 * 07 machine 37 `ResetPresetState` (ISSUE-309; US-VALLE-010; UC-062; ADR-024 items 1, 4): one action in the top bar's
 * "⋯" menu puts the preset shown back to its documented defaults, never touching a pin or the other preset. The pure
 * machine hands each input the facts its guard reads; the effects it names are the caller's to carry out.
 */

const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a11' as MineId

/** Both layouts changed from their defaults: a width, a split, a folded list, a zone swapped to something else. */
const CHANGED: ValleLayouts = {
  control: {
    chatWidth: 520,
    split: false,
    foldedList: false,
    zones: { [MINE]: { content: 'map' } }
  },
  front: {
    chatWidth: 610,
    split: true,
    foldedList: true,
    zone: { content: 'history', mineId: MINE }
  }
}

const facts = (over: Partial<ResetPresetFacts> = {}): ResetPresetFacts => ({
  preset: 'control',
  layouts: CHANGED,
  moving: false,
  ...over
})

function take(state: ResetPresetState, input: ResetPresetInput, at: ResetPresetFacts) {
  const step = stepResetPreset(state, input, at)
  expect(step.ok, `${input.kind} in ${state} is listed`).toBe(true)
  if (!step.ok) throw new Error('refused')
  return step
}

const layoutsOf = (step: ResetPresetStep): ValleLayouts => {
  if (!step.ok) throw new Error('refused')
  const effect = step.effects.find((each) => each.kind === 'layouts')
  if (effect?.kind !== 'layouts') throw new Error('no layouts effect')
  return effect.layouts
}

describe('machine 37 diagram conformance', () => {
  it('[US-VALLE-010.AC01, S37.03, S37.04] Reset preset returns the preset shown to its defaults and the toast names that preset', () => {
    const control = take('menu-open', { kind: 'reset' }, facts({ preset: 'control' }))
    expect(control.id).toBe('S37.03')
    expect(control.state).toBe('resetting')
    const afterControl = layoutsOf(control)
    expect(afterControl.control).toEqual(defaultValleLayouts().control)
    expect(afterControl.control.chatWidth).toBe(VALLE_CHAT_WIDTH_UNSET)
    expect(afterControl.control.zones).toEqual({})
    expect(control.effects).toContainEqual({
      kind: 'toast',
      text: 'Control room is back to its preset'
    })
    // The Control room's reset recomputes the mosaic and returns the splitter to its default; it never turns a split off.
    expect(control.effects.map((each) => each.kind)).toEqual([
      'flip',
      'layouts',
      'splitter',
      'mosaic',
      'toast'
    ])

    const front = take('menu-open', { kind: 'reset' }, facts({ preset: 'front' }))
    expect(front.id).toBe('S37.04')
    expect(front.state).toBe('resetting')
    const afterFront = layoutsOf(front)
    expect(afterFront.front).toEqual(defaultValleLayouts().front)
    expect(afterFront.front).toMatchObject({
      chatWidth: VALLE_CHAT_WIDTH_UNSET,
      split: false,
      foldedList: false,
      zone: { content: 'mine' }
    })
    expect(front.effects).toContainEqual({
      kind: 'toast',
      text: 'Work front is back to its preset'
    })
    expect(front.effects.map((each) => each.kind)).toEqual([
      'flip',
      'layouts',
      'splitter',
      'split-off',
      'toast'
    ])
    expect(resetToast('control')).toBe('Control room is back to its preset')
    expect(resetToast('front')).toBe('Work front is back to its preset')
  })

  it('[US-VALLE-010.AC02] every pin stays exactly as it was; nothing is unpinned or reordered', () => {
    // The machine names no pin effect at all: what it can ask for is the layout, the splitter, the mosaic, the split,
    // the FLIP and the toast, and the layouts it writes carry no pin.
    const allowed = new Set(['flip', 'layouts', 'splitter', 'mosaic', 'split-off', 'toast'])
    for (const preset of ['control', 'front'] as const) {
      const step = take('menu-open', { kind: 'reset' }, facts({ preset }))
      expect(step.effects.every((each) => allowed.has(each.kind))).toBe(true)
      expect(Object.keys(layoutsOf(step)).sort()).toEqual(['control', 'front'])
    }
  })

  it('[US-VALLE-010.AC03, S32.15] resetting the Control room recomputes the mosaic from every mine with a crew in data order', () => {
    const control = take('menu-open', { kind: 'reset' }, facts({ preset: 'control' }))
    expect(control.effects).toContainEqual({ kind: 'mosaic' })
    // The Work front keeps its mosaic: S32.15 is the Control room's.
    const front = take('menu-open', { kind: 'reset' }, facts({ preset: 'front' }))
    expect(front.effects).not.toContainEqual({ kind: 'mosaic' })
  })

  it("[US-VALLE-010.AC04] the other preset's layout is untouched", () => {
    const control = layoutsOf(take('menu-open', { kind: 'reset' }, facts({ preset: 'control' })))
    expect(control.front).toBe(CHANGED.front)
    const front = layoutsOf(take('menu-open', { kind: 'reset' }, facts({ preset: 'front' })))
    expect(front.control).toBe(CHANGED.control)
    expect(resetPresetLayouts(CHANGED, 'front').control).toBe(CHANGED.control)
    expect(resetPresetLayouts(CHANGED, 'control').front).toBe(CHANGED.front)
  })

  it('[S37.01, S37.02, S37.05, S37.06] the menu opens only outside a dive or a climb, Esc closes it, and a failed write keeps the defaults for the session', () => {
    // S37.01: the menu opens at rest, refused while a dive or a climb runs.
    expect(take('idle', { kind: 'menu' }, facts()).state).toBe('menu-open')
    expect(take('idle', { kind: 'menu' }, facts()).id).toBe('S37.01')
    expect(stepResetPreset('idle', { kind: 'menu' }, facts({ moving: true }))).toEqual({
      ok: false,
      reason: 'not-listed'
    })

    // S37.02: Esc or an outside press closes it, nothing else happens.
    const closed = take('menu-open', { kind: 'dismiss' }, facts())
    expect(closed.id).toBe('S37.02')
    expect(closed.state).toBe('idle')
    expect(closed.effects).toEqual([])

    // S37.05: the FLIP done, back to idle.
    const settled = take('resetting', { kind: 'settled' }, facts())
    expect(settled.id).toBe('S37.05')
    expect(settled.state).toBe('idle')

    // S37.06: the store write failed; idle at once, nothing undone (the defaults apply for the session).
    const failed = take('resetting', { kind: 'write-failed' }, facts())
    expect(failed.id).toBe('S37.06')
    expect(failed.state).toBe('idle')
    expect(failed.effects).toEqual([])
  })

  it('[ADR-024] a transition not listed in 07 machine 37 is rejected', () => {
    const refused = { ok: false, reason: 'not-listed' }
    // The listed ones are taken, the rest refused.
    expect(take('idle', { kind: 'menu' }, facts()).id).toBe('S37.01')
    expect(take('menu-open', { kind: 'reset' }, facts()).id).toBe('S37.03')
    expect(stepResetPreset('idle', { kind: 'reset' }, facts())).toEqual(refused)
    expect(stepResetPreset('idle', { kind: 'dismiss' }, facts())).toEqual(refused)
    expect(stepResetPreset('idle', { kind: 'settled' }, facts())).toEqual(refused)
    expect(stepResetPreset('idle', { kind: 'write-failed' }, facts())).toEqual(refused)
    expect(stepResetPreset('menu-open', { kind: 'menu' }, facts())).toEqual(refused)
    expect(stepResetPreset('menu-open', { kind: 'settled' }, facts())).toEqual(refused)
    expect(stepResetPreset('resetting', { kind: 'menu' }, facts())).toEqual(refused)
    expect(stepResetPreset('resetting', { kind: 'reset' }, facts())).toEqual(refused)
    expect(stepResetPreset('resetting', { kind: 'dismiss' }, facts())).toEqual(refused)
  })
})
