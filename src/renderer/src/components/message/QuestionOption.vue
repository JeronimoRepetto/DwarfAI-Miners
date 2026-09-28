<script setup lang="ts">
/*
 * The question option (#635), `molecules/question-option` in the design: a 40px row with the
 * 12px box, the label and its number key on the right. Picked, the row turns gold and its box
 * fills; no check glyph is drawn. Picking never sends. A click falls through to the native
 * button, which the card listens to.
 *
 * A description the agent sent shows as Small text under the label, inside the same row, which
 * grows past 40px only for it; the key and the label keep their place (design lead's ruling on
 * MESSAGE-QUESTIONS 6, 2026-09-28). A toggling step's rows are checkboxes rather than radios:
 * the app's multi-select asks (#362), which the design does not draw.
 */
const props = withDefaults(
  defineProps<{
    label: string
    index: number
    checked?: boolean
    other?: boolean
    description?: string
    toggle?: boolean
    disabled?: boolean
    /** A look forced without the pointer, as the UI kit's own states show it. */
    state?: 'hover' | 'active' | 'focus'
  }>(),
  {
    checked: false,
    other: false,
    description: undefined,
    toggle: false,
    disabled: false,
    state: undefined
  }
)
</script>

<template>
  <button
    :class="[
      'dm-qopt',
      'm-mat',
      { 'dm-qopt--other': props.other },
      props.state && `is-${props.state}`
    ]"
    type="button"
    :role="toggle ? 'checkbox' : 'radio'"
    :aria-checked="checked ? 'true' : 'false'"
    :data-index="index"
    :disabled="disabled"
  >
    <span class="dm-qopt__box"></span>
    <span v-if="description" class="dm-qopt__text">
      <span class="dm-qopt__label">{{ label }}</span>
      <span class="dm-qopt__desc">{{ description }}</span>
    </span>
    <span v-else class="dm-qopt__label">{{ label }}</span>
    <span class="dm-qopt__key">{{ index + 1 }}</span>
  </button>
</template>

<style scoped>
/*
 * The design's question-option.css, rule for rule and in its order: each state repoints the
 * --mat-* variables of the material recipe (.m-mat), which paints the notched row.
 */
.dm-qopt {
  --mat-fill: var(--rock-lo);
  --mat-hi: var(--rock-hi);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--wood-hi);
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% - 4px);
  min-height: var(--row);
  margin: var(--px);
  padding: 4px 10px;
  font: 400 var(--fs-body) / 1.25 var(--f-talk);
  color: var(--ink);
  text-align: left;
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-qopt:hover,
.dm-qopt.is-hover {
  --mat-edge: var(--brass);
}
.dm-qopt:active,
.dm-qopt.is-active {
  transform: translateY(var(--px));
}
.dm-qopt[aria-checked='true'] {
  --mat-fill: var(--gold);
  --mat-hi: var(--gold-hi);
  --mat-lo: var(--gold-lo);
  --mat-edge: var(--brass-hi);
  color: var(--ink-on-light);
}
.dm-qopt__box {
  flex: none;
  width: 12px;
  height: 12px;
  background: var(--rock);
  box-shadow:
    0 0 0 var(--px) var(--wood-hi),
    inset 2px 2px 0 0 var(--rock-lo);
}
.dm-qopt[aria-checked='true'] .dm-qopt__box {
  background: var(--ink-on-light);
  box-shadow:
    0 0 0 var(--px) var(--ink-on-light),
    inset 2px 2px 0 0 var(--parch-hi);
}
.dm-qopt__key {
  margin-left: auto;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-faint);
}
.dm-qopt[aria-checked='true'] .dm-qopt__key {
  color: var(--ink-on-light-soft);
}
.dm-qopt--other {
  color: var(--ink-soft);
  font-style: normal;
}
/*
 * The description (MESSAGE-QUESTIONS 6): the label and, under it, the agent's gloss in the Small
 * text role, stacked in the label's own place so the key keeps its. The softer ink follows the
 * key's, on either fill.
 */
.dm-qopt__text {
  display: grid;
  gap: 2px;
  padding: 4px 0;
}
.dm-qopt__desc {
  font: 400 var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-soft);
}
.dm-qopt[aria-checked='true'] .dm-qopt__desc {
  color: var(--ink-on-light-soft);
}
</style>
