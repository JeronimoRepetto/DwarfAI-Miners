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
 *   project folds into that project's mine through A-31 `declareMainProject` (S22.14). A refusal, or UI main out of
 *   reach, goes back to the picker with the Mines page's own words for it (S22.15, US-MINES-004): the reason UI main
 *   answered (`declareFailureNotice`, the Mines page's), or the Mines page's line for a bridge that never answered.
 * - Esc or an outside click gives the focus back to what opened the overlay (S22.03, S22.16).
 *
 * The picker lists every live mine (`mines`, the life state's read model), those with no chamber included. The bridge,
 * the mines and the focus and Add panel hooks are injected (the house idiom over `vi.mock`).
 */
import type { BuiltMode, MineId, MoveToModeParams } from '@dwarfai/contracts'
import { computed, shallowRef, type ComputedRef, type Ref } from 'vue'
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
import type { MineDeclareResult } from '../types'

/**
 * The Mines page's line when the declare channel itself could not be reached (`useProjectBrowse`'s `UNREACHABLE`,
 * #85): S22.15 shows the Mines page's own error, and this is its text for that case.
 */
const UNREACHABLE = 'DwarfAI-Miners could not open the folder picker.'

/** The seam A members the menu and the picker use (14 §2.1 A-30, A-31; §2.2 A-N13). */
export interface MinePickerBridge {
  declareMine(): Promise<MineDeclareResult>
  declareMainProject(): Promise<MineDeclareResult>
  moveToMode(params: MoveToModeParams): Promise<unknown>
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
}

export function useMinePicker(deps: MinePickerDeps): MinePickerPart {
  const machine = shallowRef<GripMenu>(CLOSED_GRIP_MENU)
  const notice = shallowRef<string | null>(null)
  const last = shallowRef<GripMenuStep | null>(null)

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
      fail(UNREACHABLE)
      return
    }
    if (answer.outcome === 'cancelled') {
      dispatch({ type: 'folder-cancelled' })
      return
    }
    dispatch({ type: 'folder-picked' })
    let worktree = false
    if (answer.outcome === 'worktree-of') {
      worktree = true
      try {
        answer = await deps.bridge.declareMainProject()
      } catch {
        fail(UNREACHABLE)
        return
      }
    }
    if (answer.outcome === 'added' && answer.mineId !== undefined) {
      dispatch({ type: 'declared', mineId: answer.mineId as MineId, worktree })
      return
    }
    fail(declareFailureNotice({ ...answer, outcome: 'failed' }))
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

  return {
    machine,
    state: computed(() => machine.value.state),
    rows: computed(() => pickerRows(deps.mines())),
    notice,
    last,
    dispatch
  }
}

/** The menu and the picker over the page's own `window.api` (R13: `window.api` is read in composables only). */
export function useWindowMinePicker(deps: Omit<MinePickerDeps, 'bridge'>): MinePickerPart {
  return useMinePicker({
    ...deps,
    bridge: {
      declareMine: () => window.api.declareMine(),
      declareMainProject: () => window.api.declareMainProject(),
      moveToMode: (params) => window.api.moveToMode(params)
    }
  })
}
