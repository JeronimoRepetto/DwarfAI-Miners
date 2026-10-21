/*
 * The mine picker's rules (US-LAUNCH-007; 07 machine 22 `picker-open`, `picker-empty`, S22.18; ISSUE-288;
 * `DS/docs/components.md`, Mine picker, As built). Pure: no DOM, no clock, no `window.api`.
 *
 * - Every live mine is a row, those with no chamber (nobody at work) included. The recently used come first, by
 *   `MineWire.lastUsedAt`, newest first; the rest keep data order (US-LAUNCH-007.AC09).
 * - A row's hint is "`<n>` at work" with a crew and "nobody here" without one; a mine that cannot be entered stays
 *   listed, disabled, with its reason ("Cannot be entered" when none is recorded) as both its hint and its title
 *   (US-LAUNCH-007.AC08; 07 §24 I-39). The wire carries the Host's reason code (`MineWire.unenterableReason`), and
 *   the row reads the Mines page's sentence for it: `not-found` is "Folder not found. It was moved or deleted."
 *   (`MINE_UNENTERABLE_REASON`, FM-095); a code with no approved sentence in the app yet reads as none recorded.
 * - The search matches a mine's name ignoring case and accents (US-LAUNCH-007.AC13) and only filters: the rows keep
 *   the order above (AC09). It runs in memory and answers at once, never awaiting anything (NFR-PERF-05).
 * - ↑ ↓ cycle the search field, the enabled visible rows and "Add a mine", wrapping at both ends (AC10): a disabled
 *   row takes no arrow focus.
 */
import { t, type MineId } from '@dwarfai/contracts'
import type { MineTier } from '../../types'
import { MINE_UNENTERABLE_REASON } from '../browse/mineCard'

/**
 * How many mines count as "recently used" and come first (US-LAUNCH-007.AC09). Design request DR-04 fixes the number;
 * until it does, this is a PLACEHOLDER value (`_work/phase7/design-requests.md` DR-04), held in this one constant.
 */
export const RECENT_MINES = 3

/** The sentence for each unenterable reason code the app has approved copy for (the Mines page's). */
const REASON_TEXT: Readonly<Record<string, string>> = { 'not-found': MINE_UNENTERABLE_REASON }

/** A tier not measured yet draws as Bronze, the tier a new mine starts at (US-MINES-004.AC01). */
const UNMEASURED_TIER: MineTier = 'bronze'

/** A live mine as the picker lists it: its wire record and how many dwarfs are present in it. */
export interface PickerMine {
  readonly mine: {
    readonly id: MineId
    readonly name: string
    readonly state: 'unrecorded' | 'measuring' | 'active' | 'unenterable'
    readonly tier: MineTier | null
    readonly unenterableReason?: string
    readonly lastUsedAt: number
  }
  readonly crew: number
}

/** One row of the picker. */
export interface PickerRow {
  readonly mineId: MineId
  readonly name: string
  readonly tier: MineTier
  readonly hint: string
  /** Only a disabled row has one: why it cannot be entered. */
  readonly title?: string
  readonly disabled: boolean
  /** The name folded for the search. */
  readonly folded: string
}

/** Where ↑ ↓ can put the focus. */
export type FocusStop =
  | { readonly kind: 'search' }
  | { readonly kind: 'row'; readonly mineId: MineId }
  | { readonly kind: 'add' }

/** Lower case with the accents taken off (NFD, combining marks dropped): "Mória" and "MORIA" fold alike. */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function rowOf({ mine, crew }: PickerMine): PickerRow {
  const base = {
    mineId: mine.id,
    name: mine.name,
    tier: mine.tier ?? UNMEASURED_TIER,
    folded: foldForSearch(mine.name)
  }
  if (mine.state === 'unenterable') {
    const code = mine.unenterableReason
    const reason =
      (code === undefined ? undefined : REASON_TEXT[code]) ?? t('minePicker.cannotEnter')
    return { ...base, hint: reason, title: reason, disabled: true }
  }
  return {
    ...base,
    hint: crew > 0 ? t('minePicker.crew', { count: crew }) : t('minePicker.nobody'),
    disabled: false
  }
}

/** Every live mine as a row: the `RECENT_MINES` last used first, newest first, then the rest in data order. */
export function pickerRows(mines: readonly PickerMine[]): PickerRow[] {
  const recent = mines
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => b.entry.mine.lastUsedAt - a.entry.mine.lastUsedAt || a.at - b.at)
    .slice(0, RECENT_MINES)
    .map(({ entry }) => entry)
  const rest = mines.filter((entry) => !recent.includes(entry))
  return [...recent, ...rest].map(rowOf)
}

/** The rows whose name holds the query, ignoring case, accents and surrounding blanks, in their own order. */
export function filterRows(rows: readonly PickerRow[], query: string): PickerRow[] {
  const folded = foldForSearch(query.trim())
  return folded === '' ? [...rows] : rows.filter((row) => row.folded.includes(folded))
}

/** The line under the list: the empty text with no mine at all, "No mine matches." when the search hides every row. */
export function pickerNotice(total: number, shown: number): string | null {
  if (total === 0) return t('minePicker.empty')
  return shown === 0 ? t('minePicker.noMatch') : null
}

/** The arrow-key stops, in order: the search field, each enabled visible row, "Add a mine". */
export function focusStops(visible: readonly PickerRow[]): FocusStop[] {
  return [
    { kind: 'search' },
    ...visible
      .filter((row) => !row.disabled)
      .map((row): FocusStop => ({ kind: 'row', mineId: row.mineId })),
    { kind: 'add' }
  ]
}

/** Where ↓ or ↑ moves the focus from stop `from`, wrapping at both ends; undefined for any other key. */
export function nextFocus(
  stops: readonly FocusStop[],
  from: number,
  key: string
): number | undefined {
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0
  if (step === 0 || stops.length === 0) return undefined
  return (((from + step) % stops.length) + stops.length) % stops.length
}
