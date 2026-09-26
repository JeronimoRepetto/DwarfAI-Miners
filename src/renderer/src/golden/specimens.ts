/*
 * The foundations specimens (#635): golden-only views of the app's own tokens, drawn in the
 * element tree the design's anatomy gives each `foundations/*` state. They are not product
 * components and nothing in the product imports them; golden.html alone reaches them, through
 * renders.ts.
 *
 * A specimen reads every value through `var(--token)` and the app's own classes (`.m-mat`,
 * `.t-meta`…), never a literal, so it grades what the app paints: a token the app has not ported
 * yet paints nothing, and the state stays red for that reason. The `kit-*` classes are the UI
 * kit's framing, styled by the stage CSS the harness reads from the design at run time.
 *
 * The captions and value readouts the anatomy shows are not drawn yet. Their text is design text,
 * which this repository does not carry until the design repository rules on it (TOKENS-QUESTIONS),
 * and a missing caption only keeps a red state red.
 */
import { defineComponent, h, type PropType } from 'vue'

const names = { type: Array as PropType<readonly string[]>, required: true } as const

// One chip, name and value per token name, in order (the value readout is not drawn yet).
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
            h('span', { class: 't-meta t-faint' })
          ])
        )
      )
  }
})

// Each name with its value, no chip (the value readout is not drawn yet).
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
            h('span', { class: 't-meta t-faint' })
          ])
        )
      )
  }
})

// A row of material plates, `.kit-plate.m-mat` plus each entry's classes (caption not drawn yet).
export const PlateRow = defineComponent({
  props: { plates: names },
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'kit-row' },
        props.plates.map((classes) =>
          h('div', { class: 'kit-plate m-mat ' + classes }, [h('span', { class: 't-meta' })])
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
