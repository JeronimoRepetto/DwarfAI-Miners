/*
 * 07 machine 22, the grip menu and the mine picker (US-VETA-003, US-LAUNCH-007, US-VETA-010; UC-046; ISSUE-288).
 * Pure: no DOM, no clock, no `window.api`. The Veta renderer feeds it what the person did and what UI main answered,
 * and carries out the effects each step names.
 *
 * - The menu (`menu-open`) opens the same from a grip click that did not drag (S22.01) and from a right-click, Enter or
 *   Space (S22.02). Its items come from the build's modes: "Open Panel", "Open Valle" only once Valle is built (BR-19,
 *   ADR-034 item 2; 07 §24 I-40), "New dwarf in…" with its ▸ hint, a rule, "Hide window"; never "Mute sounds"
 *   (NFR-SND-03).
 * - The picker opens listing every live mine (S22.07), or empty when there is none, from the menu or from the
 *   first-run entrance "+" (S22.08). An enterable mine picked raises the Add panel at it (S22.09; 07 §24 I-39: an
 *   unenterable one is never picked). "Add a mine" opens the OS folder picker (S22.10): a cancel goes back to the
 *   picker it came from (S22.11); a folder picked is declared (S22.12) and a mine ready hands off to the Panel on it,
 *   never opening the Add panel (S22.13, S22.14 for a worktree folded into its main project); a refusal goes back to
 *   the picker (S22.15).
 * - Esc or an outside click closes an overlay and gives the focus back to what opened it (S22.03, S22.16); a drag, a
 *   mode change or the window hidden closes it silently (S22.17). A cue playing is no transition (S22.19).
 *
 * A step 07 does not list is rejected and the machine is held.
 */
import { t, type BuiltMode, type MineId } from '@dwarfai/contracts'
import type { IconName } from '../icon/iconGrids'

export type GripMenuState =
  'closed' | 'menu-open' | 'picker-open' | 'picker-empty' | 'choosing-folder' | 'declaring'

export type GripMenuItemId = 'open-panel' | 'open-valle' | 'new-dwarf' | 'hide'

/** One row of the menu: an item, or the rule before "Hide window". */
export type GripMenuEntry =
  | {
      readonly kind: 'item'
      readonly id: GripMenuItemId
      readonly label: string
      readonly icon: IconName
      readonly hint?: string
    }
  | { readonly kind: 'rule' }

/** What opened the overlay, and so takes the focus back when it closes (S22.03, S22.16). */
export type Opener = 'grip' | 'entrance'

type PickerState = 'picker-open' | 'picker-empty'

export interface GripMenu {
  readonly state: GripMenuState
  readonly opener: Opener
  /** The picker the folder flow came from, to go back to (S22.11, S22.15); `null` outside it. */
  readonly back: PickerState | null
}

export interface GripMenuContext {
  /** How many live mines exist (S22.07 guard). */
  readonly liveMines: number
  /** The modes this build contains (`builtModesOf`; S22.05 guard). */
  readonly built: readonly BuiltMode[]
}

export type GripMenuEvent =
  /** A grip press released: `dragging` when it became a drag (S21.05, S21.06). */
  | { readonly type: 'grip-click'; readonly dragging: boolean }
  /** A right-click, or Enter or Space on the focused grip. */
  | { readonly type: 'grip-open' }
  /** Esc, or a click outside the overlay. */
  | { readonly type: 'dismiss' }
  | { readonly type: 'choose'; readonly item: GripMenuItemId }
  /** The first-run entrance "+" (S20.13). */
  | { readonly type: 'entrance' }
  | { readonly type: 'pick-mine'; readonly mineId: MineId; readonly enterable: boolean }
  | { readonly type: 'add-mine' }
  | { readonly type: 'folder-cancelled' }
  | { readonly type: 'folder-picked' }
  /** `mines.declare` answered a mine: a new one or an existing one (`worktree: false`), or a worktree's main project. */
  | { readonly type: 'declared'; readonly mineId: MineId; readonly worktree: boolean }
  /** `not-a-folder`, `invalid-path`, or the Host out of reach. */
  | { readonly type: 'declare-failed' }
  /** A drag started, the mode changed or the window was hidden. */
  | { readonly type: 'interrupt' }
  /** Typing in the search, or an arrow key in the picker. */
  | { readonly type: 'filter' }
  /** An attention cue or the interface click played. */
  | { readonly type: 'cue' }

export type GripMenuEffect =
  /** A-N13 `moveToMode` (machine 27). */
  | { readonly kind: 'move'; readonly mode: 'panel' | 'valle' | 'hidden'; readonly mineId?: MineId }
  | { readonly kind: 'focus'; readonly target: Opener }
  /** The Add panel rises aimed at the mine (S24.03, ISSUE-290). */
  | { readonly kind: 'add-panel'; readonly mineId: MineId }
  /** A-30 `declareMine`: UI main's folder picker, then `mines.declare`. */
  | { readonly kind: 'pick-folder' }

export type GripMenuStep =
  | {
      readonly ok: true
      /** The 07 transition id. */
      readonly id: string
      readonly from: GripMenuState
      readonly to: GripMenuState
      readonly effects: readonly GripMenuEffect[]
    }
  | { readonly ok: false; readonly from: GripMenuState; readonly event: GripMenuEvent['type'] }

export const CLOSED_GRIP_MENU: GripMenu = { state: 'closed', opener: 'grip', back: null }

/** The menu's rows for a build: Open Valle only when Valle is built (hidden until built, BR-19). */
export function gripMenuEntries(built: readonly BuiltMode[]): GripMenuEntry[] {
  const entries: GripMenuEntry[] = [
    { kind: 'item', id: 'open-panel', label: t('veta.menu.openPanel'), icon: 'promote' }
  ]
  if (built.includes('valle')) {
    entries.push({ kind: 'item', id: 'open-valle', label: t('veta.menu.openValle'), icon: 'valle' })
  }
  entries.push(
    {
      kind: 'item',
      id: 'new-dwarf',
      label: t('veta.menu.newDwarf'),
      icon: 'add',
      hint: t('veta.menu.newDwarf.hint')
    },
    { kind: 'rule' },
    { kind: 'item', id: 'hide', label: t('veta.menu.hide'), icon: 'close' }
  )
  return entries
}

interface Next {
  readonly id: string
  readonly to: GripMenu
  readonly effects?: readonly GripMenuEffect[]
}

const isPicker = (state: GripMenuState): state is PickerState =>
  state === 'picker-open' || state === 'picker-empty'

const closed = (machine: GripMenu): GripMenu => ({
  state: 'closed',
  opener: machine.opener,
  back: null
})

/** The 07 transition an event takes from a machine, or `null` when 07 lists none. */
function transition(
  machine: GripMenu,
  event: GripMenuEvent,
  context: GripMenuContext
): Next | null {
  const { state } = machine
  switch (event.type) {
    case 'grip-click':
      if (state !== 'closed' || event.dragging) return null
      return { id: 'S22.01', to: { state: 'menu-open', opener: 'grip', back: null } }
    case 'grip-open':
      if (state !== 'closed') return null
      return { id: 'S22.02', to: { state: 'menu-open', opener: 'grip', back: null } }
    case 'entrance':
      if (state !== 'closed') return null
      return { id: 'S22.08', to: { state: 'picker-empty', opener: 'entrance', back: null } }
    case 'dismiss':
      if (state === 'menu-open') {
        return { id: 'S22.03', to: closed(machine), effects: [{ kind: 'focus', target: 'grip' }] }
      }
      if (isPicker(state)) {
        return {
          id: 'S22.16',
          to: closed(machine),
          effects: [{ kind: 'focus', target: machine.opener }]
        }
      }
      return null
    case 'choose':
      if (state !== 'menu-open') return null
      switch (event.item) {
        case 'open-panel':
          return { id: 'S22.04', to: closed(machine), effects: [{ kind: 'move', mode: 'panel' }] }
        case 'open-valle':
          if (!context.built.includes('valle')) return null
          return { id: 'S22.05', to: closed(machine), effects: [{ kind: 'move', mode: 'valle' }] }
        case 'hide':
          return { id: 'S22.06', to: closed(machine), effects: [{ kind: 'move', mode: 'hidden' }] }
        case 'new-dwarf':
          return context.liveMines > 0
            ? { id: 'S22.07', to: { ...machine, state: 'picker-open' } }
            : { id: 'S22.08', to: { ...machine, state: 'picker-empty' } }
      }
      return null
    case 'pick-mine':
      if (state !== 'picker-open' || !event.enterable) return null
      return {
        id: 'S22.09',
        to: closed(machine),
        effects: [{ kind: 'add-panel', mineId: event.mineId }]
      }
    case 'add-mine':
      if (!isPicker(state)) return null
      return {
        id: 'S22.10',
        to: { ...machine, state: 'choosing-folder', back: state },
        effects: [{ kind: 'pick-folder' }]
      }
    case 'folder-cancelled':
      if (state !== 'choosing-folder' || machine.back === null) return null
      return { id: 'S22.11', to: { ...machine, state: machine.back, back: null } }
    case 'folder-picked':
      if (state !== 'choosing-folder') return null
      return { id: 'S22.12', to: { ...machine, state: 'declaring' } }
    case 'declared':
      if (state !== 'declaring') return null
      return {
        id: event.worktree ? 'S22.14' : 'S22.13',
        to: closed(machine),
        effects: [{ kind: 'move', mode: 'panel', mineId: event.mineId }]
      }
    case 'declare-failed':
      if (state !== 'declaring' || machine.back === null) return null
      return { id: 'S22.15', to: { ...machine, state: machine.back, back: null } }
    case 'interrupt':
      if (state !== 'menu-open' && !isPicker(state)) return null
      return { id: 'S22.17', to: closed(machine) }
    case 'filter':
      if (state !== 'picker-open') return null
      return { id: 'S22.18', to: machine }
    case 'cue':
      // No transition: no mute item exists; cues stop only from Settings › Sound.
      if (state !== 'menu-open') return null
      return { id: 'S22.19', to: machine }
  }
}

/** One step of machine 22: the next machine and the step taken, or the machine held and the step refused. */
export function stepGripMenu(
  machine: GripMenu,
  event: GripMenuEvent,
  context: GripMenuContext
): { machine: GripMenu; step: GripMenuStep } {
  const next = transition(machine, event, context)
  if (next === null) {
    return { machine, step: { ok: false, from: machine.state, event: event.type } }
  }
  return {
    machine: next.to,
    step: {
      ok: true,
      id: next.id,
      from: machine.state,
      to: next.to.state,
      effects: next.effects ?? []
    }
  }
}
