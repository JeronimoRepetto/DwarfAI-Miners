import type { MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { EREBOR, KHAZAD, MORIA, mineWire } from './testing/vetaFixtures'
import {
  RECENT_MINES,
  filterRows,
  focusStops,
  nextFocus,
  pickerNotice,
  pickerRows,
  type PickerMine
} from './minePicker'

/*
 * ISSUE-288 (TC-288-02): the mine picker's rules, pure (US-LAUNCH-007; DS/docs/components.md, Mine picker, As built):
 * the order (recently used first by `lastUsedAt`, then data order), the case- and accent-insensitive match that only
 * filters, the row hints, the disabled not-enterable rows and the ↑ ↓ focus cycle. Fixture mines: enterable,
 * unenterable with and without a reason, with and without a crew, accented names.
 */

const GLORIN = '01920000-0000-7000-8000-00000000a004' as MineId
const DURIN = '01920000-0000-7000-8000-00000000a005' as MineId

/** Five mines in data order; `lastUsedAt` puts khazad, then glorin, then moria among the recently used. */
function fixtureMines(): PickerMine[] {
  return [
    { mine: mineWire(EREBOR, { name: 'Erebor', lastUsedAt: 100 }), crew: 0 },
    { mine: mineWire(MORIA, { name: 'Mória', lastUsedAt: 300 }), crew: 2 },
    {
      mine: mineWire(KHAZAD, {
        name: 'Khazad-dûm',
        lastUsedAt: 900,
        state: 'unenterable',
        unenterableReason: 'Folder not found. It was moved or deleted.'
      }),
      crew: 0
    },
    { mine: mineWire(GLORIN, { name: 'glorin', lastUsedAt: 500 }), crew: 1 },
    {
      mine: mineWire(DURIN, { name: 'Durin', lastUsedAt: 200, state: 'unenterable' }),
      crew: 0
    }
  ]
}

const names = (rows: readonly { name: string }[]): string[] => rows.map((row) => row.name)

describe('the mine picker', () => {
  it('[US-LAUNCH-007.AC03, US-LAUNCH-007.AC13, NFR-PERF-05] typing filters the list live, ignoring case and accents, with no await', () => {
    const rows = pickerRows(fixtureMines())
    const table: Array<[query: string, shown: string[]]> = [
      ['', ['Khazad-dûm', 'glorin', 'Mória', 'Erebor', 'Durin']],
      ['moria', ['Mória']],
      ['MÓRIA', ['Mória']],
      ['khazad-dum', ['Khazad-dûm']],
      ['GLOR', ['glorin']],
      ['  R  ', ['glorin', 'Mória', 'Erebor', 'Durin']],
      ['zzz', []]
    ]
    for (const [query, shown] of table) {
      const filtered = filterRows(rows, query)
      // In memory and synchronous: the answer is the list itself, never a promise of one.
      expect(filtered).not.toBeInstanceOf(Promise)
      expect(names(filtered), query).toEqual(shown)
    }
  })

  it('[US-LAUNCH-007.AC04] a search matching no mine shows No mine matches.', () => {
    const rows = pickerRows(fixtureMines())
    expect(pickerNotice(rows.length, filterRows(rows, 'nothing like it').length)).toBe(
      'No mine matches.'
    )
    expect(pickerNotice(rows.length, filterRows(rows, 'erebor').length)).toBeNull()
    // With no mine at all the picker's own empty text shows instead (US-LAUNCH-007.AC16).
    expect(pickerNotice(0, 0)).toBe('No mines yet. Add a project folder to start.')
  })

  it('[US-LAUNCH-007.AC06, US-LAUNCH-007.AC07] a row with a crew hints n at work and an enterable row with none hints nobody here', () => {
    const rows = pickerRows(fixtureMines())
    const hint = (name: string): string | undefined => rows.find((r) => r.name === name)?.hint
    expect(hint('Mória')).toBe('2 at work')
    expect(hint('glorin')).toBe('1 at work')
    expect(hint('Erebor')).toBe('nobody here')
  })

  it('[US-LAUNCH-007.AC08, US-RES-007.AC05, NFR-A11Y-14] a not-enterable row is present, disabled, with its reason, or Cannot be entered, as hint and title', () => {
    const rows = pickerRows(fixtureMines())
    const khazad = rows.find((r) => r.mineId === KHAZAD)
    const durin = rows.find((r) => r.mineId === DURIN)
    expect(khazad).toMatchObject({
      disabled: true,
      hint: 'Folder not found. It was moved or deleted.',
      title: 'Folder not found. It was moved or deleted.'
    })
    expect(durin).toMatchObject({
      disabled: true,
      hint: 'Cannot be entered',
      title: 'Cannot be entered'
    })
    // An enterable row is never disabled and carries no title of its own.
    const erebor = rows.find((r) => r.mineId === EREBOR)
    expect(erebor).toMatchObject({ disabled: false })
    expect(erebor?.title).toBeUndefined()
  })

  it('[US-LAUNCH-007.AC09] recently used mines come first, then the rest in data order, and searching never re-sorts', () => {
    // DR-04: how many count as "recently used" is design's; the test reads the one constant.
    expect(RECENT_MINES).toBe(3)
    const rows = pickerRows(fixtureMines())
    // The three last used (khazad 900, glorin 500, moria 300), then erebor and durin in data order.
    expect(names(rows)).toEqual(['Khazad-dûm', 'glorin', 'Mória', 'Erebor', 'Durin'])
    // A search that matches several keeps their order: a closer match never jumps ahead.
    expect(names(filterRows(rows, 'r'))).toEqual(['glorin', 'Mória', 'Erebor', 'Durin'])
    expect(names(filterRows(rows, 'durin'))).toEqual(['Durin'])
    expect(names(filterRows(rows, 'in'))).toEqual(['glorin', 'Durin'])
  })

  it('[US-LAUNCH-007.AC10] arrow keys cycle the search field, the enabled visible rows and Add a mine, wrapping at both ends', () => {
    const rows = pickerRows(fixtureMines())
    const stops = focusStops(filterRows(rows, ''))
    // Disabled rows take no arrow focus: khazad and durin are skipped.
    expect(stops).toEqual([
      { kind: 'search' },
      { kind: 'row', mineId: GLORIN },
      { kind: 'row', mineId: MORIA },
      { kind: 'row', mineId: EREBOR },
      { kind: 'add' }
    ])
    // The L12 keyboard table: from, key, to.
    const table: Array<[from: number, key: string, to: number]> = [
      [0, 'ArrowDown', 1],
      [1, 'ArrowDown', 2],
      [3, 'ArrowDown', 4],
      [4, 'ArrowDown', 0],
      [0, 'ArrowUp', 4],
      [4, 'ArrowUp', 3],
      [2, 'ArrowUp', 1]
    ]
    for (const [from, key, to] of table)
      expect(nextFocus(stops, from, key), `${from} ${key}`).toBe(to)
    expect(nextFocus(stops, 2, 'Enter')).toBeUndefined()
    // Filtered, only the visible enabled rows stay between the search and Add a mine.
    expect(focusStops(filterRows(rows, 'erebor'))).toEqual([
      { kind: 'search' },
      { kind: 'row', mineId: EREBOR },
      { kind: 'add' }
    ])
    // The empty picker cycles its search and its one action.
    expect(focusStops([])).toEqual([{ kind: 'search' }, { kind: 'add' }])
    expect(nextFocus(focusStops([]), 1, 'ArrowDown')).toBe(0)
  })
})
