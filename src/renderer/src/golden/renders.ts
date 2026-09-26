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
 * each state, and the captions its tree shows, which the harness reads at run time and hands in as
 * `texts`. A specimen still marked `Unbuilt` has no view yet, so it fails as it should.
 */
import type { Component } from 'vue'
import ActionButton from '../components/controls/ActionButton.vue'
import FieldHint from '../components/controls/FieldHint.vue'
import InputField from '../components/controls/InputField.vue'
import SelectField from '../components/controls/SelectField.vue'
import ShellNav from '../components/shell/ShellNav.vue'
import type { GoldenSample } from './sample'
import {
  EnterFrame,
  IconRow,
  IconSheet,
  KitFrame,
  KitRow,
  PlateRow,
  RuleFrame,
  SwatchSheet,
  TokenList,
  TypeScale,
  Unbuilt,
  type FramedPart,
  type GoldenText
} from './specimens'

export type { GoldenText }

/** One element of a state's anatomy tree and the attributes it prints (a placeholder, a value). */
export interface GoldenAttributes {
  element: string
  attributes: Record<string, string>
}

export interface GoldenRender {
  component: Component
  props: Record<string, unknown>
}

const swatches = (names: string[]) => (): GoldenRender => ({
  component: SwatchSheet,
  props: { names }
})
const plates =
  (classes: string[]) =>
  (_sample: GoldenSample, texts: GoldenText[]): GoldenRender => ({
    component: PlateRow,
    props: { plates: classes, texts }
  })
const unbuilt = (): GoldenRender => ({ component: Unbuilt, props: {} })

const ramp = (name: string) => [name + '-hi', name, name + '-lo']

type Render = (
  sample: GoldenSample,
  texts: GoldenText[],
  attributes: GoldenAttributes[]
) => GoldenRender

/*
 * One button of a state, as the props the app would pass. `labelled` takes the next label from the
 * state's texts, in tree order: a label is design text, so it arrives at run time with the rest
 * and is never written here. An icon-only button's `title` is its icon's own name instead: the
 * accessible name never paints, and the golden grades pixels.
 */
type ButtonSpec = Record<string, unknown> & { labelled?: boolean }

const buttonProps = (specs: ButtonSpec[], texts: GoldenText[]): Record<string, unknown>[] => {
  let next = 0
  return specs.map(({ labelled, ...props }) =>
    labelled ? { ...props, label: texts[next++]?.text ?? '' } : props
  )
}
// The kit's row of buttons: each spec one real button, side by side in the kit's own frame.
const buttonRow =
  (specs: ButtonSpec[]): Render =>
  (_sample, texts) => ({
    component: KitRow,
    props: {
      parts: buttonProps(specs, texts).map((props) => ({ component: ActionButton, props }))
    }
  })
// A state that is one button and nothing around it: the button is the stage's only child.
const button =
  (spec: ButtonSpec): Render =>
  (_sample, texts) => ({ component: ActionButton, props: buttonProps([spec], texts)[0]! })

/*
 * The form controls' design text (a placeholder, a value, an accessible name, an option) is in
 * the attributes the state's tree prints, handed in at run time like the texts. `elementsOf` picks
 * the elements of one kind, in tree order; the frame around them takes the style its own root
 * prints. A flag no attribute shows, such as a forced look or `invalid`, is the render's, as a
 * button's variant is.
 */
const elementsOf = (attributes: GoldenAttributes[], element: string): Record<string, string>[] =>
  attributes
    .filter((entry) => entry.element === element || entry.element.startsWith(element + '.'))
    .map((entry) => entry.attributes)

const framed =
  (parts: (texts: GoldenText[], attributes: GoldenAttributes[]) => FramedPart[]): Render =>
  (_sample, texts, attributes) => ({
    component: KitFrame,
    props: { style: attributes[0]?.attributes.style ?? '', parts: parts(texts, attributes) }
  })

// One field per spec, each taking its placeholder, value and disabled flag from the matching
// control of the tree, and the error hint under the last when the tree has one.
const fields = (
  specs: Record<string, unknown>[],
  { control = 'input', hint = false }: { control?: 'input' | 'textarea'; hint?: boolean } = {}
): Render =>
  framed((texts, attributes) => {
    const controls = elementsOf(attributes, control)
    const parts: FramedPart[] = specs.map((spec, i) => {
      const native = controls[i] ?? {}
      return {
        component: InputField,
        props: {
          ...spec,
          placeholder: native.placeholder ?? '',
          value: native.value ?? '',
          disabled: 'disabled' in native,
          ...(native.rows === undefined ? {} : { rows: Number(native.rows) })
        }
      }
    })
    if (hint) parts.push({ component: FieldHint, props: { error: true }, text: texts[0]?.text })
    return parts
  })

// Each select of the tree with its name, disabled flag and options, in order.
const selectsOf = (
  attributes: GoldenAttributes[]
): { label: string; disabled: boolean; options: string[] }[] => {
  const selects: { label: string; disabled: boolean; options: string[] }[] = []
  for (const { element, attributes: a } of attributes) {
    if (element.startsWith('select')) {
      selects.push({ label: a['aria-label'] ?? '', disabled: 'disabled' in a, options: [] })
    } else if (element.startsWith('option')) selects.at(-1)?.options.push(a.value ?? '')
  }
  return selects
}

const STATES = [undefined, 'hover', 'active', 'focus'] as const

export const RENDERS: Record<string, Render> = {
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
  'foundations/materials#rules': (_sample, texts) => ({ component: RuleFrame, props: { texts } }),
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
  // One paragraph per role, in the anatomy's order, with the kit's inline colour on the two
  // display lines.
  'foundations/type#scale': (_sample, texts) => ({
    component: TypeScale,
    props: {
      lines: [
        { classes: 't-headline', color: 'gold' },
        { classes: 't-title', color: 'parchment' },
        { classes: 't-section' },
        { classes: 't-meta' },
        { classes: 't-label t-faint' },
        { classes: 't-talk' },
        { classes: 't-code t-soft' }
      ],
      texts
    }
  }),
  // The two motion states draw the redesigned button (design lead ruling, tokens-port question
  // 5): Enter beside the overlay plate it replays, Press as the primary button alone.
  'foundations/motion#enter': (_sample, texts) => ({ component: EnterFrame, props: { texts } }),
  'foundations/motion#press': button({ labelled: true, variant: 'primary' }),
  // Specimens with no view yet. The presets draw the page header, the mine card and two bubbles
  // in each preset, none rebuilt yet.
  'foundations/type-presets#dwarfai-pixel-clean-readable': unbuilt,

  // The icon registry at both scales, and the tones on the close and check icons.
  'atoms/icon#registry-at-2x': (_sample, texts) => ({
    component: IconSheet,
    props: { scale: 2, texts }
  }),
  'atoms/icon#registry-at-1x': (_sample, texts) => ({
    component: IconSheet,
    props: { scale: 1, texts }
  }),
  'atoms/icon#tones': () => ({
    component: IconRow,
    props: {
      icons: [{ name: 'close', tone: 'danger' }, { name: 'close', tone: 'dim' }, { name: 'check' }]
    }
  }),

  // The button's states, each in the kit's row frame; `state` forces the look a pointer or the
  // keyboard would give, as the kit's own option does.
  'atoms/button#secondary': buttonRow(STATES.map((state) => ({ labelled: true, state }))),
  'atoms/button#primary': buttonRow(
    STATES.map((state) => ({ labelled: true, variant: 'primary', icon: 'send', state }))
  ),
  'atoms/button#danger': buttonRow(
    STATES.slice(0, 3).map((state) => ({ labelled: true, variant: 'danger', state }))
  ),
  'atoms/button#disabled': buttonRow([
    { labelled: true, variant: 'primary', disabled: true },
    { labelled: true, disabled: true },
    { icon: 'attach', title: 'attach', disabled: true }
  ]),
  'atoms/button#toggle': buttonRow([
    { icon: 'ambience-on', title: 'ambience-on', pressed: false },
    { icon: 'ambience-on', title: 'ambience-on', pressed: true },
    { labelled: true, pressed: true }
  ]),
  'atoms/button#icon-only': buttonRow([
    { icon: 'history', title: 'history' },
    { icon: 'close', title: 'close' },
    { icon: 'more', title: 'more', state: 'hover' },
    { icon: 'more', title: 'more', size: 'sm' },
    { icon: 'info', title: 'info', size: 'sm' }
  ]),
  'atoms/button#large-primary': button({ labelled: true, variant: 'primary', size: 'lg' }),
  'atoms/button#link': buttonRow(
    STATES.slice(0, 2).map((state) => ({ labelled: true, variant: 'link', state }))
  ),

  // The form controls not built yet (#635): each state mounts an empty box and fails.
  // The input's states, each in the kit's frame; `state` forces the look a pointer or the
  // keyboard would give, as the kit's own option does.
  'atoms/input#text': fields([{}]),
  'atoms/input#hover': fields([{ state: 'hover' }]),
  'atoms/input#focus': fields([{ state: 'focus' }]),
  'atoms/input#search': fields([{ search: true }, { search: true }]),
  'atoms/input#invalid': fields([{ invalid: true }], { hint: true }),
  'atoms/input#disabled': fields([{}]),
  'atoms/input#textarea': fields([{ area: true }], { control: 'textarea' }),

  // The select at rest, forced to hover and to focus, in the kit's row; disabled alone.
  'atoms/select#default-hover-focus': framed((_texts, attributes) =>
    selectsOf(attributes).map((props, i) => ({
      component: SelectField,
      props: { ...props, state: [undefined, 'hover', 'focus'][i] }
    }))
  ),
  'atoms/select#disabled': (_sample, _texts, attributes) => ({
    component: SelectField,
    props: selectsOf(attributes)[0]!
  }),
  'atoms/toggle#off-on': unbuilt,
  'atoms/toggle#hover-pressed-focus': unbuilt,
  'atoms/toggle#disabled': unbuilt,
  'atoms/slider#default': unbuilt,
  'atoms/slider#hover': unbuilt,
  'atoms/slider#muted-full': unbuilt,
  'atoms/slider#disabled': unbuilt,
  'atoms/chip#choice-chip': unbuilt,
  'atoms/chip#tier-filter-chips': unbuilt,
  'atoms/chip#tier-chips': unbuilt,
  'atoms/chip#meta-chips': unbuilt
}
