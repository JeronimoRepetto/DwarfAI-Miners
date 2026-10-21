import { describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD_PX,
  IDLE_GESTURE,
  snapRect,
  stepGesture,
  type GestureInput,
  type GestureState
} from './dockGesture'

/**
 * Machine 21 (07, V2 Veta dock and drag), the renderer's half: a press on the grip, the 5 px threshold (NFR-TIM-13),
 * the drag and its snap preview, the release, and every way a drag is cancelled. UI main's half (where it lands, what
 * is saved) is `ui-main/window/domain/vetaPlacement.test.ts`.
 */
const SURFACE = { width: 2560, height: 1392 }
const at = (x: number, y: number) => ({ screen: { x, y }, client: { x, y }, surface: SURFACE })

function run(inputs: readonly GestureInput[], from: GestureState = IDLE_GESTURE) {
  let state = from
  const effects: string[] = []
  for (const input of inputs) {
    const step = stepGesture(state, input)
    state = step.state
    effects.push(step.effect.kind)
  }
  return { state, effects }
}

describe('machine 21 diagram conformance (renderer)', () => {
  it('[US-VETA-002.AC01, S21.06, S21.07, NFR-TIM-13] a drag starts at 5 px of travel with a snap preview on the nearest edge', () => {
    expect(DRAG_THRESHOLD_PX).toBe(5)
    // Pressed on the grip (S21.04): nothing moves yet, under 5 px of travel in any direction.
    const pressed = run([
      { type: 'press', ...at(1200, 1360) },
      { type: 'move', ...at(1204, 1360) },
      { type: 'move', ...at(1203, 1363) }
    ])
    expect(pressed.state.phase).toBe('pressed')
    expect(pressed.effects).toEqual(['none', 'none', 'none'])
    // 5 px: the drag starts (S21.06), UI main gives it the drag surface, and the preview marks the nearest edge.
    const started = run([{ type: 'move', ...at(1205, 1360) }], pressed.state)
    expect(started.effects).toEqual(['drag-start'])
    expect(started.state).toMatchObject({ phase: 'dragging', preview: 'bottom' })
    // The strip follows and the preview moves to the edge now nearest (S21.07).
    const moved = run(
      [
        { type: 'surface-ready' },
        { type: 'move', ...at(30, 700) },
        { type: 'move', ...at(1280, 12) }
      ],
      started.state
    )
    expect(moved.effects).toEqual(['none', 'none', 'none'])
    expect(moved.state).toMatchObject({
      phase: 'dragging',
      preview: 'top',
      pointer: { x: 1280, y: 12 }
    })
    // The pointer leaves the drag surface onto another display: one drag-start moves the surface there, once per
    // crossing, never per frame.
    const crossing = run(
      [
        {
          type: 'move',
          screen: { x: 2700, y: 600 },
          client: { x: 2700, y: 600 },
          surface: SURFACE
        },
        {
          type: 'move',
          screen: { x: 2720, y: 600 },
          client: { x: 2720, y: 600 },
          surface: SURFACE
        },
        { type: 'surface-ready' },
        { type: 'move', screen: { x: 2730, y: 600 }, client: { x: 170, y: 243 }, surface: SURFACE }
      ],
      moved.state
    )
    expect(crossing.effects).toEqual(['drag-start', 'none', 'none', 'none'])
    // Released: UI main lands it where the pointer is (S21.08).
    const released = run([{ type: 'release', ...at(2730, 600) }], crossing.state)
    expect(released.effects).toEqual(['drag-end'])
    expect(released.state.phase).toBe('landing')
    expect(run([{ type: 'landed' }], released.state).state).toEqual(IDLE_GESTURE)
  })

  it('[US-VETA-002.AC01, US-VETA-002.AC08] the snap preview is the island where it would land: on the nearest edge, centred on the pointer, clamped, vertical on a side edge', () => {
    const island = { length: 480, thickness: 72 }
    expect(snapRect('bottom', { x: 1000, y: 1350 }, SURFACE, island)).toEqual({
      x: 1000 - 240,
      y: 1392 - 72,
      width: 480,
      height: 72
    })
    expect(snapRect('top', { x: 2550, y: 3 }, SURFACE, island)).toEqual({
      x: 2560 - 480,
      y: 0,
      width: 480,
      height: 72
    })
    expect(snapRect('left', { x: 4, y: 100 }, SURFACE, island)).toEqual({
      x: 0,
      y: 0,
      width: 72,
      height: 480
    })
    expect(snapRect('right', { x: 2555, y: 700 }, SURFACE, island)).toEqual({
      x: 2560 - 72,
      y: 700 - 240,
      width: 72,
      height: 480
    })
  })

  it('[US-VETA-002.AC07, S21.05] a release under 5 px starts no drag and is a click', () => {
    const click = run([
      { type: 'press', ...at(1200, 1360) },
      { type: 'move', ...at(1203, 1362) },
      { type: 'release', ...at(1203, 1362) }
    ])
    expect(click.effects).toEqual(['none', 'none', 'click'])
    expect(click.state).toEqual(IDLE_GESTURE)
    // No press, no drag: a stray move or release does nothing.
    expect(
      run([
        { type: 'move', ...at(0, 0) },
        { type: 'release', ...at(0, 0) }
      ]).effects
    ).toEqual(['none', 'none'])
  })

  it('[US-VETA-002.AC03, S21.10, FM-112] a cancelled drag, lost capture, hiding or a mode change returns Veta to its previous place and saves nothing', () => {
    const dragging = run([
      { type: 'press', ...at(1200, 1360) },
      { type: 'move', ...at(1300, 1300) }
    ]).state
    expect(dragging.phase).toBe('dragging')
    // Each cancel (pointercancel, lost capture, the window going hidden, a mode change, a display changing under the
    // drag) puts the island back where it was: never a drag-end, so nothing is landed or saved.
    for (const cause of [
      'pointer-cancel',
      'lost-capture',
      'hidden',
      'mode-change',
      'display-change'
    ] as const) {
      const cancelled = run([{ type: 'cancel', cause }], dragging)
      expect(cancelled.effects, cause).toEqual(['restore'])
      expect(cancelled.state, cause).toEqual(IDLE_GESTURE)
      // A release after the cancel is not a landing either.
      expect(run([{ type: 'release', ...at(5, 5) }], cancelled.state).effects, cause).toEqual([
        'none'
      ])
    }
    // Cancelled while only pressed: nothing had moved, so nothing is put back.
    const pressed = run([{ type: 'press', ...at(1200, 1360) }]).state
    expect(run([{ type: 'cancel', cause: 'lost-capture' }], pressed)).toEqual({
      state: IDLE_GESTURE,
      effects: ['none']
    })
    // The capture is released by the release itself: once landing, that is not a cancel.
    const landing = run([{ type: 'release', ...at(1300, 1300) }], dragging).state
    expect(run([{ type: 'cancel', cause: 'lost-capture' }], landing).state).toEqual(landing)
  })
})
