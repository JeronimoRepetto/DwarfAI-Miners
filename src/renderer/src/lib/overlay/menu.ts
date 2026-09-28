/*
 * The overflow menu's items and what they decide (#635), `molecules/menu` in the design: rows with
 * an optional icon and hint, rules between groups, a danger group last that always confirms. The
 * keys move over enabled items only and wrap at both ends; Home and End jump; the first enabled
 * item takes focus on opening. `placeFloating` is the design's placement for every floating card
 * (`DM.place` in its core.js): beside the anchor, flipped away from an edge it would crowd, and
 * clamped inside the viewport. The component draws; this decides.
 */
import type { IconName } from '../icon/iconGrids'

export interface MenuItem {
  label: string
  icon?: IconName
  /** A destructive item: kept below a rule, and it always opens a confirmation. */
  danger?: boolean
  disabled?: boolean
  /**
   * Why a disabled item cannot act, in the form "<action> · <reason>": a disabled item stays in
   * the menu, so the menu keeps one shape, and says why rather than hiding (molecules/menu).
   */
  title?: string
  /** A short fact at the row's far end, such as a count. */
  hint?: string
  /** A look forced without the pointer, as the UI kit's own states show it. */
  state?: 'hover'
}

export type MenuEntry = MenuItem | { separator: true }

export const isSeparator = (entry: MenuEntry): entry is { separator: true } => 'separator' in entry

const enabled = (entry: MenuEntry): boolean => !isSeparator(entry) && entry.disabled !== true

// Class order follows the kit's: the item, the danger variant, then the forced state.
export function menuItemClasses(item: MenuItem): string[] {
  const classes = ['dm-menu__item']
  if (item.danger) classes.push('dm-menu__item--danger')
  if (item.state) classes.push('is-' + item.state)
  return classes
}

/** The first item that can be picked, or undefined in a menu with none. */
export function firstEnabled(entries: readonly MenuEntry[]): number | undefined {
  const at = entries.findIndex(enabled)
  return at < 0 ? undefined : at
}

function lastEnabled(entries: readonly MenuEntry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (enabled(entries[i]!)) return i
  return undefined
}

/**
 * Where a key moves the focus from `from`: ↑/↓ to the previous or next enabled item, wrapping at
 * both ends; Home and End to the first and last. Undefined for any other key, and in a menu with
 * nothing to pick.
 */
export function menuKeyTarget(
  entries: readonly MenuEntry[],
  from: number,
  key: string
): number | undefined {
  if (firstEnabled(entries) === undefined) return undefined
  if (key === 'Home') return firstEnabled(entries)
  if (key === 'End') return lastEnabled(entries)
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0
  if (step === 0) return undefined
  const n = entries.length
  for (let i = 1; i <= n; i++) {
    const at = (((from + step * i) % n) + n) % n
    if (enabled(entries[at]!)) return at
  }
  return undefined
}

export interface AnchorBox {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PlaceOptions {
  side?: 'bottom' | 'top'
  align?: 'start' | 'center' | 'end'
  gap?: number
}

/** How near a floating card may come to the viewport's edge. */
const EDGE = 8

/**
 * The fixed position of a floating card beside its anchor (the design's `DM.place`): `gap` px off
 * the chosen side, lined up with the anchor's start, centre or end. A side that would bring the
 * card within 8px of the viewport's edge flips to the other side, and the result is clamped 8px
 * inside the viewport either way. A menu opens below its button, aligned to its end.
 */
export function placeFloating(
  anchor: AnchorBox,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { side = 'bottom', align = 'end', gap = 6 }: PlaceOptions = {}
): { left: number; top: number } {
  const below = anchor.bottom + gap
  const above = anchor.top - gap - size.height
  let top = side === 'bottom' ? below : above
  if (side === 'bottom' && below + size.height > viewport.height - EDGE) top = above
  if (side === 'top' && above < EDGE) top = below
  let left =
    align === 'start'
      ? anchor.left
      : align === 'center'
        ? (anchor.left + anchor.right) / 2 - size.width / 2
        : anchor.right - size.width
  left = Math.min(Math.max(left, EDGE), viewport.width - size.width - EDGE)
  top = Math.min(Math.max(top, EDGE), viewport.height - size.height - EDGE)
  return { left, top }
}
