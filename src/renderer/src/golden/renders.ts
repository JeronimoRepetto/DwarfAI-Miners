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
import TierProgress from '../components/browse/TierProgress.vue'
import TierMarker from '../components/map/TierMarker.vue'
import ChoiceChip from '../components/controls/ChoiceChip.vue'
import FieldHint from '../components/controls/FieldHint.vue'
import InputField from '../components/controls/InputField.vue'
import MetaChip from '../components/controls/MetaChip.vue'
import SelectField from '../components/controls/SelectField.vue'
import TierChip from '../components/controls/TierChip.vue'
import OreCapsule from '../components/vault/OreCapsule.vue'
import ToggleSwitch from '../components/controls/ToggleSwitch.vue'
import CountBadge from '../components/dwarf/CountBadge.vue'
import DwarfPortrait from '../components/dwarf/DwarfPortrait.vue'
import StatePill from '../components/dwarf/StatePill.vue'
import VolumeSlider from '../components/controls/VolumeSlider.vue'
import NavSlot from '../components/shell/NavSlot.vue'
import ShellNav from '../components/shell/ShellNav.vue'
import type { BadgeTone, PillTone } from '../lib/dwarf/badge'
import type { PortraitStatus } from '../lib/dwarf/portrait'
import type { IconName } from '../lib/icon/iconGrids'
import type { DwarfRole, Material, MineTier } from '../types'
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

// Each switch of the tree, named and set as it prints, with the look each is forced to.
const toggles = (states: (string | undefined)[] = []): Render =>
  framed((_texts, attributes) =>
    elementsOf(attributes, 'button.dm-toggle').map((button, i) => ({
      component: ToggleSwitch,
      props: {
        label: button['aria-label'] ?? '',
        on: button['aria-checked'] === 'true',
        disabled: 'disabled' in button,
        state: states[i]
      }
    }))
  )

// Each range of the tree, named and set as it prints, with the look each is forced to.
const sliders = (states: (string | undefined)[] = []): Render =>
  framed((_texts, attributes) =>
    elementsOf(attributes, 'input').map((range, i) => ({
      component: VolumeSlider,
      props: {
        label: range['aria-label'] ?? '',
        value: Number(range.value),
        disabled: 'disabled' in range,
        state: states[i]
      }
    }))
  )

// Each choice chip of the tree, its label the next text, pressed, disabled and tiered as it
// prints, with the look each is forced to.
const choiceChips = (states: (string | undefined)[] = []): Render =>
  framed((texts, attributes) =>
    elementsOf(attributes, 'button.dm-chip').map((chip, i) => ({
      component: ChoiceChip,
      props: {
        label: texts[i]?.text ?? '',
        ...(chip['aria-pressed'] === undefined ? {} : { pressed: chip['aria-pressed'] === 'true' }),
        ...(chip['data-tier'] === undefined ? {} : { tier: chip['data-tier'] as MineTier }),
        disabled: 'disabled' in chip,
        state: states[i]
      }
    }))
  )

// The modifier a tree's element carries for a block, as `span.dm-badge.dm-badge--info` carries
// `info`: a tone is a class, so it arrives with the tree like the rest of its design.
const modifierOf = (element: string, block: string): string | undefined =>
  element
    .split('.')
    .find((c) => c.startsWith(block + '--'))
    ?.slice(block.length + 2)

// Each badge of the tree, its count read back from the text it shows: "99+" is a count past 99.
const badges: Render = framed((texts, attributes) =>
  attributes
    .filter((entry) => entry.element.startsWith('span.dm-badge'))
    .map((entry, i) => {
      const shown = texts[i]?.text ?? ''
      return {
        component: CountBadge,
        props: {
          count: shown.endsWith('+') ? Number(shown.slice(0, -1)) + 1 : Number(shown),
          tone: modifierOf(entry.element, 'dm-badge') as BadgeTone | undefined
        }
      }
    })
)

/*
 * Each pill of the tree in its tone, with the needs-you plate its tree draws inside it, its mark
 * and word the next texts. An icon line prints no name a render can read, so a state's icons are
 * its render's, in tree order, as a button's are.
 */
const pills = (icons: IconName[] = []): Render =>
  framed((texts, attributes) => {
    const specs: { tone?: PillTone; ask: boolean; icon?: IconName }[] = []
    let icon = 0
    for (const { element } of attributes.slice(1)) {
      if (element.startsWith('span.dm-pill__q')) specs.at(-1)!.ask = true
      else if (element.startsWith('span.dm-pill')) {
        specs.push({ tone: modifierOf(element, 'dm-pill') as PillTone | undefined, ask: false })
      } else if (element === 'icon') specs.at(-1)!.icon = icons[icon++]
    }
    let next = 0
    return specs.map((spec) => {
      const mark = spec.ask ? texts[next++]?.text : undefined
      return {
        component: StatePill,
        props: { ...spec, ...(mark === undefined ? {} : { mark }), text: texts[next++]?.text ?? '' }
      }
    })
  })

// The state a tree's element is forced to, as `button.dm-slot.is-hover` is.
const forcedOf = (element: string): string | undefined =>
  element
    .split('.')
    .find((c) => c.startsWith('is-'))
    ?.slice(3)

/*
 * Each slot of the tree, labelled, current, pressed, warned and forced as it prints, its badge
 * the count the next badge line shows. An icon line prints no name a render can read, so the
 * state's icons are its render's, in tree order.
 */
const slots =
  (icons: IconName[]): Render =>
  (_sample, texts, attributes) => {
    const parts: FramedPart[] = []
    let badge = 0
    for (const { element, attributes: a } of attributes.slice(1)) {
      if (element.startsWith('button.dm-slot')) {
        parts.push({
          component: NavSlot,
          props: {
            icon: icons[parts.length],
            label: a['data-label'] ?? '',
            current: a['aria-current'] === 'page',
            ...(a['aria-pressed'] === undefined ? {} : { pressed: a['aria-pressed'] === 'true' }),
            warn: a['data-warn'] === 'true',
            state: forcedOf(element)
          }
        })
      } else if (element.startsWith('span.dm-badge')) {
        parts.at(-1)!.props.badge = Number(texts[badge++]?.text)
      }
    }
    return {
      component: KitFrame,
      props: { style: attributes[0]?.attributes.style ?? '', parts }
    }
  }

/*
 * Each portrait of the tree, in its status, size and forced look, a button (named, pressed) where
 * the tree draws one. Its face line prints a path, not an attribute a render can read, so the
 * state's ranks are its render's, in tree order.
 */
const portraits = (roles: DwarfRole[]): Render =>
  framed((_texts, attributes) =>
    attributes
      .filter((entry) => /^(span|button)\.dm-portrait(\.|$)/.test(entry.element))
      .map(({ element, attributes: a }, i) => ({
        component: DwarfPortrait,
        props: {
          role: roles[i],
          status: a['data-status'] as PortraitStatus,
          size: modifierOf(element, 'dm-portrait'),
          interactive: element.startsWith('button'),
          name: (a['aria-label'] ?? '').split(', ')[0],
          selected: a['aria-pressed'] === 'true',
          state: forcedOf(element)
        }
      }))
  )

/*
 * The tier progress the tree prints, in the kit's width frame: toward the tier its root names,
 * value and maximum read from the bar's own aria values; measuring where the root is a status;
 * the top tier where it carries --max, its value the number it shows.
 */
const progress: Render = framed((texts, attributes) => {
  const root = attributes.find((entry) => entry.element.startsWith('div.dm-progress'))!
  const bar = attributes.find((entry) => entry.attributes.role === 'progressbar')?.attributes
  if (root.attributes.role === 'status')
    return [{ component: TierProgress, props: { measuring: true } }]
  if (root.element.includes('dm-progress--max')) {
    const shown = texts.at(-1)?.text ?? ''
    return [
      { component: TierProgress, props: { maxTier: true, value: Number(shown.replace(/,/g, '')) } }
    ]
  }
  return [
    {
      component: TierProgress,
      props: {
        nextTier: root.attributes['data-tier'] as MineTier,
        value: Number(bar?.['aria-valuenow']),
        max: Number(bar?.['aria-valuemax'])
      }
    }
  ]
})

// One capsule as its tree names it ("Coal: 280,612"): the material and its full count.
const capsule = ({ element, attributes: a }: GoldenAttributes): Record<string, unknown> => {
  const [label = '', count = ''] = (a['aria-label'] ?? '').split(': ')
  return {
    material: label.toLowerCase() as Material,
    units: Number(count.replace(/,/g, '')),
    size: modifierOf(element, 'dm-ore') === 'lg' ? 'lg' : undefined
  }
}
const capsules = (attributes: GoldenAttributes[]): GoldenAttributes[] =>
  attributes.filter((entry) => entry.element.startsWith('span.dm-ore'))
// Every material in the kit's row, and a capsule alone as the stage's only child.
const oreRow: Render = framed((_texts, attributes) =>
  capsules(attributes).map((entry) => ({ component: OreCapsule, props: capsule(entry) }))
)
const oreAlone: Render = (_sample, _texts, attributes) => ({
  component: OreCapsule,
  props: capsule(capsules(attributes)[0]!)
})

/*
 * The markers of the tree, each inside the one-pixel point the kit places it on (a plain div
 * with the style the tree prints), all in the kit's frame: tiered, named, open, asking and
 * forced as each prints. The marker centres itself on its point.
 */
const markers: Render = (_sample, _texts, attributes) => {
  const points: FramedPart[] = []
  for (const { element, attributes: a } of attributes.slice(1)) {
    if (element === 'div') {
      points.push({ component: KitFrame, props: { style: a.style ?? '', parts: [] } })
    } else if (element.startsWith('button.dm-marker')) {
      ;(points.at(-1)!.props.parts as FramedPart[]).push({
        component: TierMarker,
        props: {
          tier: a['data-tier'] as MineTier,
          label: a['aria-label'],
          selected: a['aria-pressed'] === 'true',
          asking: element.split('.').includes('dm-marker--ask'),
          state: forcedOf(element)
        }
      })
    }
  }
  return {
    component: KitFrame,
    props: { style: attributes[0]?.attributes.style ?? '', parts: points }
  }
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
  // The toggle's states in the kit's row: hover, pressed while on, and focus are forced looks.
  'atoms/toggle#off-on': toggles(),
  'atoms/toggle#hover-pressed-focus': toggles(['hover', 'active', 'focus']),
  'atoms/toggle#disabled': toggles(),

  // The slider's states, each in the kit's frame; hover is a forced look.
  'atoms/slider#default': sliders(),
  'atoms/slider#hover': sliders(['hover']),
  'atoms/slider#muted-full': sliders(),
  'atoms/slider#disabled': sliders(),
  // The chips in the kit's row: a choice chip at rest, forced to hover and to press, pressed,
  // disabled and forced to focus; the tier filters in canonical order; the tier chips, whose word
  // is the chip's own; and the meta chips, each fact the next text.
  'atoms/chip#choice-chip': choiceChips([
    undefined,
    'hover',
    'active',
    undefined,
    undefined,
    'focus'
  ]),
  'atoms/chip#tier-filter-chips': choiceChips(),
  'atoms/chip#tier-chips': framed((_texts, attributes) =>
    elementsOf(attributes, 'span.dm-tier').map((chip) => ({
      component: TierChip,
      props: { tier: chip['data-tier'] as MineTier }
    }))
  ),
  'atoms/chip#meta-chips': framed((texts) =>
    texts.map((fact) => ({ component: MetaChip, props: { text: fact.text ?? '' } }))
  ),

  // The nav slots in the kit's row: at rest, hovered and pressed; current; badged; the music
  // toggle; warned; focused; the mode lever.
  'atoms/slot#default-hover-pressed': slots(['map', 'map', 'map']),
  'atoms/slot#current-page': slots(['mines']),
  'atoms/slot#needs-you-badge': slots(['mines', 'mines']),
  'atoms/slot#toggle': slots(['music-off', 'music-on']),
  'atoms/slot#warning': slots(['settings']),
  'atoms/slot#focus-visible': slots(['settings']),
  'atoms/slot#mode-lever': slots(['valle', 'veta']),

  // The portraits: the three ranks, the five statuses, the interaction looks, the three sizes.
  'atoms/portrait#ranks': portraits(['worker', 'worker2', 'foreman']),
  'atoms/portrait#status': portraits(['worker', 'worker2', 'foreman', 'worker', 'worker2']),
  'atoms/portrait#interaction': portraits(['worker', 'worker', 'worker', 'worker']),
  'atoms/portrait#sizes': portraits(['foreman', 'foreman', 'foreman']),

  // The tier progress toward Gold and toward Copper, measuring, and at the top tier.
  'atoms/progress#toward-gold': progress,
  'atoms/progress#toward-copper': progress,
  'atoms/progress#measuring': progress,
  'atoms/progress#max-tier': progress,

  // The ore capsules: every material, poorest first; the vault size; a material at zero.
  'atoms/ore#every-material': oreRow,
  'atoms/ore#large': oreAlone,
  'atoms/ore#zero': oreAlone,

  // The map markers on their points: every tier; hovered, pressed and open; asking; focused.
  // The badges in their tones and overflow, and the pills: the crew states, then the semantic tones.
  'atoms/badge#badges': badges,
  'atoms/badge#crew-state-pills': pills(),
  'atoms/badge#semantic-pills': pills(['check']),
  'atoms/marker#tiers': markers,
  'atoms/marker#hover-pressed-open': markers,
  'atoms/marker#needs-you': markers,
  'atoms/marker#focus-visible': markers
}
