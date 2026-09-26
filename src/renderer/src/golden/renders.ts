/*
 * What each golden state draws (#634): the real component, with props built from the design's
 * sample data as the golden page loaded it. Keyed by the manifest key `states.json` lists; the
 * state ids are the only design text here (PO ruling G-03).
 *
 * A render reaches a state through the component's own props, exactly as the app would; it never
 * styles the component. The stage and a component's UI kit framing come from the design's docs at
 * run time, so an entry that needs a tweak to match its reference has found a gap in the
 * component, which the rebuild (#635) closes.
 *
 * The `foundations/*` states are specimens of the tokens rather than components: they draw the
 * golden-only views in specimens.ts, with the token and class lists the design's anatomy gives
 * each state. A specimen still marked `Unbuilt` has no view yet, so it fails as it should.
 */
import type { Component } from 'vue'
import { defineComponent, h } from 'vue'
import ShellNav from '../components/shell/ShellNav.vue'
import type { GoldenSample } from './sample'
import { PlateRow, SwatchSheet, TokenList, Unbuilt } from './specimens'

export interface GoldenRender {
  component: Component
  props: Record<string, unknown>
}

const swatches = (names: string[]) => (): GoldenRender => ({
  component: SwatchSheet,
  props: { names }
})
const plates = (classes: string[]) => (): GoldenRender => ({
  component: PlateRow,
  props: { plates: classes }
})
const unbuilt = (): GoldenRender => ({ component: Unbuilt, props: {} })

// The UI kit's own frame for the Rules state: a plain div with an inline style (README,
// "Frames that are not the component"), around the app's rule.
const RuleFrame = defineComponent({
  setup() {
    return () =>
      h('div', { style: { width: '240px', display: 'grid', gap: '10px' } }, [
        h('hr', { class: 'm-rule' })
      ])
  }
})

const ramp = (name: string) => [name + '-hi', name, name + '-lo']

export const RENDERS: Record<string, (sample: GoldenSample) => GoldenRender> = {
  // The Panel's nav on the Mines page with the music playing; whether the shortcut failed is the
  // sample configuration's.
  'organisms/nav#default': (sample) => ({
    component: ShellNav,
    props: { area: 'mines', broken: sample.config.shortcutFailed, musicPlaying: true }
  }),

  'foundations/colour#materials': swatches([
    ...ramp('rock'),
    ...ramp('wood'),
    ...ramp('control'),
    ...ramp('gold'),
    ...ramp('brass'),
    'parch-hi',
    'parchment',
    'parch-lo',
    ...ramp('steel')
  ]),
  'foundations/colour#text': swatches([
    'ink',
    'ink-soft',
    'ink-faint',
    'ink-on-light',
    'ink-on-light-soft'
  ]),
  'foundations/colour#semantic': swatches(
    ['ok', 'warn', 'danger', 'info'].flatMap((name) => [name, name + '-lo'])
  ),
  // Canonical tier order: Bronze, Copper, Silver, Gold, Uranium.
  'foundations/colour#tiers': swatches(
    ['bronze', 'copper', 'silver', 'gold', 'uranium'].flatMap((tier) => [
      'tier-' + tier,
      'tier-' + tier + '-lo'
    ])
  ),
  'foundations/materials#surfaces': plates([
    'm-wood',
    'm-control',
    'm-rock',
    'm-well',
    'm-parchment',
    'm-parchment-well',
    'm-brass',
    'm-gold'
  ]),
  'foundations/materials#trims': plates(['m-wood', 'm-wood m-trim', 'm-wood m-trim-lit']),
  'foundations/materials#raised': plates(['m-wood m-raised', 'm-wood m-rivets']),
  'foundations/materials#focus-visible': plates(['m-wood is-focus']),
  'foundations/materials#rules': () => ({ component: RuleFrame, props: {} }),
  'foundations/motion#tokens': () => ({
    component: TokenList,
    props: {
      names: [
        'dur-press',
        'dur-fast',
        'dur-base',
        'dur-panel',
        'dur-tip-delay',
        'dur-pulse',
        'frame-ms',
        'ease-step',
        'ease-out',
        'ease-in'
      ]
    }
  }),
  // Specimens with no view yet: the type scale, the two motion states (they draw the redesigned
  // button, not rebuilt yet), the presets (real components in each preset) and the type lab.
  'foundations/motion#enter': unbuilt,
  'foundations/motion#press': unbuilt,
  'foundations/type#scale': unbuilt,
  'foundations/type-presets#dwarfai-pixel-clean-readable': unbuilt,
  'foundations/type-lab#current-choice': unbuilt
}
