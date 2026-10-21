/*
 * 07 machine 23, a Veta chamber's hover and its mine tab (US-VETA-004; UC-047; ISSUE-289). Pure: no DOM, no clock, no
 * `window.api`. The Veta renderer feeds it where the pointer and the keyboard focus are, and carries out the effects
 * each step names.
 *
 * - The tab rises over the chamber the pointer is on, or else the one holding keyboard focus (`aimOf`): a drawn chamber
 *   only, never during a drag (S23.01). Aiming at another chamber folds the first tab as the other rises, so there is
 *   never more than one (S23.02); aiming at none folds it with no other effect (S23.03).
 * - "▢" moves to the Panel on that mine (S23.04, A-N13 `moveToMode`); "+" raises the Add panel aimed at it, with no
 *   picker (S23.05 → S24.03, ISSUE-290). A click on the chamber body is nothing (S23.06): the chamber is a container.
 * - The tab goes with its chamber when the chamber closes, folds into "+N" or its mine is removed (S23.07), and closes
 *   when a drag starts (S23.08). With no chamber drawn (`first-run`, `no-sessions`) nothing rises (S23.09).
 *
 * A step 07 does not list is rejected and the machine is held.
 *
 * The window always holds the band the tab rises into (07 §24 I-22; ADR-025 item 2), so a hover never resizes it:
 * `tabBand` works that room out from the tabs' boxes, for UI main to grow the window by (`layoutVeta {overlay}`, N-25).
 */
import type { MineId, VetaDock } from '@dwarfai/contracts'
import type { VetaLifeState } from './lifeState'

export type MineTabState = 'plain' | 'risen'

export interface MineTab {
  readonly state: MineTabState
  /** The chamber whose tab is risen; `null` while `plain`. */
  readonly mineId: MineId | null
}

export interface MineTabContext {
  /** Veta's life state (07 machine 20); `null` before the Host has answered. */
  readonly life: VetaLifeState | null
  /** A grip drag is under way (07 machine 21). */
  readonly dragging: boolean
  /** The chambers drawn, not folded into "+N". */
  readonly drawn: readonly MineId[]
}

export type MineTabEvent =
  /** The chamber the pointer or the keyboard focus is on (`aimOf`), or `null` for none. */
  | { readonly type: 'aim'; readonly mineId: MineId | null }
  /** "▢": click, Enter or Space. */
  | { readonly type: 'open' }
  /** "+". */
  | { readonly type: 'add' }
  /** A click on the chamber body, not a dwarf, not a tab. */
  | { readonly type: 'body-click' }
  /** The drawn chambers changed (`context.drawn`): one closed, folded into "+N", or its mine was removed. */
  | { readonly type: 'drawn' }
  /** A grip drag started (S21.06). */
  | { readonly type: 'drag-start' }

export type MineTabEffect =
  /** A-N13 `moveToMode` (machine 27): the Panel on this mine. */
  | { readonly kind: 'move'; readonly mode: 'panel'; readonly mineId: MineId }
  /** The Add panel rises aimed at this mine (S24.03, ISSUE-290). */
  | { readonly kind: 'add-panel'; readonly mineId: MineId }

export type MineTabStep =
  | {
      readonly ok: true
      /** The 07 transition id. */
      readonly id: string
      readonly from: MineTabState
      readonly to: MineTabState
      readonly effects: readonly MineTabEffect[]
    }
  | { readonly ok: false; readonly from: MineTabState; readonly event: MineTabEvent['type'] }

export const PLAIN_MINE_TAB: MineTab = { state: 'plain', mineId: null }

/** The chamber the tab rises over: the one under the pointer, else the one holding keyboard focus. */
export function aimOf(hovered: MineId | null, focused: MineId | null): MineId | null {
  return hovered ?? focused
}

interface Next {
  readonly id: string
  readonly to: MineTab
  readonly effects?: readonly MineTabEffect[]
}

const risenOn = (mineId: MineId): MineTab => ({ state: 'risen', mineId })

/** The 07 transition an event takes from a machine, or `null` when 07 lists none. */
function transition(machine: MineTab, event: MineTabEvent, context: MineTabContext): Next | null {
  const { state, mineId } = machine
  const chambers = context.life === 'all-idle' || context.life === 'sessions-working'
  switch (event.type) {
    case 'aim': {
      const target = event.mineId
      if (state === 'plain' && target !== null && !chambers) {
        return { id: 'S23.09', to: PLAIN_MINE_TAB }
      }
      if (target === null) return state === 'risen' ? { id: 'S23.03', to: PLAIN_MINE_TAB } : null
      if (target === mineId || context.dragging || !context.drawn.includes(target)) return null
      return { id: state === 'plain' ? 'S23.01' : 'S23.02', to: risenOn(target) }
    }
    case 'open':
      if (mineId === null) return null
      return {
        id: 'S23.04',
        to: PLAIN_MINE_TAB,
        effects: [{ kind: 'move', mode: 'panel', mineId }]
      }
    case 'add':
      if (mineId === null) return null
      return { id: 'S23.05', to: PLAIN_MINE_TAB, effects: [{ kind: 'add-panel', mineId }] }
    case 'body-click':
      return state === 'plain' ? { id: 'S23.06', to: PLAIN_MINE_TAB } : null
    case 'drawn':
      if (mineId === null || context.drawn.includes(mineId)) return null
      return { id: 'S23.07', to: PLAIN_MINE_TAB }
    case 'drag-start':
      return state === 'risen' ? { id: 'S23.08', to: PLAIN_MINE_TAB } : null
  }
}

/** One step of machine 23: the next machine, and the transition taken or the refusal. */
export function stepMineTab(
  machine: MineTab,
  event: MineTabEvent,
  context: MineTabContext
): { machine: MineTab; step: MineTabStep } {
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

/** A tab's box at its risen place, in the island's CSS pixels (its origin at the island's top-left corner). */
export interface TabBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The band the tabs rise into, as the room beside the island UI main grows the window by (`vetaOverlayFrame`): on the
 * screen side of the island, from its anchored end. Along the edge it reaches the farthest end of any tab (a long name
 * runs past the island), across it as far as the tabs stand out of the island. `null` when no tab is laid out.
 */
export function tabBand(
  dock: Pick<VetaDock, 'edge' | 'end'>,
  island: { width: number; height: number },
  tabs: readonly TabBox[]
): { width: number; height: number } | null {
  const laid = tabs.filter((tab) => tab.width > 0 && tab.height > 0)
  if (laid.length === 0) return null
  const vertical = dock.edge === 'left' || dock.edge === 'right'
  // Along the edge: x on a top or bottom edge, y on a side one.
  const start = Math.min(0, ...laid.map((tab) => (vertical ? tab.y : tab.x)))
  const length = vertical ? island.height : island.width
  const end = Math.max(
    length,
    ...laid.map((tab) => (vertical ? tab.y + tab.height : tab.x + tab.width))
  )
  const along = dock.end === 'end' ? length - start : end
  // Across it, on the screen side: beyond the island's far side from its edge.
  const thickness = vertical ? island.width : island.height
  const across =
    dock.edge === 'bottom'
      ? -Math.min(...laid.map((tab) => tab.y))
      : dock.edge === 'right'
        ? -Math.min(...laid.map((tab) => tab.x))
        : dock.edge === 'top'
          ? Math.max(...laid.map((tab) => tab.y + tab.height)) - thickness
          : Math.max(...laid.map((tab) => tab.x + tab.width)) - thickness
  if (across <= 0) return null
  return vertical ? { width: across, height: along } : { width: along, height: across }
}
