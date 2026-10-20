import { describe, expect, it } from 'vitest'
import { MODE_MOTION_MS, transitionHalf, VETA_PART_STAGGER_MS } from './transitionMotion'

const ANIMATED = new Set(['opacity', 'x', 'y'])

describe('mode transition halves (07 S27.02; DS motion.md "Veta → Panel", "Panel → Veta")', () => {
  it('[US-VETA-009.AC01, US-VETA-009.AC02, NFR-PERF-01] the Veta and Panel halves animate only transform and opacity with the S27.02 distances, M of 270 ms and 30 ms between Veta parts', () => {
    expect(MODE_MOTION_MS).toBe(270)
    expect(VETA_PART_STAGGER_MS).toBe(30)

    // Veta → Panel, the Panel docked right: the Veta parts leave together, 64 px toward the dock side and 24 px up;
    // the dock comes in from 56 px toward the edge.
    const vetaOut = transitionHalf({ from: 'veta', to: 'panel', role: 'source' }, 'right', 3)
    expect(vetaOut).toEqual(
      [0, 1, 2].map(() => ({
        part: 'veta-part',
        delayMs: 0,
        durationMs: 270,
        keyframes: { opacity: [1, 0], x: [0, 64], y: [0, -24] }
      }))
    )
    const dockIn = transitionHalf({ from: 'veta', to: 'panel', role: 'target' }, 'right', 3)
    expect(dockIn).toEqual([
      {
        part: 'panel-dock',
        delayMs: 0,
        durationMs: 270,
        keyframes: { opacity: [0, 1], x: [56, 0], y: [0, 0] }
      }
    ])

    // Panel → Veta, the Panel docked left: the dock leaves sliding 56 px toward the edge; the Veta parts come in from
    // 56 px on the dock side and 24 px above, 30 ms apart.
    const dockOut = transitionHalf({ from: 'panel', to: 'veta', role: 'source' }, 'left', 2)
    expect(dockOut).toEqual([
      {
        part: 'panel-dock',
        delayMs: 0,
        durationMs: 270,
        keyframes: { opacity: [1, 0], x: [0, -56], y: [0, 0] }
      }
    ])
    const vetaIn = transitionHalf({ from: 'panel', to: 'veta', role: 'target' }, 'left', 2)
    expect(vetaIn).toEqual(
      [0, 30].map((delayMs) => ({
        part: 'veta-part',
        delayMs,
        durationMs: 270,
        keyframes: { opacity: [0, 1], x: [-56, 0], y: [-24, 0] }
      }))
    )

    // A dock on the top or bottom edge moves on y.
    expect(
      transitionHalf({ from: 'panel', to: 'veta', role: 'source' }, 'bottom', 1)[0]!.keyframes
    ).toEqual({
      opacity: [1, 0],
      x: [0, 0],
      y: [0, 56]
    })

    // Only transform (x, y) and opacity are ever animated, never width, height, top or left.
    for (const track of [...vetaOut, ...dockIn, ...dockOut, ...vetaIn]) {
      for (const key of Object.keys(track.keyframes)) expect(ANIMATED.has(key), key).toBe(true)
    }
  })
})
