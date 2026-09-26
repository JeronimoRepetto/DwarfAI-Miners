/*
 * The foundations specimens (#635): golden-only views of the app's own tokens, drawn in the
 * element tree the design's anatomy gives each `foundations/*` state. They are not product
 * components and nothing in the product imports them; golden.html alone reaches them, through
 * renders.ts.
 *
 * A specimen reads every value through `var(--token)` and the app's own classes (`.m-mat`,
 * `.t-meta`…), never a literal, so it grades what the app paints. The `kit-*` classes are the UI
 * kit's framing, styled by the stage CSS the harness reads from the design at run time.
 *
 * Two kinds of text, and neither is committed here. A value readout is the app's own token read
 * back from the document root, trimmed, which is how the design computes it (design lead ruling,
 * tokens-port question 1): a token the app never ported reads empty and keeps its state red.
 * Captions are design text: the harness reads them from the anatomy at run time and hands them in
 * as `texts`, in tree order (question 2).
 */
import { defineComponent, h, type Component, type PropType } from 'vue'
import ActionButton from '../components/controls/ActionButton.vue'
import PixelIcon from '../components/icon/PixelIcon.vue'
import type { IconName } from '../lib/icon/iconGrids'

/** One text of a state's anatomy tree: plain text, or content the tree gives as HTML. */
export interface GoldenText {
  text?: string
  html?: string
}

const names = { type: Array as PropType<readonly string[]>, required: true } as const
const texts = { type: Array as PropType<readonly GoldenText[]>, default: () => [] } as const

// The token exactly as the app's stylesheets author it, trimmed.
const readout = (name: string): string =>
  getComputedStyle(document.documentElement)
    .getPropertyValue('--' + name)
    .trim()

// A caption's content: its HTML set as HTML, else its text as text.
const content = (entry: GoldenText | undefined): Record<string, unknown> =>
  entry?.html !== undefined ? { innerHTML: entry.html } : { textContent: entry?.text ?? '' }

// One chip, name and value per token name, in order.
export const SwatchSheet = defineComponent({
  props: { names },
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'kit-swatches' },
        props.names.map((name) =>
          h('div', { class: 'kit-swatch' }, [
            h('span', { class: 'kit-swatch__chip', style: { background: 'var(--' + name + ')' } }),
            h('b', { class: 't-meta' }, '--' + name),
            h('span', { class: 't-meta t-faint' }, readout(name))
          ])
        )
      )
  }
})

// Each name with its value, no chip.
export const TokenList = defineComponent({
  props: { names },
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'kit-tokens' },
        props.names.map((name) =>
          h('div', { class: 'kit-token' }, [
            h('b', { class: 't-meta' }, '--' + name),
            h('span', { class: 't-meta t-faint' }, readout(name))
          ])
        )
      )
  }
})

// A row of material plates, `.kit-plate.m-mat` plus each entry's classes, each with its caption.
export const PlateRow = defineComponent({
  props: { plates: names, texts },
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'kit-row' },
        props.plates.map((classes, i) =>
          h('div', { class: 'kit-plate m-mat ' + classes }, [
            h('span', { class: 't-meta', ...content(props.texts[i]) })
          ])
        )
      )
  }
})

// The UI kit's own frame for the Rules state: a plain div with an inline style (README, "Frames
// that are not the component"), around the app's rule and its caption.
export const RuleFrame = defineComponent({
  props: { texts },
  setup(props) {
    return () =>
      h('div', { style: { width: '240px', display: 'grid', gap: '10px' } }, [
        h('hr', { class: 'm-rule' }),
        h('span', { class: 't-meta t-faint', ...content(props.texts[0]) })
      ])
  }
})

/** One line of the type scale: its role classes and the kit's inline colour, if any. */
export interface ScaleLine {
  classes: string
  color?: string
}

// The type scale: one paragraph per role, in the kit's grid frame, each with its caption.
export const TypeScale = defineComponent({
  props: {
    lines: { type: Array as PropType<readonly ScaleLine[]>, required: true },
    texts
  },
  setup(props) {
    return () =>
      h(
        'div',
        { style: { display: 'grid', gap: '10px' } },
        props.lines.map((line, i) =>
          h('p', {
            class: line.classes,
            style: line.color === undefined ? undefined : { color: 'var(--' + line.color + ')' },
            ...content(props.texts[i])
          })
        )
      )
  }
})

/** One part a UI kit frame lays out: a real component and its props. */
export interface FramedPart {
  component: Component
  props: Record<string, unknown>
}

const parts = { type: Array as PropType<readonly FramedPart[]>, required: true } as const

// The UI kit's row frame around a component's states: a plain div with an inline style (README,
// "Frames that are not the component"), holding the real components side by side.
export const KitRow = defineComponent({
  props: { parts },
  setup(props) {
    return () =>
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        props.parts.map((part) => h(part.component, part.props))
      )
  }
})

// The motion Enter state: the kit's grid frame around the app's button and the overlay plate the
// button replays. Graded at rest, after the entry has played; the replay itself is the kit's
// demo, and the specimen does not wire it.
export const EnterFrame = defineComponent({
  props: { texts },
  setup(props) {
    return () =>
      h('div', { style: { display: 'grid', gap: '10px', justifyItems: 'start' } }, [
        h(ActionButton, { label: props.texts[0]?.text ?? '' }),
        h('div', { class: 'kit-plate m-mat m-wood' }, [
          h('span', { class: 't-meta', ...content(props.texts[1]) })
        ])
      ])
  }
})

// The icon registry sheet: every icon in a bevelled wood cell over its name. The sheet is the
// design's demo layout, not product UI, so its rules from icon.css ride inline here; each cell's
// caption is its icon's name, handed in with the state's texts, so the tree order is the sheet's.
export const IconSheet = defineComponent({
  props: { scale: { type: Number as PropType<1 | 2>, required: true }, texts },
  setup(props) {
    const column = props.scale === 2 ? '84px' : '72px'
    return () =>
      h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(' + column + ', 1fr))',
            gap: '8px'
          }
        },
        props.texts.map((caption) =>
          h(
            'div',
            {
              style: {
                display: 'grid',
                gap: '6px',
                padding: '8px 4px',
                background: 'var(--wood)',
                boxShadow: 'inset 2px 2px 0 0 var(--wood-hi), inset -2px -2px 0 0 var(--wood-lo)',
                justifyItems: 'center'
              }
            },
            [
              h(PixelIcon, { name: (caption.text ?? '') as IconName, scale: props.scale }),
              h('span', { class: 't-meta t-faint', ...content(caption) })
            ]
          )
        )
      )
  }
})

/** One icon of a row: its registry name and tone, at 2x. */
export interface IconSpec {
  name: IconName
  tone?: 'danger' | 'dim' | 'ok'
}

// The Tones state: the kit's plain flex frame around three icons at 2x.
export const IconRow = defineComponent({
  props: { icons: { type: Array as PropType<readonly IconSpec[]>, required: true } },
  setup(props) {
    return () =>
      h(
        'div',
        { style: { display: 'flex', gap: '12px' } },
        props.icons.map((icon) => h(PixelIcon, { ...icon, scale: 2 }))
      )
  }
})

// A specimen not built yet: one empty box, so the state is mounted and graded, and fails.
export const Unbuilt = defineComponent({
  setup() {
    return () => h('div')
  }
})
