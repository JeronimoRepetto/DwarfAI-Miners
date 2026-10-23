import type { MineId } from '@dwarfai/contracts'
import type { PinSet } from './pins'

/*
 * 07 machine 38 `ValleEmptyState` (ISSUE-310; US-VALLE-014, US-VALLE-015; UC-063; ADR-024 item 4): what the chat zone
 * and the mosaic show when there is nothing to show. Pure reads of the pins and the mosaic order: no state of its own,
 * nothing stored, nothing written from an empty state.
 *
 * - The stack (Control room) is empty with no pin; the deck (Work front) is empty only with no pin at all, since pins
 *   of other mines are tabs too (07 §22.4 V-03). An open Add panel is a pin (S29.16), so it keeps both populated.
 * - The mosaic is empty with no column: only the add slot shows, and no text (07 §24 I-34: the package has no copy).
 */

export type StackState = 'stack-empty' | 'stack-populated'
export type DeckState = 'deck-empty' | 'deck-populated'
export type MosaicEmptyState = 'mosaic-empty' | 'mosaic-populated'

export interface EmptyStates {
  readonly stack: StackState
  readonly deck: DeckState
  readonly mosaic: MosaicEmptyState
}

/** `DS/docs/copy.md`, Pinned chat stack: shown in place of the lines (S38.01). */
export const STACK_EMPTY_TEXT = 'Click a dwarf, in any mine, to pin its chat here.'
/** `DS/docs/copy.md`, Chat deck: shown in place of the tabs and panes (S38.03). */
export const DECK_EMPTY_TEXT = 'No chats pinned. Click a dwarf in the mine to open one.'

/** The Control room's stack: empty with no pin (S38.01), populated with one or more (S38.02). */
export const stackState = (pins: Pick<PinSet, 'pins'>): StackState =>
  pins.pins.length === 0 ? 'stack-empty' : 'stack-populated'

/** The Work front's deck: empty only with no pin at all, pins of other mines being tabs too (S38.03, V-03). */
export const deckState = (pins: Pick<PinSet, 'pins'>): DeckState =>
  pins.pins.length === 0 ? 'deck-empty' : 'deck-populated'

/** The mosaic: empty with no column in the order (S38.05), populated with one or more (S38.06). */
export const mosaicState = (order: readonly MineId[]): MosaicEmptyState =>
  order.length === 0 ? 'mosaic-empty' : 'mosaic-populated'

/** The three empty states the pins and the mosaic order give (the `[*]` entries of machine 38). */
export const emptyStates = (pins: Pick<PinSet, 'pins'>, order: readonly MineId[]): EmptyStates => ({
  stack: stackState(pins),
  deck: deckState(pins),
  mosaic: mosaicState(order)
})

/** What happened, with how many pins or columns are left where it matters. */
export type EmptyInput =
  /** A pin removed (S29.11): ×, a middle click, Delete. */
  | { readonly kind: 'pin-removed'; readonly remaining: number }
  /** A dwarf clicked in the mosaic, or in the one mine shown (S29.03). */
  | { readonly kind: 'dwarf-clicked' }
  /** A column closed or removed (S32.03). */
  | { readonly kind: 'column-closed'; readonly remaining: number }
  /** A column added, or Reset preset finding mines with a crew (S32.05, S32.11, S32.14). */
  | { readonly kind: 'column-added' }

export type EmptySurface = 'stack' | 'deck' | 'mosaic'

export type EmptyStep =
  | { readonly ok: true; readonly id: string; readonly empty: boolean }
  | { readonly ok: false; readonly reason: 'not-listed' }

const IDS = {
  stack: { emptied: 'S38.01', filled: 'S38.02' },
  deck: { emptied: 'S38.03', filled: 'S38.04' },
  mosaic: { emptied: 'S38.05', filled: 'S38.06' }
} as const

/**
 * One transition of the table of machine 38, or `not-listed` (ADR-024): populated → empty when the last pin or column
 * goes, empty → populated when a dwarf is clicked or a column is added. Anything else is not a transition.
 */
export function stepEmptyState(
  surface: EmptySurface,
  empty: boolean,
  input: EmptyInput
): EmptyStep {
  const ids = IDS[surface]
  const emptying = surface === 'mosaic' ? 'column-closed' : 'pin-removed'
  const filling = surface === 'mosaic' ? 'column-added' : 'dwarf-clicked'
  if (!empty && input.kind === emptying && 'remaining' in input && input.remaining === 0) {
    return { ok: true, id: ids.emptied, empty: true }
  }
  if (empty && input.kind === filling) return { ok: true, id: ids.filled, empty: false }
  return { ok: false, reason: 'not-listed' }
}
