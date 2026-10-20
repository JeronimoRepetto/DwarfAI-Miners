/*
 * The motion table of each half of a mode transition run (ISSUE-284; 07 S27.02; ADR-025 item 3;
 * `DS/docs/motion.md` "Veta → Panel", "Panel → Veta"). Pure: each half is a list of tracks, one
 * per moving part, and each track animates only `opacity` and the `x`/`y` transform shortcuts —
 * never width, height, top or left (NFR-PERF-01) — from the run's shared `t0`.
 *
 * - Veta → Panel: the Veta parts fade out together, 64 px toward the dock side and 24 px up; the
 *   dock fades in from 56 px toward the edge.
 * - Panel → Veta: the dock fades out sliding 56 px toward the edge; the Veta parts fade in from
 *   56 px on the dock side and 24 px above, 30 ms apart.
 *
 * "The dock side" and "the edge" are the screen edge the Panel is docked to. A pair with no row
 * here (Valle's, EPIC-20; a hide or a restore) has no half to play: an empty list, which the
 * renderer settles at once.
 */
import type { WindowMode } from '@dwarfai/contracts'

/** S27.02: M, the length of each half. */
export const MODE_MOTION_MS = 270
/** S27.02: the Veta parts come in 30 ms apart. */
export const VETA_PART_STAGGER_MS = 30
/** S27.02: how far the Veta parts travel toward the dock side as they leave. */
const VETA_OUT_PX = 64
/** S27.02: how far the dock, and the Veta parts as they come in, travel from the edge. */
const DOCK_TRAVEL_PX = 56
/** S27.02: how far up the Veta parts leave, and from how far above they come in. */
const VETA_RISE_PX = 24

/** The screen edge the Panel is docked to (14 §2.1 `PanelLayout.edge`). */
export type DockSide = 'left' | 'right' | 'top' | 'bottom'

/** One moving part of a half: what it is, when it starts after `t0`, how long, and its keyframes. */
export interface MotionTrack {
  part: 'veta-part' | 'panel-dock'
  delayMs: number
  durationMs: number
  keyframes: { opacity: [number, number]; x: [number, number]; y: [number, number] }
}

/** The unit step toward `side`, on screen axes (y grows downward). */
function toward(side: DockSide): { x: number; y: number } {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
  }
}

/** `0` written as `0`, never `-0`, so a keyframe reads as the table writes it. */
const px = (n: number): number => (n === 0 ? 0 : n)

function track(
  part: MotionTrack['part'],
  delayMs: number,
  opacity: [number, number],
  x: [number, number],
  y: [number, number]
): MotionTrack {
  return {
    part,
    delayMs,
    durationMs: MODE_MOTION_MS,
    keyframes: { opacity, x: [px(x[0]), px(x[1])], y: [px(y[0]), px(y[1])] }
  }
}

/**
 * The half `role` plays in the run `from` → `to`. `dock` is the Panel's docking edge; `vetaParts`
 * is how many Veta parts the Veta renderer draws (each gets its own track).
 */
export function transitionHalf(
  t: { from: WindowMode; to: WindowMode; role: 'source' | 'target' },
  dock: DockSide,
  vetaParts: number
): MotionTrack[] {
  const d = toward(dock)
  const parts = Array.from({ length: Math.max(0, vetaParts) }, (_, i) => i)
  if (t.from === 'veta' && t.to === 'panel') {
    if (t.role === 'source') {
      return parts.map(() =>
        track('veta-part', 0, [1, 0], [0, d.x * VETA_OUT_PX], [0, d.y * VETA_OUT_PX - VETA_RISE_PX])
      )
    }
    return [track('panel-dock', 0, [0, 1], [d.x * DOCK_TRAVEL_PX, 0], [d.y * DOCK_TRAVEL_PX, 0])]
  }
  if (t.from === 'panel' && t.to === 'veta') {
    if (t.role === 'source') {
      return [track('panel-dock', 0, [1, 0], [0, d.x * DOCK_TRAVEL_PX], [0, d.y * DOCK_TRAVEL_PX])]
    }
    return parts.map((i) =>
      track(
        'veta-part',
        i * VETA_PART_STAGGER_MS,
        [0, 1],
        [d.x * DOCK_TRAVEL_PX, 0],
        [d.y * DOCK_TRAVEL_PX - VETA_RISE_PX, 0]
      )
    )
  }
  return []
}
