/*
 * The tooltip card every hover tooltip shares (#635), `molecules/tooltip` in the design: a raised
 * card beside its target that appears 300ms after the pointer arrives and at once on keyboard
 * focus, and goes on leave, blur, press or Esc. It holds a title and rows of facts, never a
 * control and never information found nowhere else. This decides where the card goes; the card
 * component draws it, and whoever owns the target decides when.
 *
 * The card is `position: fixed`, so everything here is in window pixels.
 */

/** How long the pointer rests on a target before its tooltip shows (`--dur-tip-delay`). */
export const TIP_DELAY_MS = 300

/** The distance between the card and its target: hoverTip's default `gap`. */
export const TIP_GAP = 8

export type TipSide = 'top' | 'bottom' | 'left' | 'right'
export type TipAlign = 'start' | 'center' | 'end'

/** A box in window pixels, as getBoundingClientRect() gives it. */
export interface TipRect {
  left: number
  top: number
  width: number
  height: number
}

export interface TipSize {
  width: number
  height: number
}

export interface TipPlacement {
  left: number
  top: number
  /** The side the card ended on, after any flip: it rises 6px from the far side of it. */
  side: TipSide
}

export interface TipOptions {
  side?: TipSide
  align?: TipAlign
  gap?: number
}

/** One fact on the card: its label, and the value set in the ink the design gives `b`. */
export interface TipRow {
  label: string
  value: string
  /** A row said as a warning (`--warn`): the map's "Not enterable" (screens/map.md). */
  tone?: 'warn'
}

const OPPOSITE: Record<TipSide, TipSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left'
}

function sideOrigin(target: TipRect, tip: TipSize, side: TipSide, align: TipAlign, gap: number) {
  const across = (start: number, length: number, size: number): number =>
    align === 'start'
      ? start
      : align === 'end'
        ? start + length - size
        : start + length / 2 - size / 2
  switch (side) {
    case 'top':
      return {
        left: across(target.left, target.width, tip.width),
        top: target.top - gap - tip.height
      }
    case 'bottom':
      return {
        left: across(target.left, target.width, tip.width),
        top: target.top + target.height + gap
      }
    case 'left':
      return {
        left: target.left - gap - tip.width,
        top: across(target.top, target.height, tip.height)
      }
    case 'right':
      return {
        left: target.left + target.width + gap,
        top: across(target.top, target.height, tip.height)
      }
  }
}

function fits(origin: { left: number; top: number }, tip: TipSize, view: TipSize): boolean {
  return (
    origin.left >= 0 &&
    origin.top >= 0 &&
    origin.left + tip.width <= view.width &&
    origin.top + tip.height <= view.height
  )
}

// One axis, held between the window's edges. A card bigger than the window keeps its near edge,
// so the first line, the one that names what it describes, is the part that survives.
const hold = (value: number, size: number, room: number): number =>
  Math.max(0, Math.min(value, room - size))

/**
 * Where the card goes: on the side asked for, flipped to the opposite side when that one leaves
 * the window and the opposite one does not, then held inside the window on both axes.
 */
export function placeTip(
  target: TipRect,
  tip: TipSize,
  view: TipSize,
  { side = 'top', align = 'center', gap = TIP_GAP }: TipOptions = {}
): TipPlacement {
  let chosen = side
  let origin = sideOrigin(target, tip, side, align, gap)
  const onAxis = (o: { left: number; top: number }, s: TipSide): boolean =>
    s === 'top' || s === 'bottom'
      ? o.top >= 0 && o.top + tip.height <= view.height
      : o.left >= 0 && o.left + tip.width <= view.width
  if (!onAxis(origin, side)) {
    const other = sideOrigin(target, tip, OPPOSITE[side], align, gap)
    if (onAxis(other, OPPOSITE[side]) || fits(other, tip, view)) {
      chosen = OPPOSITE[side]
      origin = other
    }
  }
  return {
    left: hold(origin.left, tip.width, view.width),
    top: hold(origin.top, tip.height, view.height),
    side: chosen
  }
}
