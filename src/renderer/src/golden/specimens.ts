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
import { defineComponent, h, type PropType } from 'vue'

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

// A specimen not built yet: one empty box, so the state is mounted and graded, and fails.
export const Unbuilt = defineComponent({
  setup() {
    return () => h('div')
  }
})
