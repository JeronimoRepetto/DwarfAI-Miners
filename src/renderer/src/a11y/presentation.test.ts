// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import TierChip from '../components/controls/TierChip.vue'
import TierMarker from '../components/map/TierMarker.vue'
import ChatBubble from '../components/message/ChatBubble.vue'
import MineCard from '../components/browse/MineCard.vue'
import TypographySettings from '../components/panel/TypographySettings.vue'
import { designTierLabel } from '../lib/presentation'
import { mapMarkerLabel } from '../lib/map/mapPage'
import { sendMarker } from '../lib/delivery/deliveryVerdict'
import { sceneDwarfLabel } from '../lib/scene/sceneDwarf'
import { prefersReducedMotion, watchReducedMotion } from '../lib/scene/sceneMotion'
import { REDUCED_MOTION_FRAME_MS } from '../lib/sprite/spriteSheet'
import { FONT_STYLE_OPTIONS } from '../lib/settings/fontStyle'
import { TYPE_ROLE_PROPERTIES, resolveTypePreset } from '../lib/typography/typePresets'
import type { MineCardView } from '../lib/browse/mineCard'
import {
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  TYPE_PRESET_FACES,
  TYPE_ROLES,
  type MineTier
} from '../types'

/*
 * L12 unit (ISSUE-266; 17 §1.12): what the Panel shows besides its keys. Reduced motion read from the OS preference,
 * with every duration token at 0ms and the design's stand-ins in place (NFR-A11Y-10, NFR-TIM-02); nothing said by
 * colour alone (NFR-A11Y-08); and the Readable preset as a first-class choice, Roboto in every role (NFR-A11Y-11).
 */

const SRC = join(__dirname, '..')
const TIERS: MineTier[] = ['bronze', 'copper', 'silver', 'gold', 'uranium']

afterEach(() => {
  document.body.innerHTML = ''
})

const source = (file: string): string => readFileSync(join(SRC, file), 'utf8')

/** A stylesheet's rules, each with its selector, declarations and the at-rules around it (comments dropped). */
function rules(css: string): { selector: string; body: string; media: string }[] {
  const found: { selector: string; body: string; media: string }[] = []
  const stack: string[] = []
  let buffer = ''
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '))
      buffer = ''
    } else if (char === '}') {
      const selector = stack.pop() ?? ''
      if (!selector.startsWith('@'))
        found.push({
          selector,
          body: buffer,
          media: stack.filter((s) => s.startsWith('@')).join(' ')
        })
      buffer = ''
    } else buffer += char
  }
  return found
}

/** Every stylesheet the renderer ships: its CSS files and its components' `<style>` blocks. */
function stylesheets(dir = SRC): { file: string; css: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'golden' ? [] : stylesheets(full)
    const file = relative(SRC, full).split(sep).join('/')
    const text = readFileSync(full, 'utf8')
    if (entry.name.endsWith('.css')) return [{ file, css: text }]
    if (!entry.name.endsWith('.vue')) return []
    return [
      {
        file,
        css: [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
      }
    ]
  })
}

const REDUCED = '@media (prefers-reduced-motion: reduce)'

/** A media query list answering `matches`, which a test can flip. */
function fakeQuery(matches: boolean) {
  const listeners = new Set<() => void>()
  return {
    query: {
      matches,
      addEventListener: (_type: 'change', listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: 'change', listener: () => void) => listeners.delete(listener)
    },
    flip(next: boolean) {
      this.query.matches = next
      for (const listener of listeners) listener()
    }
  }
}

describe('reduced motion, colour and type (L12, 17 §1.12)', () => {
  it('[NFR-A11Y-10, NFR-TIM-02] with reduced motion every duration token reads 0 ms and the listed stand-ins apply', () => {
    // Read from the OS preference, and watched: a change while the Panel is open is heard.
    const fake = fakeQuery(true)
    const view = { matchMedia: () => fake.query }
    expect(prefersReducedMotion(view)).toBe(true)
    expect(prefersReducedMotion({ matchMedia: () => fakeQuery(false).query })).toBe(false)
    const heard: boolean[] = []
    const stop = watchReducedMotion((reduced) => heard.push(reduced), view)
    fake.flip(false)
    stop()
    fake.flip(true)
    expect(heard).toEqual([false])

    // Every duration token reads 0ms, and an overlay rises 0px: the shell's own motion lands in one frame.
    const tokens = rules(source('assets/design-tokens.css'))
    const declared = (rule: { body: string }) =>
      new Map(
        rule.body
          .split(';')
          .map((part) => part.split(':').map((side) => side.trim()))
          .filter(
            (pair): pair is [string, string] => pair.length === 2 && pair[0]!.startsWith('--')
          )
      )
    const base = new Map(
      tokens
        .filter((r) => r.selector === ':root' && r.media === '')
        .flatMap((r) => [...declared(r)])
    )
    const reduced = new Map(
      tokens
        .filter((r) => r.selector === ':root' && r.media === REDUCED)
        .flatMap((r) => [...declared(r)])
    )
    const durations = [...base.keys()].filter((name) => name.startsWith('--dur-'))
    expect(durations.length).toBeGreaterThanOrEqual(6)
    for (const name of durations) expect(reduced.get(name), name).toBe('0ms')
    expect(reduced.get('--rise')).toBe('0px')
    // Sprites keep playing, every frame a flat 200ms (replaced, not scaled).
    expect(reduced.get('--frame-ms')).toBe('200ms')
    expect(REDUCED_MOTION_FRAME_MS).toBe(200)

    // The stand-ins: every loop the Panel plays forever stops under reduced motion (the marker pulse, the bobbing "?"
    // and "z", the scan band), and the marker's pulse holds a steady halo instead of vanishing.
    const all = stylesheets().flatMap((sheet) =>
      rules(sheet.css).map((rule) => ({ ...rule, file: sheet.file }))
    )
    const stopped = all
      .filter((rule) => rule.media === REDUCED && /animation\s*:\s*none/.test(rule.body))
      .flatMap((rule) => rule.selector.split(',').map((part) => part.trim()))
    const loops = all.filter(
      (rule) => rule.media === '' && /animation\s*:[^;]*\binfinite\b/.test(rule.body)
    )
    expect(loops.length).toBeGreaterThanOrEqual(5)
    const unstopped = loops
      .flatMap((rule) =>
        rule.selector.split(',').map((part) => ({ file: rule.file, part: part.trim() }))
      )
      .filter(({ part }) => {
        const last =
          part
            .split(/\s+/)
            .at(-1)!
            .match(/\.[\w-]+/g)
            ?.at(-1) ?? part
        return !stopped.some((selector) => selector.endsWith(last))
      })
      .map(({ file, part }) => `${file} ${part}`)
    expect(unstopped).toEqual([])
    const halo = rules(source('components/map/TierMarker.vue')).find(
      (rule) => rule.media === REDUCED && rule.selector === '.dm-marker__pulse'
    )
    expect(halo?.body).toMatch(/opacity:\s*0\.45/)
  })

  it('[NFR-A11Y-08] tiers, delivery marks, needs-you and the current mine are named, never shown by colour alone', () => {
    // A tier carries its name: on its chip, and in its marker's accessible name.
    for (const tier of TIERS) {
      const name = designTierLabel(tier)
      expect(mount(TierChip, { props: { tier } }).text()).toBe(name)
      expect(mount(TierMarker, { props: { tier } }).attributes('aria-label')).toBe(name + ' mine')
    }

    // A delivery mark is a glyph with a name: ✓ handed over, ✓✓ seen acting, each its own sentence.
    const delivered = sendMarker({ phase: 'delivered' } as never)!
    const reacted = sendMarker({ phase: 'reacted' } as never)!
    expect([delivered.glyph, reacted.glyph]).toEqual(['✓', '✓✓'])
    expect(delivered.title).not.toBe(reacted.title)
    for (const marker of [delivered, reacted]) {
      const mark = mount(ChatBubble, {
        props: {
          from: 'user',
          text: 'dig',
          mark: { mark: 'delivered', glyph: marker.glyph, title: marker.title }
        }
      }).get('.dm-bubble__mark')
      expect(mark.text()).toBe(marker.glyph)
      expect(mark.attributes('title')).toBe(marker.title)
    }

    // Needs you is a "?" and words: on the map marker, in its name, and in a dwarf's name in the scene.
    const asking = mount(TierMarker, {
      props: { tier: 'gold', asking: true, label: mapMarkerLabel('moria', 'gold', true) }
    })
    expect(asking.get('.dm-marker__q').text()).toBe('?')
    expect(asking.attributes('aria-label')).toBe('moria, Gold, needs you')
    expect(sceneDwarfLabel('Durin', 'asking')).toBe('Durin, needs you')

    // The current mine is a shape, the brackets, and is said as current; never a hue.
    const card: MineCardView = {
      id: 'm1',
      name: 'moria',
      tier: 'gold',
      measured: true,
      state: 'active',
      ore: [],
      crew: [],
      needs: false,
      needsCount: 0,
      enterable: true,
      removable: true
    }
    const open = mount(MineCard, { props: { card, open: true } })
    expect(open.classes()).toContain('m-brackets')
    expect(open.get('.dm-card__hit').attributes('aria-current')).toBe('true')
    expect(
      mount(MineCard, { props: { card } }).get('.dm-card__hit').attributes('aria-current')
    ).toBeUndefined()
    const brackets = rules(source('components/browse/MineCard.vue')).find(
      (rule) => rule.selector === ".dm-card[data-open='true']::after"
    )
    expect(brackets?.body).toMatch(/opacity:\s*1/)
    expect(
      mount(TierMarker, { props: { tier: 'gold', selected: true } }).attributes('aria-pressed')
    ).toBe('true')
  })

  it('[NFR-A11Y-11] the Readable preset uses Roboto in every role', () => {
    // Every role is Roboto, and so is every custom property the preset paints a role with.
    expect(TYPE_ROLES.map((role) => TYPE_PRESET_FACES.readable[role])).toEqual(
      TYPE_ROLES.map(() => 'roboto')
    )
    const painted = resolveTypePreset('readable')
    for (const role of TYPE_ROLES)
      expect(painted[TYPE_ROLE_PROPERTIES[role]], role).toBe('var(--font-family-roboto)')

    // A first-class choice: one of the Font style radios, named, beside the other presets, never behind a setting.
    expect(FONT_STYLE_OPTIONS.map((option) => option.id)).toContain('readable')
    const settings = mount(TypographySettings, {
      props: { preferences: { ...DEFAULT_TYPOGRAPHY_PREFERENCES }, applying: false }
    })
    const radio = settings.get('[role="radio"][data-id="readable"]')
    expect(radio.isVisible()).toBe(true)
    expect(radio.text()).toContain('Readable')
  })
})
