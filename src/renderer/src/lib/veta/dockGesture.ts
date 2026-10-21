/*
 * The renderer's half of Veta's dock (07 machine 21; US-VETA-002; `DS/docs/screens/veta.md` Layout): a press on the
 * grip, the drag and its snap preview, the release, and every way a drag is cancelled. Pure: the composable
 * (`useVetaDock`) feeds it pointer facts and carries out the effect it answers.
 *
 * - `docked` → `pressed` on a press (S21.04); a release under 5 px of travel is a click (S21.05); 5 px or more is a
 *   drag (S21.06): UI main is asked for the drag surface (`layoutVeta{drag-start}`), the strip follows the pointer and a
 *   dashed preview marks the edge nearest it (S21.07). When the pointer leaves the drag surface (onto another display),
 *   one more `drag-start` moves the surface there; none is sent again until the surface is ready, so it is once per
 *   crossing, never per frame. A release lands it (`drag-end`, S21.08) and waits in `landing` for UI main's answer.
 * - Cancelled while dragging (pointercancel, lost capture, the window going hidden, a mode change, a display change
 *   under the drag; S21.10, FM-112): the island goes back where it was (`restore`) and nothing is landed or saved.
 * - The 5 px is NFR-TIM-13's shared drag threshold; no other drag in the renderer has its own.
 */
import type { VetaDock } from '@dwarfai/contracts'

/** NFR-TIM-13: a press becomes a drag only after this much pointer travel, in CSS pixels. */
export const DRAG_THRESHOLD_PX = 5

type Edge = VetaDock['edge']

export interface Point {
  readonly x: number
  readonly y: number
}

export type GestureState =
  | { readonly phase: 'docked' }
  | { readonly phase: 'pressed'; readonly start: Point }
  | {
      readonly phase: 'dragging'
      /** Where the press was, on the screen. */
      readonly start: Point
      /** Where the pointer is, on the screen. */
      readonly pointer: Point
      /** The edge of the drag surface nearest the pointer: where the dashed preview shows. */
      readonly preview: Edge
      /** A `drag-start` is on its way: the surface is moving, so no other is sent. */
      readonly crossing: boolean
    }
  | { readonly phase: 'landing' }

/** A pointer event's facts: screen position, position in the window, and the window's size. */
export interface PointerFacts {
  readonly screen: Point
  readonly client: Point
  readonly surface: { readonly width: number; readonly height: number }
}

/** What ends a drag without a release (S21.10, FM-112). */
export type CancelCause =
  'pointer-cancel' | 'lost-capture' | 'hidden' | 'mode-change' | 'display-change'

export type GestureInput =
  | ({ readonly type: 'press' } & PointerFacts)
  | ({ readonly type: 'move' } & PointerFacts)
  | ({ readonly type: 'release' } & PointerFacts)
  | { readonly type: 'cancel'; readonly cause: CancelCause }
  /** UI main answered a `drag-start`: the window is the drag surface now. */
  | { readonly type: 'surface-ready' }
  /** UI main answered the `drag-end`, applied or not. */
  | { readonly type: 'landed' }

export type GestureEffect =
  | { readonly kind: 'none' }
  /** A press released under the threshold: the grip's click (S21.05; its menu is ISSUE-288's). */
  | { readonly kind: 'click' }
  /** `layoutVeta{drag-start}` at this screen point. */
  | { readonly kind: 'drag-start'; readonly screen: Point }
  /** `layoutVeta{drag-end}` at this screen point. */
  | { readonly kind: 'drag-end'; readonly screen: Point }
  /** Back to the place before the press, nothing saved. */
  | { readonly kind: 'restore' }

export const IDLE_GESTURE: GestureState = { phase: 'docked' }

const NONE: GestureEffect = { kind: 'none' }

/** The edge of a `width` × `height` surface nearest a point in it (ties: bottom, top, left, right). */
export function nearestSurfaceEdge(
  point: Point,
  surface: { readonly width: number; readonly height: number }
): Edge {
  const distance: [Edge, number][] = [
    ['bottom', surface.height - point.y],
    ['top', point.y],
    ['left', point.x],
    ['right', surface.width - point.x]
  ]
  let best = distance[0]!
  for (const entry of distance) {
    if (Math.max(0, entry[1]) < Math.max(0, best[1])) best = entry
  }
  return best[0]
}

const travel = (from: Point, to: Point): number => Math.hypot(to.x - from.x, to.y - from.y)

const outside = (facts: PointerFacts): boolean =>
  facts.client.x < 0 ||
  facts.client.y < 0 ||
  facts.client.x >= facts.surface.width ||
  facts.client.y >= facts.surface.height

/** One step of the gesture: the next state and what the composable does about it. */
export function stepGesture(
  state: GestureState,
  input: GestureInput
): { state: GestureState; effect: GestureEffect } {
  switch (input.type) {
    case 'press':
      return state.phase === 'docked'
        ? { state: { phase: 'pressed', start: input.screen }, effect: NONE }
        : { state, effect: NONE }
    case 'move': {
      if (state.phase === 'pressed') {
        if (travel(state.start, input.screen) < DRAG_THRESHOLD_PX) return { state, effect: NONE }
        return {
          state: {
            phase: 'dragging',
            start: state.start,
            pointer: input.screen,
            preview: nearestSurfaceEdge(input.client, input.surface),
            crossing: true
          },
          effect: { kind: 'drag-start', screen: input.screen }
        }
      }
      if (state.phase !== 'dragging') return { state, effect: NONE }
      const crossed = !state.crossing && outside(input)
      return {
        state: {
          ...state,
          pointer: input.screen,
          preview: nearestSurfaceEdge(input.client, input.surface),
          crossing: state.crossing || crossed
        },
        effect: crossed ? { kind: 'drag-start', screen: input.screen } : NONE
      }
    }
    case 'release':
      if (state.phase === 'pressed') return { state: IDLE_GESTURE, effect: { kind: 'click' } }
      if (state.phase === 'dragging') {
        return { state: { phase: 'landing' }, effect: { kind: 'drag-end', screen: input.screen } }
      }
      return { state, effect: NONE }
    case 'cancel':
      if (state.phase === 'pressed') return { state: IDLE_GESTURE, effect: NONE }
      if (state.phase === 'dragging') return { state: IDLE_GESTURE, effect: { kind: 'restore' } }
      return { state, effect: NONE }
    case 'surface-ready':
      return state.phase === 'dragging'
        ? { state: { ...state, crossing: false }, effect: NONE }
        : { state, effect: NONE }
    case 'landed':
      return state.phase === 'landing'
        ? { state: IDLE_GESTURE, effect: NONE }
        : { state, effect: NONE }
  }
}

/**
 * Where the dashed snap preview shows (S21.07; `DS/docs/screens/veta.md` "`.dm-veta-snap`"): the island as it would
 * land on `edge` of the drag surface, centred on the pointer along that edge and clamped to the surface, vertical on a
 * side edge (US-VETA-002.AC08). In the surface's CSS pixels.
 */
export function snapRect(
  edge: Edge,
  pointer: Point,
  surface: { readonly width: number; readonly height: number },
  island: { readonly length: number; readonly thickness: number }
): { x: number; y: number; width: number; height: number } {
  const vertical = edge === 'left' || edge === 'right'
  const span = vertical ? surface.height : surface.width
  const centre = vertical ? pointer.y : pointer.x
  const along = Math.max(0, Math.min(Math.round(centre - island.length / 2), span - island.length))
  if (vertical) {
    const x = edge === 'left' ? 0 : surface.width - island.thickness
    return { x, y: along, width: island.thickness, height: island.length }
  }
  const y = edge === 'top' ? 0 : surface.height - island.thickness
  return { x: along, y, width: island.length, height: island.thickness }
}
