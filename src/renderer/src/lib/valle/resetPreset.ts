/*
 * Valle's "Reset preset" (07 machine 37 `ResetPresetState`; US-VALLE-010; UC-062; ADR-024 items 1, 4; BR-23; ISSUE-309):
 * the top bar's "⋯" menu holding one action that puts the preset shown back to its documented defaults. Pure: the caller
 * hands each input with the facts its guard reads and carries out the effects (the A-N21 write, the other machines'
 * wishes, the FLIP, the toast).
 *
 * - The menu opens only outside a dive or a climb (S37.01); Esc or an outside press closes it and changes nothing (S37.02).
 * - "Reset preset" in the Control room: chat width 440 px (S33.10), the mosaic recomputed (S32.15), every zone back to
 *   `mine` (S31.12), the Work front layout untouched (S37.03). In the Work front: the default chat width, the split off
 *   (S30.11), the list unfolded, the zone `mine`, the Control room layout untouched (S37.04). Pins are never part of
 *   it: nothing here names one (US-VALLE-010.AC02).
 * - The zones' content FLIPs to the default layout; the run ends on the first of its duration, its watchdog or reduced
 *   motion (S37.05). A failed layout write ends it at once with the defaults still applied for the session (S37.06); UI
 *   main's store logs it (`uiprefs.write-failed`, 19 §9.6).
 * - Only the transitions 07 machine 37 lists are taken; anything else is refused and changes nothing (ADR-024).
 */
import { defaultValleLayouts, type ValleLayouts, type VallePreset } from './preset'

export type ResetPresetState = 'idle' | 'menu-open' | 'resetting'

/** What machine 37 reads: the preset shown, both layouts, and whether a dive or a climb is running. */
export interface ResetPresetFacts {
  readonly preset: VallePreset
  readonly layouts: ValleLayouts
  /** A dive or a climb is running (machine 28 `diving` / `climbing`). */
  readonly moving: boolean
}

export type ResetPresetInput =
  /** The top bar's "⋯" (S37.01). */
  | { readonly kind: 'menu' }
  /** Esc or an outside press with the menu open (S37.02). */
  | { readonly kind: 'dismiss' }
  /** "Reset preset" picked (S37.03, S37.04). */
  | { readonly kind: 'reset' }
  /** The FLIP done, its watchdog, or reduced motion in the same frame (S37.05). */
  | { readonly kind: 'settled' }
  /** The layout store write failed (S37.06). */
  | { readonly kind: 'write-failed' }

export type ResetPresetEffect =
  /** The zones' content FLIPs from the old layout to the new one: measured before `layouts` is applied. */
  | { readonly kind: 'flip' }
  /** A-N21 `setUiPreference(valleLayout)`: both layouts, the preset shown at its defaults, the other copied as it was. */
  | { readonly kind: 'layouts'; readonly layouts: ValleLayouts }
  /** S33.10: the splitter returns to rest at the default width. */
  | { readonly kind: 'splitter' }
  /** S32.15: the mosaic recomputed from every mine with a crew, in data order (Control room). */
  | { readonly kind: 'mosaic' }
  /** S30.11: the split machine turns the split off (Work front). */
  | { readonly kind: 'split-off' }
  /** The window's one toast (BR-23). */
  | { readonly kind: 'toast'; readonly text: string }

export type ResetPresetStep =
  | {
      readonly ok: true
      /** The 07 machine 37 transition taken. */
      readonly id: string
      readonly state: ResetPresetState
      readonly effects: readonly ResetPresetEffect[]
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

/** The preset's own words in the toast (`DS/docs/copy.md`, Valle: "[Control room | Work front] is back to its preset"). */
export function resetToast(preset: VallePreset): string {
  return `${preset === 'control' ? 'Control room' : 'Work front'} is back to its preset`
}

/** Both layouts with `preset` at its documented defaults; the other preset's layout is the same object (US-VALLE-010.AC04). */
export function resetPresetLayouts(layouts: ValleLayouts, preset: VallePreset): ValleLayouts {
  const defaults = defaultValleLayouts()
  return preset === 'control'
    ? { ...layouts, control: defaults.control }
    : { ...layouts, front: defaults.front }
}

const REFUSED: ResetPresetStep = { ok: false, reason: 'not-listed' }

function taken(
  id: string,
  state: ResetPresetState,
  effects: readonly ResetPresetEffect[] = []
): ResetPresetStep {
  return { ok: true, id, state, effects }
}

/**
 * S37.03 and S37.04: the FLIP is measured first, then the preset's defaults are written (the other preset copied), the
 * splitter returns to rest (S33.10), the Control room's mosaic is recomputed (S32.15) or the Work front's split turned
 * off (S30.11), and the toast names the preset. Every zone is `mine` in the defaults (S31.12).
 */
function reset(facts: ResetPresetFacts): ResetPresetStep {
  const control = facts.preset === 'control'
  return taken(control ? 'S37.03' : 'S37.04', 'resetting', [
    { kind: 'flip' },
    { kind: 'layouts', layouts: resetPresetLayouts(facts.layouts, facts.preset) },
    { kind: 'splitter' },
    control ? { kind: 'mosaic' } : { kind: 'split-off' },
    { kind: 'toast', text: resetToast(facts.preset) }
  ])
}

export function stepResetPreset(
  state: ResetPresetState,
  input: ResetPresetInput,
  facts: ResetPresetFacts
): ResetPresetStep {
  switch (state) {
    case 'idle':
      return input.kind === 'menu' && !facts.moving ? taken('S37.01', 'menu-open') : REFUSED
    case 'menu-open':
      if (input.kind === 'dismiss') return taken('S37.02', 'idle')
      return input.kind === 'reset' ? reset(facts) : REFUSED
    case 'resetting':
      if (input.kind === 'settled') return taken('S37.05', 'idle')
      return input.kind === 'write-failed' ? taken('S37.06', 'idle') : REFUSED
  }
}
