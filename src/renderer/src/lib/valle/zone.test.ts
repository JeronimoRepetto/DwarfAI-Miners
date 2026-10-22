import type { ZoneContent } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { EREBOR } from '../veta/testing/vetaFixtures'
import {
  ZONE_AT_REST,
  stepZone,
  zoneMenu,
  zoneSuffix,
  type ZoneFacts,
  type ZoneInput,
  type ZoneMenuEntry,
  type ZoneState
} from './zone'

/*
 * 07 machine 31 (ISSUE-304; US-VALLE-009; UC-058; 17 §1.1 diagram-conformance walk): what one zone shows, swapped from
 * its header "⋯" without leaving its slot, the menu each preset offers, and the edges a dive, the ambience, a map
 * marker, a history request, the resets and the mine's removal take. An input the machine does not list is refused.
 */

const CONTROL: ZoneFacts = { preset: 'control', enterable: true, muted: false }
const FRONT: ZoneFacts = { preset: 'front', enterable: true, muted: false }

const showing = (content: ZoneContent, menuOpen = false): ZoneState => ({ content, menuOpen })

/** The menu's items as they read, a rule as `—`, the item shown now marked `✓` and a disabled one `(disabled)`. */
function read(entries: readonly ZoneMenuEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === 'rule') return '—'
    const marks = `${entry.checked ? ' ✓' : ''}${entry.disabled ? ' (disabled)' : ''}`
    return `${entry.label}${marks}`
  })
}

describe('machine 31 diagram conformance', () => {
  it('[US-VALLE-009.AC01, S31.03, S31.04, S31.05, S31.06] a Show here item swaps the zone’s content in its slot and the header notes it', () => {
    const cases: readonly { id: string; from: ZoneContent; to: ZoneContent; suffix: string }[] = [
      { id: 'S31.03', from: 'mine', to: 'map', suffix: '· Map' },
      { id: 'S31.04', from: 'mine', to: 'mineslist', suffix: '· Mines' },
      { id: 'S31.05', from: 'mine', to: 'history', suffix: '· History' },
      { id: 'S31.06', from: 'history', to: 'mine', suffix: '' }
    ]
    for (const { id, from, to, suffix } of cases) {
      const step = stepZone(showing(from, true), { kind: 'show', content: to }, CONTROL)
      // The zone stays the same zone (its slot is its mine's column): only its content changes, written at once.
      expect(step, id).toEqual({
        ok: true,
        id,
        zone: showing(to),
        effects: [{ kind: 'write-content', content: to }]
      })
      expect(zoneSuffix(to), id).toBe(suffix)
    }
    // The Work front's one zone swaps the same way, the mines list aside (US-VALLE-009.AC04).
    expect(stepZone(showing('mine', true), { kind: 'show', content: 'map' }, FRONT)).toMatchObject({
      ok: true,
      id: 'S31.03',
      zone: showing('map')
    })
  })

  it('[US-VALLE-009.AC02, NFR-A11Y-14] the item shown now is disabled and marked ✓', () => {
    for (const content of ['mine', 'map', 'mineslist', 'history'] as const) {
      const shows = zoneMenu(content, CONTROL).filter(
        (entry) => entry.kind === 'item' && entry.id.startsWith('show-')
      )
      // That item alone: it keeps its place in the menu, disabled and checked; the three others stay enabled.
      expect(
        shows.map((entry) => entry.kind === 'item' && [entry.id, entry.checked, entry.disabled]),
        content
      ).toEqual(
        (['mine', 'map', 'mineslist', 'history'] as const).map((each) => [
          `show-${each}`,
          each === content,
          each === content
        ])
      )
    }
    // Picking it changes nothing: the guard "not shown now" (S31.03, S31.06).
    expect(stepZone(showing('map', true), { kind: 'show', content: 'map' }, CONTROL)).toEqual({
      ok: false,
      reason: 'not-listed'
    })
  })

  it('[US-VALLE-009.AC04] the Work front menu has no Show here: the mines list and no Close this column', () => {
    expect(read(zoneMenu('mine', FRONT))).toEqual([
      'Show here: the mine ✓ (disabled)',
      'Show here: the map',
      'Show here: history',
      '—',
      'Mute mine ambience'
    ])
    // Neither is taken there either (S31.04, S31.09 are the Control room's).
    expect(stepZone(showing('mine', true), { kind: 'show', content: 'mineslist' }, FRONT).ok).toBe(
      false
    )
    expect(stepZone(showing('mine', true), { kind: 'close-column' }, FRONT).ok).toBe(false)
  })

  it('[US-VALLE-009.AC05] the Control room menu lists Dive in · Work front, the four Show here items, the ambience toggle and Close this column, in that order', () => {
    expect(read(zoneMenu('mine', CONTROL))).toEqual([
      'Dive in · Work front',
      '—',
      'Show here: the mine ✓ (disabled)',
      'Show here: the map',
      'Show here: the mines list',
      'Show here: history',
      '—',
      'Mute mine ambience',
      '—',
      'Close this column'
    ])
    // A muted mine offers its ambience back; a mine that cannot be entered keeps "Dive in" in its place, disabled.
    expect(read(zoneMenu('map', { preset: 'control', enterable: false, muted: true }))).toEqual([
      'Dive in · Work front (disabled)',
      '—',
      'Show here: the mine',
      'Show here: the map ✓ (disabled)',
      'Show here: the mines list',
      'Show here: history',
      '—',
      'Mine ambience on',
      '—',
      'Close this column'
    ])
  })

  it('[US-VALLE-009.AC06, S31.02] Esc or an outside click closes the menu and nothing else changes', () => {
    for (const content of ['mine', 'map', 'mineslist', 'history'] as const) {
      expect(stepZone(showing(content, true), { kind: 'dismiss' }, CONTROL)).toEqual({
        ok: true,
        id: 'S31.02',
        zone: showing(content),
        effects: []
      })
    }
  })

  it('[S31.01, S31.09] ⋯ in a zone header opens the menu for the preset, and Close this column in the Control room closes the column through S32.03', () => {
    for (const content of ['mine', 'map', 'mineslist', 'history'] as const) {
      expect(stepZone(showing(content), { kind: 'menu' }, CONTROL)).toEqual({
        ok: true,
        id: 'S31.01',
        zone: showing(content, true),
        effects: []
      })
    }
    // A menu already open is not opened again.
    expect(stepZone(showing('mine', true), { kind: 'menu' }, CONTROL).ok).toBe(false)
    // S31.09: the column closes (machine 32's S32.03 carries it out); the zone leaves with it.
    expect(stepZone(showing('history', true), { kind: 'close-column' }, CONTROL)).toEqual({
      ok: true,
      id: 'S31.09',
      zone: null,
      effects: [{ kind: 'close-column' }]
    })
  })

  it('[S31.07, S31.08, S31.10, S31.11, S31.12, S31.13, S31.14] dive, ambience, map marker, history request, reset, removal and Reset metrics follow 07 machine 31', () => {
    // S31.07: "Dive in · Work front", the Control room and an enterable mine only (S28.03).
    expect(stepZone(showing('map', true), { kind: 'dive' }, CONTROL)).toEqual({
      ok: true,
      id: 'S31.07',
      zone: showing('map'),
      effects: [{ kind: 'dive' }]
    })
    expect(
      stepZone(showing('mine', true), { kind: 'dive' }, { ...CONTROL, enterable: false }).ok
    ).toBe(false)
    expect(stepZone(showing('mine', true), { kind: 'dive' }, FRONT).ok).toBe(false)

    // S31.08: the ambience toggles the mine in `mutedMineIds`; the content shown stays.
    expect(stepZone(showing('history', true), { kind: 'ambience' }, CONTROL)).toEqual({
      ok: true,
      id: 'S31.08',
      zone: showing('history'),
      effects: [{ kind: 'toggle-ambience', muted: true }]
    })
    expect(
      stepZone(showing('mine', true), { kind: 'ambience' }, { ...FRONT, muted: true })
    ).toMatchObject({ effects: [{ kind: 'toggle-ambience', muted: false }] })

    // S31.10: a map marker in a zone showing the map: back to the mine, and to the marker's mine (S32.14, S28.15).
    expect(stepZone(showing('map'), { kind: 'map-marker', mineId: EREBOR }, CONTROL)).toEqual({
      ok: true,
      id: 'S31.10',
      zone: showing('mine'),
      effects: [
        { kind: 'write-content', content: 'mine' },
        { kind: 'reveal', mineId: EREBOR }
      ]
    })
    expect(stepZone(showing('mine'), { kind: 'map-marker', mineId: EREBOR }, CONTROL).ok).toBe(
      false
    )

    // S31.11: a history request from a stack chat shows the history in that mine's zone, the Control room only.
    expect(stepZone(showing('mine'), { kind: 'history-request' }, CONTROL)).toEqual({
      ok: true,
      id: 'S31.11',
      zone: showing('history'),
      effects: [{ kind: 'write-content', content: 'history' }]
    })
    expect(stepZone(showing('mine'), { kind: 'history-request' }, FRONT).ok).toBe(false)

    // S31.12, S31.14: any content back to the mine; the reset writes the layout itself (machine 37, S39.10).
    for (const [kind, id] of [
      ['reset-preset', 'S31.12'],
      ['reset-metrics', 'S31.14']
    ] as const) {
      for (const from of [showing('history'), showing('map', true)]) {
        expect(stepZone(from, { kind }, CONTROL)).toEqual({
          ok: true,
          id,
          zone: showing('mine'),
          effects: []
        })
      }
    }

    // S31.13: the zone's mine removed: the zone is gone, with its column (S32.13) or by the Work front's swap (S28.23).
    expect(stepZone(showing('mineslist', true), { kind: 'mine-removed' }, CONTROL)).toEqual({
      ok: true,
      id: 'S31.13',
      zone: null,
      effects: [{ kind: 'gone' }]
    })
  })

  it('[ADR-024] a transition not listed in 07 machine 31 is rejected', () => {
    const refused: readonly [ZoneState, ZoneInput][] = [
      // Every menu item needs the menu open.
      [ZONE_AT_REST, { kind: 'show', content: 'map' }],
      [ZONE_AT_REST, { kind: 'dive' }],
      [ZONE_AT_REST, { kind: 'ambience' }],
      [ZONE_AT_REST, { kind: 'close-column' }],
      // Esc with no menu open is not this machine's.
      [ZONE_AT_REST, { kind: 'dismiss' }],
      // A history request reaches a zone showing its mine; a map marker one showing the map, menu closed.
      [showing('map'), { kind: 'history-request' }],
      [showing('map', true), { kind: 'map-marker', mineId: EREBOR }]
    ]
    for (const [zone, input] of refused) {
      expect(stepZone(zone, input, CONTROL), `${zone.content} ${input.kind}`).toEqual({
        ok: false,
        reason: 'not-listed'
      })
    }
  })
})
