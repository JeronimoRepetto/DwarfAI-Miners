<script setup lang="ts">
/*
 * The redesigned input (#635), `atoms/input` in the design: a parchment well wrapped in a
 * <label>, the native control inside it, a search glyph and clear button on a search, the talk
 * face in the textarea. What the options decide is in lib/controls/input; this only draws it and
 * keeps the text. Esc inside a search with text clears it and goes no further; clearing moves
 * focus to the control, because the button that had it goes away (accessibility.md, Focus).
 */
import { computed, ref, watch } from 'vue'
import PixelIcon from '../icon/PixelIcon.vue'
import {
  escapeAction,
  fieldClasses,
  fieldControlAttributes,
  showsClear,
  type InputOptions
} from '../../lib/controls/input'

const props = withDefaults(defineProps<InputOptions>(), {
  value: '',
  search: false,
  area: false,
  disabled: false,
  invalid: false
})
const emit = defineEmits<{ 'update:value': [value: string] }>()

const current = ref(props.value)
watch(
  () => props.value,
  (value) => {
    current.value = value
  }
)
const control = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

const classes = computed(() => fieldClasses(props))
const attributes = computed(() => fieldControlAttributes(props))
const clearShown = computed(() => showsClear(props, current.value))

function edit(value: string): void {
  current.value = value
  emit('update:value', value)
}

function clear(): void {
  edit('')
  control.value?.focus()
}

function keydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || escapeAction(props, current.value) !== 'clear') return
  event.stopPropagation()
  event.preventDefault()
  edit('')
}
</script>

<template>
  <label :class="classes">
    <PixelIcon v-if="search" name="search" />
    <textarea
      v-if="area"
      ref="control"
      v-bind="attributes"
      :value="current"
      @input="edit(($event.target as HTMLTextAreaElement).value)"
    ></textarea>
    <input
      v-else
      ref="control"
      v-bind="attributes"
      :value="current"
      @input="edit(($event.target as HTMLInputElement).value)"
      @keydown="keydown"
    />
    <button
      v-if="search"
      class="dm-field__clear"
      type="button"
      title="Clear search"
      aria-label="Clear search"
      :hidden="!clearShown"
      @click="clear"
    >
      <PixelIcon name="close" />
    </button>
  </label>
</template>

<style scoped>
/*
 * The design's input.css, rule for rule and in its order: each state only repoints the --mat-*
 * variables of the material recipe (.m-mat), which paints the notched well. The glyph palette
 * rules reach into the icon atom, so they go through :deep and keep the specificity they have in
 * the design against icon.css.
 */
.dm-field {
  --mat-fill: var(--parch-hi);
  --mat-hi: var(--parch-lo);
  --mat-lo: var(--parch-hi);
  --mat-edge: var(--wood-lo);
  display: flex;
  min-height: var(--hit);
  position: relative;
  gap: 6px;
  margin: var(--px);
  padding: 0 8px;
  color: var(--ink-on-light);
  align-items: center;
  cursor: text;
}
.dm-field:hover,
.dm-field.is-hover {
  --mat-edge: var(--brass-lo);
}
.dm-field:focus-within,
.dm-field.is-focus {
  --mat-edge: var(--brass);
  outline: var(--px) solid var(--parchment);
  outline-offset: 4px;
}
.dm-field.is-invalid {
  --mat-edge: var(--danger);
}
.dm-field.is-disabled {
  --mat-fill: var(--parch-lo);
  --mat-edge: var(--wood-lo);
  color: var(--ink-on-light-soft);
  cursor: not-allowed;
}
.dm-field input,
.dm-field textarea {
  flex: 1;
  min-width: 0;
  padding: 0;
  margin: 0;
  font: var(--fs-meta) / 1.2 var(--f-meta);
  background: transparent;
  color: inherit;
  border: 0;
  outline: none;
}
.dm-field input::placeholder,
.dm-field textarea::placeholder {
  color: var(--ink-on-light-soft);
  opacity: 1;
}
.dm-field input:disabled {
  cursor: not-allowed;
}
.dm-field :deep(.dm-icon .c-o) {
  fill: var(--wood);
}
.dm-field__clear {
  display: grid;
  width: 24px;
  height: 24px;
  margin-right: -4px;
  place-items: center;
}
.dm-field__clear:hover :deep(.dm-icon .c-h),
.dm-field__clear:hover :deep(.dm-icon .c-p) {
  fill: var(--brass-lo);
}
.dm-field__clear :deep(.dm-icon .c-h),
.dm-field__clear :deep(.dm-icon .c-p),
.dm-field__clear :deep(.dm-icon .c-q) {
  fill: var(--ink-on-light-soft);
}
.dm-field__clear :deep(.c-o) {
  fill: transparent;
}
.dm-field--area {
  padding: 8px;
  align-items: stretch;
}
.dm-field--area textarea {
  min-height: 48px;
  font: var(--fs-body) / 1.35 var(--f-talk);
  resize: none;
}
</style>
