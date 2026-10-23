// @vitest-environment jsdom
import type { MineId } from '@dwarfai/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { EREBOR, KHAZAD, MORIA } from '../../lib/veta/testing/vetaFixtures'
import CurrentMineMark from './CurrentMineMark.vue'
import markSource from './CurrentMineMark.vue?raw'
import ValleControlRoom from './ValleControlRoom.vue'
import roomSource from './ValleControlRoom.vue?raw'
import ValleWorkFront from './ValleWorkFront.vue'
import frontSource from './ValleWorkFront.vue?raw'

/*
 * The current-mine mark (07 machine 35 `set` invariants; US-VALLE-013.AC04, .AC07, .AC09, .AC11; decision log, Selected
 * mine mark; `DS` organisms/mine-zone, organisms/mine-rows): four stepped parchment corner brackets, a shape and never a
 * colour, nested inside the needs-you ring, `aria-current` and ", current" on the zone, and the Work front list's own
 * smaller mark over its gold face.
 */

/** The rules of an SFC's style block, comments dropped: each selector with its declarations. */
function rules(source: string): { selector: string; declarations: Map<string, string> }[] {
  const style = source.slice(source.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '')
  const body = style.slice(style.indexOf('>') + 1, style.lastIndexOf('</style>'))
  const found: { selector: string; declarations: Map<string, string> }[] = []
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>()
    for (const line of match[2]!.split(';')) {
      const at = line.indexOf(':')
      if (at > 0) declarations.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
    }
    found.push({ selector: match[1]!.trim().replace(/\s+/g, ' '), declarations })
  }
  return found
}

const column = (
  mineId: MineId,
  name: string,
  over: { current?: boolean; needs?: boolean } = {}
) => ({
  mineId,
  name,
  enterable: true,
  current: false,
  needs: false,
  ...over
})

describe('the current-mine mark', () => {
  it('[US-VALLE-013.AC04] a current mine that needs the person wears the brackets inside the needs-you ring, never merged', () => {
    const room = mount(ValleControlRoom, {
      props: {
        columns: [
          column(MORIA, 'Moria', { current: true, needs: true }),
          column(EREBOR, 'Erebor', { needs: true })
        ]
      }
    })
    const zone = room.get(`[data-valle-column="${MORIA}"]`)
    // Two marks, each its own: the zone hosts the needs-you ring, the brackets sit inside its body.
    expect(zone.attributes('data-needs')).toBe('true')
    expect(zone.attributes('data-current')).toBe('true')
    expect(zone.classes()).not.toContain('m-brackets')
    const mark = zone.get('.dm-vz__well [data-current-mark]')
    expect(mark.element).not.toBe(zone.element)
    expect(mark.classes()).toContain('m-brackets')
    expect(mark.attributes('data-current')).toBe('true')
    // Needing the person alone draws no brackets.
    const other = room.get(`[data-valle-column="${EREBOR}"]`)
    expect(other.attributes('data-needs')).toBe('true')
    expect(other.attributes('data-current')).toBe('false')
    expect(other.get('[data-current-mark]').attributes('data-current')).toBe('false')
    // The zone's own look never changes with the mark: no rule of the room reads data-current.
    expect(rules(roomSource).filter((rule) => rule.selector.includes('data-current'))).toEqual([])
  })

  it('[US-VALLE-013.AC07] the mark is always stepped corner brackets, never a colour or a continuous outline', () => {
    const mark = mount(CurrentMineMark, { props: { current: true, size: 'zone' } })
    // The shared mark: the eight-bar bracket shape of `.m-brackets::after` (design-tokens.css).
    expect(mark.classes()).toContain('m-brackets')
    expect(mark.attributes('aria-hidden')).toBe('true')
    const all = rules(markSource)
    // Turning it on shows the brackets and does nothing else.
    const on = all.filter((rule) => rule.selector.includes("[data-current='true']"))
    expect(on.length).toBeGreaterThan(0)
    for (const rule of on) expect([...rule.declarations.keys()]).toEqual(['opacity'])
    // Nowhere a hue, a border, an outline or a ring.
    for (const rule of all) {
      for (const name of rule.declarations.keys()) {
        expect(name).not.toMatch(
          /^(color|background|background-color|border.*|outline.*|box-shadow)$/
        )
      }
    }
  })

  it('[US-VALLE-013.AC09] the current zone has aria-current true and its name ends with , current', () => {
    const room = mount(ValleControlRoom, {
      props: { columns: [column(MORIA, 'Moria'), column(KHAZAD, 'Khazad', { current: true })] }
    })
    const current = room.get(`[data-valle-column="${KHAZAD}"]`)
    expect(current.attributes('aria-current')).toBe('true')
    expect(current.attributes('aria-label')).toBe('Mine Khazad, current')
    const other = room.get(`[data-valle-column="${MORIA}"]`)
    expect(other.attributes('aria-current')).toBeUndefined()
    expect(other.attributes('aria-label')).toBe('Mine Moria')
    // The Work front's one mine is always the current one (US-VALLE-013.AC05).
    const front = mount(ValleWorkFront, {
      props: {
        foldedList: false,
        mines: [{ mineId: EREBOR, name: 'Erebor' }],
        mine: { mineId: EREBOR, name: 'Erebor' }
      }
    })
    const zone = front.get(`[data-valle-front-mine="${EREBOR}"]`)
    expect(zone.attributes('aria-current')).toBe('true')
    expect(zone.attributes('aria-label')).toBe('Mine Erebor, current')
    expect(zone.get('[data-current-mark]').attributes('data-current')).toBe('true')
  })

  it("[US-VALLE-013.AC11] the Work front list's current line has a gold-faced mark 2 px thick with 8 px arms and no ring", () => {
    const front = mount(ValleWorkFront, {
      props: {
        foldedList: false,
        mines: [
          { mineId: MORIA, name: 'Moria' },
          { mineId: EREBOR, name: 'Erebor' }
        ],
        mine: { mineId: EREBOR, name: 'Erebor' }
      }
    })
    const line = front.get(`[data-valle-row="${EREBOR}"]`)
    expect(line.attributes('data-current')).toBe('true')
    const mark = line.get('[data-current-mark]')
    expect(mark.attributes('data-mark')).toBe('list')
    expect(mark.attributes('data-current')).toBe('true')
    const style = (mark.element as HTMLElement).style
    expect(style.getPropertyValue('--mark-t')).toBe('2px')
    expect(style.getPropertyValue('--mark-l')).toBe('8px')
    expect(style.getPropertyValue('--mark-in')).toBe('4px')
    expect(front.get(`[data-valle-row="${MORIA}"]`).attributes('data-current')).toBe('false')
    // The gold face (`DS` organisms/mine-rows): --gold-select, --gold light, --gold-deep shadow, a 2px --rock-lo edge.
    const face = rules(frontSource).find(
      (rule) => rule.selector === ".dm-mrow[data-current='true']"
    )
    expect(face?.declarations.get('background')).toBe('var(--gold-select)')
    const shadow = face?.declarations.get('box-shadow') ?? ''
    expect(shadow).toContain('var(--gold)')
    expect(shadow).toContain('var(--gold-deep)')
    expect(shadow).toContain('var(--rock-lo)')
    // No brass ring: brass is needs you.
    expect(shadow).not.toContain('brass')
  })
})
