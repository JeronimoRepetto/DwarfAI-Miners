/*
 * The Veta grip menu and mine picker carried out (07 machine 22; US-VETA-003, US-LAUNCH-007, US-VETA-010; UC-046,
 * UC-052; ISSUE-288). `lib/veta/gripMenu.ts` decides each step; this holds the machine, the mines read model the picker
 * lists, and does what each step names:
 *
 * - The menu's moves and the hand-off after a new mine go through A-N13 `moveToMode` (machine 27): the Panel with no
 *   mine (S22.04), Valle (S22.05), hidden (S22.06), the Panel on the mine just added (S22.13, S22.14).
 * - A picked mine raises the Add panel at it (S22.09; the rise is ISSUE-290's, this only asks for it).
 * - "Add a mine" is A-30 `declareMine` (S22.10): UI main opens the OS folder picker and declares the folder it gives
 *   (`mines.declare`), so the renderer names no path. A cancel goes back to the picker (S22.11). A worktree of a known
 *   project asks first, as the Mines page does (US-MINES-004.AC03, AC07, the shared `WorktreeDialog`): Cancel goes back
 *   to the picker adding nothing (S22.11); "Add <mine>" folds it into that project's mine through A-31
 *   `declareMainProject` (AC06), then the Panel opens on it (S22.14). A refusal, or UI main out of
 *   reach, goes back to the picker with the Mines page's own words for it (S22.15, US-MINES-004): the reason UI main
 *   answered (`declareFailureNotice`, the Mines page's), or the Mines page's line for a bridge that never answered.
 * - Esc or an outside click gives the focus back to what opened the overlay (S22.03, S22.16); a mode change (A-N14,
 *   this window the source) closes it silently (S22.17).
 *
 * The picker lists every live mine (`mines`, the life state's read model), those with no chamber included. The bridge,
 * the mines and the focus and Add panel hooks are injected (the house idiom over `vi.mock`).
 */
import type { BuiltMode, MineId, ModeTransition, MoveToModeParams } from '@dwarfai/contracts'
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  type ComputedRef,
  type Ref
} from 'vue'
import { declareFailureNotice } from '../lib/browse/addProject'
import {
  CLOSED_GRIP_MENU,
  stepGripMenu,
  type GripMenu,
  type GripMenuEffect,
  type GripMenuEvent,
  type GripMenuState,
  type GripMenuStep,
  type Opener
} from '../lib/veta/gripMenu'
import { pickerRows, type PickerMine, type PickerRow } from '../lib/veta/minePicker'
import type { MineDeclareResult, MineWorktreeOf } from '../types'
import { DECLARE_UNREACHABLE } from './useProjectBrowse'

/** The seam A members the menu and the picker use (14 §2.1 A-30, A-31; §2.2 A-N13). */
export interface MinePickerBridge {
  declareMine(): Promise<MineDeclareResult>
  declareMainProject(): Promise<MineDeclareResult>
  moveToMode(params: MoveToModeParams): Promise<unknown>
  /** A-N14: a mode change closes an open menu or picker silently (S22.17). */
  onModeTransition(handler: (transition: ModeTransition) => void): () => void
}

export interface MinePickerDeps {
  bridge: MinePickerBridge
  /** Every live mine with its present crew, in mine order (reactive). */
  mines(): readonly PickerMine[]
  /** The modes this build contains. */
  built: readonly BuiltMode[]
  /** Gives the focus back to the opener (S22.03, S22.16). */
  focus(target: Opener): void
  /** Raises the Add panel aimed at a mine (S22.09). */
  addPanel(mineId: MineId): void
}

export interface MinePickerPart {
  machine: Readonly<Ref<GripMenu>>
  state: ComputedRef<GripMenuState>
  /** The picker's rows: every live mine, recently used first. */
  rows: ComputedRef<PickerRow[]>
  /** Why the last Add a mine added nothing (S22.15), or `null`. */
  notice: Readonly<Ref<string | null>>
  /** The last step taken or refused. */
  last: Readonly<Ref<GripMenuStep | null>>
  /** One step of machine 22, carried out. */
  dispatch(event: GripMenuEvent): GripMenuStep
  /** The worktree question asked (US-MINES-004.AC03), or `null`. */
  worktree: Readonly<Ref<MineWorktreeOf | null>>
  /** True while "Add <mine>" adopts the main project. */
  adopting: Readonly<Ref<boolean>>
  /** The answer to the worktree question: "Add <mine>" (`true`) or Cancel. */
  answerWorktree(accept: boolean): void
}

export function useMinePicker(deps: MinePickerDeps): MinePickerPart {
  const machine = shallowRef<GripMenu>(CLOSED_GRIP_MENU)
  const notice = shallowRef<string | null>(null)
  const last = shallowRef<GripMenuStep | null>(null)
  const worktree = shallowRef<MineWorktreeOf | null>(null)
  const adopting = shallowRef(false)

  function move(params: MoveToModeParams): void {
    void deps.bridge.moveToMode(params).catch(() => {
      // UI main is out of reach: nothing moved, and Veta stays where the person can try again.
    })
  }

  /** A mine declared, or the reason the folder added nothing (S22.12–S22.15). */
  async function declare(): Promise<void> {
    let answer: MineDeclareResult
    try {
      answer = await deps.bridge.declareMine()
    } catch {
      dispatch({ type: 'folder-picked' })
      fail(DECLARE_UNREACHABLE)
      return
    }
    if (answer.outcome === 'cancelled') {
      dispatch({ type: 'folder-cancelled' })
      return
    }
    if (answer.outcome === 'worktree-of' && answer.worktreeOf !== undefined) {
      // A worktree: the question first (US-MINES-004.AC03); the folder counts as picked only on "Add <mine>".
      worktree.value = answer.worktreeOf
      return
    }
    dispatch({ type: 'folder-picked' })
    settle(answer, false)
  }

  /** A mine ready hands off to the Panel on it (S22.13, S22.14); anything else is a refusal (S22.15). */
  function settle(answer: MineDeclareResult, fromWorktree: boolean): void {
    if (answer.outcome === 'added' && answer.mineId !== undefined) {
      dispatch({ type: 'declared', mineId: answer.mineId as MineId, worktree: fromWorktree })
      return
    }
    fail(declareFailureNotice({ ...answer, outcome: 'failed' }))
  }

  /** The worktree question answered: Cancel adds nothing (S22.11); "Add <mine>" adopts the main project (AC06). */
  async function answerWorktree(accept: boolean): Promise<void> {
    if (worktree.value === null || adopting.value) return
    if (!accept) {
      worktree.value = null
      dispatch({ type: 'folder-cancelled' })
      return
    }
    adopting.value = true
    dispatch({ type: 'folder-picked' })
    let answer: MineDeclareResult
    try {
      answer = await deps.bridge.declareMainProject()
    } catch {
      worktree.value = null
      adopting.value = false
      fail(DECLARE_UNREACHABLE)
      return
    }
    worktree.value = null
    adopting.value = false
    settle(answer, true)
  }

  function fail(reason: string | null): void {
    notice.value = reason
    dispatch({ type: 'declare-failed' })
  }

  function carryOut(effect: GripMenuEffect): void {
    switch (effect.kind) {
      case 'move':
        move(
          effect.mineId === undefined
            ? { mode: effect.mode }
            : { mode: effect.mode, mineId: effect.mineId }
        )
        return
      case 'focus':
        deps.focus(effect.target)
        return
      case 'add-panel':
        deps.addPanel(effect.mineId)
        return
      case 'pick-folder':
        notice.value = null
        void declare()
        return
    }
  }

  function dispatch(event: GripMenuEvent): GripMenuStep {
    const next = stepGripMenu(machine.value, event, {
      liveMines: deps.mines().length,
      built: deps.built
    })
    machine.value = next.machine
    last.value = next.step
    if (next.step.ok) {
      // Leaving the picker clears a refusal it showed.
      if (next.step.to === 'closed') notice.value = null
      for (const effect of next.step.effects) carryOut(effect)
    }
    return next.step
  }

  const unsubscribe = deps.bridge.onModeTransition((transition) => {
    if (transition.role === 'source') dispatch({ type: 'interrupt' })
  })
  if (getCurrentScope() !== undefined) onScopeDispose(unsubscribe)

  return {
    machine,
    state: computed(() => machine.value.state),
    rows: computed(() => pickerRows(deps.mines())),
    notice,
    last,
    dispatch,
    worktree,
    adopting,
    answerWorktree: (accept) => void answerWorktree(accept)
  }
}

/** The menu and the picker over the page's own `window.api` (R13: `window.api` is read in composables only). */
export function useWindowMinePicker(deps: Omit<MinePickerDeps, 'bridge'>): MinePickerPart {
  return useMinePicker({
    ...deps,
    bridge: {
      declareMine: () => window.api.declareMine(),
      declareMainProject: () => window.api.declareMainProject(),
      moveToMode: (params) => window.api.moveToMode(params),
      onModeTransition: (handler) => window.api.onModeTransition(handler)
    }
  })
}
