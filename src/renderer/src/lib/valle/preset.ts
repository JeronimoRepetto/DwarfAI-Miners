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
 * - The dive into a mine and the climb out (S28.03…S28.15, S28.22…S28.24; ISSUE-301): the layout switches at once and a
 *   run plays over it (`flip.ts`): about 330 ms for a dive or a climb, every input ignored but a mode control, held and
 *   run when the run settles (S28.09, S28.14); 180 ms for a swap. The mosaic's scroll and the dwarf a dive is for are
 *   the session's only (ADR-024 item 4); the last mine worked in is written (N-15).
 */
import type { DwarfId, MineId, MoveToModeParams, UiPreferencesMap } from '@dwarfai/contracts'
import { diveForDwarfId, type DiveFocus } from './diveOrder'
import type { ValleMotionKind } from './flip'

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
  /** The Work front's mine: the one dived into or swapped in, else the last mine worked in (S28.02, N-15). */
  readonly mineId?: MineId
  /** The mosaic's sideways scroll saved at the dive, this run only (S28.03, S28.12; ADR-024 item 4). */
  readonly savedScroll?: number
  /** A dive, a climb or a swap running; absent once it settled. */
  readonly motion?: ValleMotion
}

/** A run of machine 28 (`diving`, `climbing`, `front-swapping`). */
export interface ValleMotion {
  readonly kind: ValleMotionKind
  /** The mine dived into, climbed out of, or swapped in (`null`: a Work front opened on no known mine). */
  readonly mineId: MineId | null
  /** That mine has a column in the mosaic: it grows from it or shrinks into it; else it rises or fades in place. */
  readonly inMosaic: boolean
  /** A mode control pressed mid-run, the last one (S28.09, S28.14); it runs as S28.21 when the run settles. */
  readonly held: MoveToModeParams | null
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
  /** `⤢` on a column header, a double-click on the mine's art, or the zone menu "Dive in · Work front" (S28.03). */
  | { readonly kind: 'dive'; readonly mineId: MineId }
  /** A double-click on a dwarf's sprite (S28.05). */
  | { readonly kind: 'sprite-double-click' }
  /** Another mine picked in the Work front, with the dwarf named when a line names one (S28.15). */
  | { readonly kind: 'pick'; readonly mineId: MineId; readonly dwarfId?: DwarfId | null }
  /** The run reached its duration, or its watchdog fired (S28.08, S28.12, S28.13, S28.15). */
  | { readonly kind: 'settled' }
  /** The Valle window went hidden (S28.22). */
  | { readonly kind: 'hidden' }
  /** `MineRemoved` (S28.23). */
  | { readonly kind: 'mine-removed'; readonly mineId: MineId }
  /** `MineBecameUnenterable` (S28.24). */
  | { readonly kind: 'mine-unenterable'; readonly mineId: MineId }

/** What a guard reads besides the view. */
export interface ValleFacts {
  /** Every mine the Host lists, and whether it can be entered (S28.04, S28.06). */
  readonly mines: readonly { readonly mineId: MineId; readonly enterable: boolean }[]
  /** The mosaic's columns, in order (S28.06, S28.07, S28.23). */
  readonly mosaic: readonly MineId[]
  /** The last mine worked in, else the most recent mine (S28.06; N-15). */
  readonly lastMine: MineId | null
  /** The mosaic's sideways scroll now (saved at a dive, S28.03). */
  readonly scrollLeft: number
  /** The chat in focus and how it was focused, for the dwarf a dive is for (S28.03). */
  readonly focus: DiveFocus | null
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
  /** A-N18 `patchUiSession({ kind: 'valle' })`: the session-only scroll and dive target (ADR-024 item 4). */
  | {
      readonly kind: 'session'
      readonly patch: { readonly mosaicScrollLeft: number; readonly diveForDwarfId: DwarfId | null }
    }
  /** A-N21 `setUiPreference(valleLastFrontMineId)`: the last mine worked in (N-15). */
  | { readonly kind: 'write-last-mine'; readonly mineId: MineId }
  /** The tab order rebuilt (S29.12) and the split adjusted (S30.07). */
  | { readonly kind: 'dive-pins'; readonly mineId: MineId; readonly forDwarfId: DwarfId | null }
  /** The stage plays the run; a climb restores `scrollLeft`. */
  | { readonly kind: 'play'; readonly motion: ValleMotion; readonly scrollLeft: number }
  /** The mosaic's saved scroll restored at once, with no motion (S28.23). */
  | { readonly kind: 'restore-scroll'; readonly scrollLeft: number }

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
 * The width stored for the preset shown, the Control room's default standing in for an unset one: which preset's own
 * width a view carries (S33.09). The chat zone itself shows the splitter's effective width (`splitter.ts`, ISSUE-305),
 * which clamps it to the range now and gives an unset Work front width that preset's own default formula.
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

const enterable = (facts: ValleFacts, mineId: MineId): boolean =>
  facts.mines.some((mine) => mine.mineId === mineId && mine.enterable)

/** The view with its run settled: the motion gone, every other field as it is. */
function settledView(view: ValleView): ValleView {
  const settled: { motion?: ValleMotion } & Omit<ValleView, 'motion'> = { ...view }
  delete settled.motion
  return settled
}

/** A run of `kind` on `mineId`, nothing held. */
function motionOf(kind: ValleMotionKind, mineId: MineId | null, facts: ValleFacts): ValleMotion {
  return {
    kind,
    mineId,
    inMosaic: mineId !== null && facts.mosaic.includes(mineId),
    held: null
  }
}

/**
 * S28.03, S28.06, S28.07: the dive into `mineId`. The layout switches to the Work front at once (FLIP: the stage
 * measures first, then plays the parts from where they were); the mosaic's scroll and the dwarf the dive is for go to
 * the session only; the tab order is rebuilt and the split adjusted; the preset and the last mine worked in are written.
 */
function diveInto(id: string, view: ValleView, mineId: MineId, facts: ValleFacts): ValleStep {
  const motion = motionOf('diving', mineId, facts)
  const forDwarfId = diveForDwarfId(facts.focus, mineId)
  const scrollLeft = facts.scrollLeft
  return taken(
    motion.inMosaic ? id : 'S28.07',
    { ...view, preset: 'front', mineId, savedScroll: scrollLeft, motion },
    [
      { kind: 'session', patch: { mosaicScrollLeft: scrollLeft, diveForDwarfId: forDwarfId } },
      { kind: 'dive-pins', mineId, forDwarfId },
      { kind: 'write-preset', preset: 'front' },
      { kind: 'write-last-mine', mineId },
      { kind: 'play', motion, scrollLeft }
    ]
  )
}

/** S28.06's mine: the last mine worked in, or, when it cannot be entered, the first mosaic column that can. */
function tabTarget(facts: ValleFacts): MineId | null {
  if (facts.lastMine !== null && enterable(facts, facts.lastMine)) return facts.lastMine
  return facts.mosaic.find((mineId) => enterable(facts, mineId)) ?? null
}

/** S28.11: the climb out, the layout back to the Control room at once, the saved scroll restored by the stage. */
function climbOut(view: ValleView, facts: ValleFacts): ValleStep {
  const motion = motionOf('climbing', view.mineId ?? null, facts)
  return taken('S28.11', { ...view, preset: 'control', motion }, [
    { kind: 'write-preset', preset: 'control' },
    { kind: 'play', motion, scrollLeft: view.savedScroll ?? 0 }
  ])
}

/** S28.15, S28.23: another mine swapped in place, the tab order rebuilt with the named dwarf first. */
function swapTo(
  id: string,
  view: ValleView,
  mineId: MineId,
  forDwarfId: DwarfId | null,
  facts: ValleFacts
): ValleStep {
  const motion = motionOf('front-swapping', mineId, facts)
  return taken(id, { ...view, mineId, motion }, [
    { kind: 'dive-pins', mineId, forDwarfId },
    { kind: 'write-last-mine', mineId },
    { kind: 'play', motion, scrollLeft: view.savedScroll ?? 0 }
  ])
}

/** The run's end: its settled id, and a mode control held during it runs now (S28.21). */
function settle(id: string, view: ValleView, motion: ValleMotion): ValleStep {
  const effects: ValleEffect[] = motion.held === null ? [] : [{ kind: 'move', move: motion.held }]
  return taken(id, settledView(view), effects)
}

/** The id a run settles with (S28.08, S28.12, S28.13, S28.15). */
function settledId(motion: ValleMotion): string {
  if (motion.kind === 'diving') return 'S28.08'
  if (motion.kind === 'front-swapping') return 'S28.15'
  return motion.inMosaic ? 'S28.12' : 'S28.13'
}

/**
 * `diving` and `climbing` (S28.09, S28.14): a mode control is held, the last one winning; every other input is ignored,
 * never queued. A run ends at its duration or its watchdog, or at once when the window hides (S28.22).
 * `front-swapping` ends the same way; leaving Valle resolves it at once and moves (S28.22, S28.21).
 */
function stepMotion(view: ValleView, motion: ValleMotion, input: ValleInput): ValleStep {
  if (input.kind === 'settled') return settle(settledId(motion), view, motion)
  if (input.kind === 'hidden') return settle('S28.22', view, motion)
  if (motion.kind === 'front-swapping') {
    if (input.kind !== 'leave') return REFUSED
    return taken('S28.22', settledView(view), [{ kind: 'move', move: input.move }])
  }
  const ignored = motion.kind === 'diving' ? 'S28.09' : 'S28.14'
  if (input.kind === 'leave') {
    return taken(ignored, { ...view, motion: { ...motion, held: input.move } })
  }
  // A Host fact is not input: no transition lists one mid-run.
  if (input.kind === 'mine-removed' || input.kind === 'mine-unenterable') return REFUSED
  return taken(ignored, view)
}

/** `control`, no page, no motion. */
function stepControl(view: ValleView, input: ValleInput, facts: ValleFacts): ValleStep | null {
  if (input.kind === 'dive') {
    if (!enterable(facts, input.mineId)) return taken('S28.04', view)
    return diveInto('S28.03', view, input.mineId, facts)
  }
  if (input.kind === 'sprite-double-click') return taken('S28.05', view)
  if (askedPreset(input) === 'front') {
    const target = tabTarget(facts)
    return target === null ? REFUSED : diveInto('S28.06', view, target, facts)
  }
  return null
}

/** `front`, no page, no motion. */
function stepFront(view: ValleView, input: ValleInput, facts: ValleFacts): ValleStep | null {
  if (askedPreset(input) === 'control' || (input.kind === 'escape' && !input.layerOpen)) {
    return climbOut(view, facts)
  }
  if (input.kind === 'fold' && !view.layouts.front.foldedList) return withList('S28.16', view, true)
  if (input.kind === 'unfold' && view.layouts.front.foldedList) {
    return withList('S28.17', view, false)
  }
  if (input.kind === 'pick') {
    if (input.mineId === view.mineId) return REFUSED
    const forDwarfId = input.dwarfId ?? diveForDwarfId(facts.focus, input.mineId)
    return swapTo('S28.15', view, input.mineId, forDwarfId, facts)
  }
  if (input.kind === 'mine-removed') {
    if (input.mineId !== view.mineId) return REFUSED
    const next = facts.mosaic.find((id) => id !== input.mineId && enterable(facts, id))
    if (next !== undefined) return swapTo('S28.23', view, next, null, facts)
    // No other mine to show: climbed out at once, the saved scroll back.
    return taken('S28.23', { ...view, preset: 'control' }, [
      { kind: 'write-preset', preset: 'control' },
      { kind: 'restore-scroll', scrollLeft: view.savedScroll ?? 0 }
    ])
  }
  if (input.kind === 'mine-unenterable') {
    // It stays shown: its dwarfs may still work (S28.24).
    return input.mineId === view.mineId ? taken('S28.24', view) : REFUSED
  }
  return null
}

export function stepValle(view: ValleView, input: ValleInput, facts: ValleFacts): ValleStep {
  // Any state: Reset metrics (S28.25). UI main rewrote the stores to their defaults (S39.10): nothing is written back.
  if (input.kind === 'reset') {
    return taken('S28.25', { preset: 'control', page: null, layouts: defaultValleLayouts() })
  }
  if (view.motion !== undefined) return stepMotion(view, view.motion, input)
  // At rest: leaving Valle (S28.21).
  if (input.kind === 'leave') return taken('S28.21', view, [{ kind: 'move', move: input.move }])

  if (view.page !== null) {
    // `page`: Esc with no other layer open returns to the preset beneath (S28.20).
    if (input.kind === 'escape' && !input.layerOpen) return taken('S28.20', { ...view, page: null })
    return REFUSED
  }

  const step =
    view.preset === 'control' ? stepControl(view, input, facts) : stepFront(view, input, facts)
  if (step !== null) return step
  if (input.kind === 'nav') return taken('S28.19', { ...view, page: input.page })
  if (input.kind === 'resize')
    return taken('S28.18', view, [{ kind: 'reclamp', preset: view.preset }])
  return REFUSED
}
