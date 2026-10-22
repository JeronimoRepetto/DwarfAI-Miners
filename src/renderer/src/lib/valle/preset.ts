/*
 * Valle's preset (07 machine 28; US-VALLE-001; ADR-024 items 1, 4, 8; ISSUE-300): which preset Valle shows, the
 * Control room or the Work front, each with its own layout (14 §3.9 `ValleLayoutControl`, `ValleLayoutFront`), and a
 * nav page over the main zone. Pure: the caller hands each input with the facts its guard reads, and carries out the
 * effects (the A-N21 writes, the A-N13 move).
 *
 * - A preset switch restores the target preset's own layout and leaves the other's untouched (US-VALLE-001.AC03).
 * - Folding or unfolding the Work front's compact mines list changes the Work front layout alone (S28.16, S28.17).
 * - The preset and the layouts are written at once on every change (S28.26), so the next open is S28.02.
 * - Only the transitions 07 machine 28 lists are taken; anything else is refused and changes nothing (ADR-024).
 *
 * The dive and climb motion (`diving`, `climbing`, `front-swapping`, the input gate) is ISSUE-301's: here a switch
 * lands on the target preset at once.
 */
import type { MoveToModeParams, UiPreferencesMap } from '@dwarfai/contracts'

export type VallePreset = UiPreferencesMap['vallePreset']
/** Both presets' layouts, as A-N20 / A-N21 carry them. */
export type ValleLayouts = UiPreferencesMap['valleLayout']
/** The nav pages that take Valle's main zone (07 S28.19). */
export type ValleNavPage = 'map' | 'mines' | 'settings'

/** What Valle shows: the preset, a nav page over its main zone (or none), and each preset's own layout. */
export interface ValleView {
  readonly preset: VallePreset
  readonly page: ValleNavPage | null
  readonly layouts: ValleLayouts
}

/** What the person did, or what happened to the window. */
export type ValleInput =
  /** A preset tab clicked (S28.06, S28.11). */
  | { readonly kind: 'tab'; readonly preset: VallePreset }
  /** ← or → pressed with a preset tab focused (S28.06, S28.11). */
  | { readonly kind: 'arrow'; readonly key: 'ArrowLeft' | 'ArrowRight' }
  /** Esc; `layerOpen` when a menu, drawer or picker is open, which closes first (NFR-A11Y-02). */
  | { readonly kind: 'escape'; readonly layerOpen: boolean }
  /** "⇤ Fold the list" (S28.16). */
  | { readonly kind: 'fold' }
  /** "Show the mines list" (S28.17). */
  | { readonly kind: 'unfold' }
  /** A nav slot in Valle's nav column (S28.19). */
  | { readonly kind: 'nav'; readonly page: ValleNavPage }
  /** A window or work-area resize (S28.18). */
  | { readonly kind: 'resize' }
  /** "▼ Panel" or "▼ Veta" in Valle's top bar, carrying the chat in focus (S28.21). */
  | { readonly kind: 'leave'; readonly move: MoveToModeParams }
  /** Reset metrics (`ui.resetPreferences`, S28.25). */
  | { readonly kind: 'reset' }

/** What a guard reads besides the view. */
export interface ValleFacts {
  /** At least one mine can be entered (S28.06). */
  readonly enterableMine: boolean
}

/** What the caller carries out after a transition. */
export type ValleEffect =
  /** A-N21 `setUiPreference(vallePreset)`. */
  | { readonly kind: 'write-preset'; readonly preset: VallePreset }
  /** A-N21 `setUiPreference(valleLayout)`. */
  | { readonly kind: 'write-layouts'; readonly layouts: ValleLayouts }
  /** The chat zone re-clamps and the split re-checks (S33.08, S30.05, S30.06; ISSUE-303, ISSUE-305). */
  | { readonly kind: 'reclamp'; readonly preset: VallePreset }
  /** A-N13 `moveToMode` (machine 27). */
  | { readonly kind: 'move'; readonly move: MoveToModeParams }

export type ValleStep =
  | {
      readonly ok: true
      /** The 07 machine 28 transition taken. */
      readonly id: string
      readonly view: ValleView
      readonly effects: readonly ValleEffect[]
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

/** The compact mines list's width in the Work front, and the strip it folds to (`DS/docs/screens/valle.md` Layout). */
export const VALLE_LIST_WIDTH = 232
export const VALLE_LIST_FOLDED_WIDTH = 44

/**
 * A chat width the person never set: the preset's own default applies (07 machine 33 `rest`, "the default formula when
 * nothing is stored"; S33.06 "the stored value cleared"). 14 §3.9 types `chatWidth` as a number, and every width the
 * splitter can set is at least 340 px, so 0 says "not set" without a new field (ISSUE-305 owns the splitter).
 */
export const VALLE_CHAT_WIDTH_UNSET = 0

/** The Control room's chat width by default (07 machine 33; `DS/docs/screens/valle.md` Layout). */
export const VALLE_CONTROL_CHAT_WIDTH = 440

/**
 * The chat zone's width for the preset shown: the width stored for it, or its default when none was set. The Work
 * front's default is the splitter's width formula (07 machine 33, S33.08), which ISSUE-305 brings with the clamp; until
 * then an unset Work front width shows the Control room's default.
 */
export function valleChatWidth(view: ValleView): number {
  const stored = view.layouts[view.preset].chatWidth
  return stored === VALLE_CHAT_WIDTH_UNSET ? VALLE_CONTROL_CHAT_WIDTH : stored
}

/** Each preset's default layout: no width set, no split, the list unfolded, every zone showing its mine. */
export function defaultValleLayouts(): ValleLayouts {
  return {
    control: { chatWidth: VALLE_CHAT_WIDTH_UNSET, split: false, foldedList: false, zones: {} },
    front: {
      chatWidth: VALLE_CHAT_WIDTH_UNSET,
      split: false,
      foldedList: false,
      zone: { content: 'mine' }
    }
  }
}

/** The width of the Work front's compact mines list: 232 px, or the 44 px "MINES" strip when folded. */
export function valleListWidth(layouts: ValleLayouts): number {
  return layouts.front.foldedList ? VALLE_LIST_FOLDED_WIDTH : VALLE_LIST_WIDTH
}

const REFUSED: ValleStep = { ok: false, reason: 'not-listed' }

function taken(id: string, view: ValleView, effects: readonly ValleEffect[] = []): ValleStep {
  return { ok: true, id, view, effects }
}

/** A switch to `preset`: its own layout comes back as it is, the other preset's untouched; written at once. */
function switchTo(id: string, view: ValleView, preset: VallePreset): ValleStep {
  return taken(id, { ...view, preset }, [{ kind: 'write-preset', preset }])
}

/** The Work front's list folded or unfolded: the Work front layout alone changes, written at once. */
function withList(id: string, view: ValleView, foldedList: boolean): ValleStep {
  const layouts: ValleLayouts = { ...view.layouts, front: { ...view.layouts.front, foldedList } }
  return taken(id, { ...view, layouts }, [{ kind: 'write-layouts', layouts }])
}

/** The preset the input asks for, when it is a tab or an arrow key on a focused tab. */
function askedPreset(input: ValleInput): VallePreset | null {
  if (input.kind === 'tab') return input.preset
  if (input.kind === 'arrow') return input.key === 'ArrowRight' ? 'front' : 'control'
  return null
}

export function stepValle(view: ValleView, input: ValleInput, facts: ValleFacts): ValleStep {
  // Any state: leaving Valle (S28.21) and Reset metrics (S28.25).
  if (input.kind === 'leave') return taken('S28.21', view, [{ kind: 'move', move: input.move }])
  if (input.kind === 'reset') {
    // UI main rewrote the stores to their defaults (S39.10): nothing is written back.
    return taken('S28.25', { preset: 'control', page: null, layouts: defaultValleLayouts() })
  }

  if (view.page !== null) {
    // `page`: Esc with no other layer open returns to the preset beneath (S28.20).
    if (input.kind === 'escape' && !input.layerOpen) return taken('S28.20', { ...view, page: null })
    return REFUSED
  }

  const asked = askedPreset(input)
  if (view.preset === 'control') {
    if (asked === 'front' && facts.enterableMine) return switchTo('S28.06', view, 'front')
  } else {
    if (asked === 'control') return switchTo('S28.11', view, 'control')
    if (input.kind === 'escape' && !input.layerOpen) return switchTo('S28.11', view, 'control')
    if (input.kind === 'fold' && !view.layouts.front.foldedList)
      return withList('S28.16', view, true)
    if (input.kind === 'unfold' && view.layouts.front.foldedList) {
      return withList('S28.17', view, false)
    }
  }
  if (input.kind === 'nav') return taken('S28.19', { ...view, page: input.page })
  if (input.kind === 'resize')
    return taken('S28.18', view, [{ kind: 'reclamp', preset: view.preset }])
  return REFUSED
}
