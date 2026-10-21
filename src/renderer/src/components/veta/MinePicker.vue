<script setup lang="ts">
/*
 * The mine picker (US-LAUNCH-007; 07 machine 22 `picker-open`, `picker-empty`; ISSUE-288), `molecules/mine-picker` in
 * the design (DS/docs/components.md, Mine picker; DS/docs/anatomy.md): a dialog named "Choose a mine" holding its
 * title, the search field, a listbox of every live mine, the line under it and "+ Add a mine". Presentational: what
 * the rows are, how the search matches and where the arrows go are `lib/veta/minePicker.ts`'s; its container
 * (`VetaApp`, through `useMinePicker`) decides what a pick or Add a mine does.
 *
 * - Focus lands in the search when it opens (`focusSearch`, called once the window has grown for it). Typing filters
 *   at once (AC03); an active search shows "Clear search" (the input atom's own control, AC05).
 * - ↑ ↓ cycle the search, the enabled visible rows and Add a mine, wrapping (AC10). Enter in the search does nothing
 *   (AC12); Enter on a row is its click (AC11). A disabled row is never picked (AC08).
 * - Esc asks to close (AC15); with text in the search the input atom's Esc clears it first, as everywhere.
 * - A refusal of Add a mine shows under the list, as the Mines page shows it (S22.15).
 */
import { t, type MineId } from '@dwarfai/contracts'
import { computed, ref } from 'vue'
import InputField from '../controls/InputField.vue'
import TierChip from '../controls/TierChip.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import {
  filterRows,
  focusStops,
  nextFocus,
  pickerNotice,
  type FocusStop,
  type PickerRow
} from '../../lib/veta/minePicker'

const props = defineProps<{
  rows: PickerRow[]
  /** Why the last Add a mine added nothing (S22.15), or `null`. */
  notice: string | null
}>()

const emit = defineEmits<{
  pick: [mineId: MineId]
  add: []
  close: []
  /** Typing or an arrow key (07 S22.18). */
  filter: []
}>()

const root = ref<HTMLElement | null>(null)
const query = ref('')

const visible = computed(() => filterRows(props.rows, query.value))
const none = computed(() => pickerNotice(props.rows.length, visible.value.length))
const stops = computed(() => focusStops(visible.value))

function type(value: string): void {
  query.value = value
  emit('filter')
}

function element(stop: FocusStop): HTMLElement | null {
  const box = root.value
  if (box === null) return null
  if (stop.kind === 'search') return box.querySelector('input')
  if (stop.kind === 'add') return box.querySelector('[data-picker-add]')
  return box.querySelector(`[data-mine="${stop.mineId}"]`)
}

/** Where the focus is among the stops, or -1 outside them. */
function current(): number {
  const on = document.activeElement
  return stops.value.findIndex((stop) => element(stop) === on)
}

function pick(row: PickerRow): void {
  if (!row.disabled) emit('pick', row.mineId)
}

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  const to = nextFocus(stops.value, Math.max(current(), 0), event.key)
  if (to === undefined) return
  event.preventDefault()
  const stop = stops.value[to]
  if (stop !== undefined) element(stop)?.focus()
  emit('filter')
}

function rowKey(event: KeyboardEvent, row: PickerRow): void {
  if (event.key !== 'Enter') return
  // Enter on a row is its click, once: the native click it would also fire is cancelled.
  event.preventDefault()
  pick(row)
}

defineExpose({
  focusSearch: (): void => {
    root.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }
})
</script>

<template>
  <div
    ref="root"
    class="dm-picker m-mat m-raised"
    role="dialog"
    :aria-label="t('minePicker.label')"
    data-mine-picker
    @keydown="keydown"
  >
    <p class="dm-picker__title">{{ t('minePicker.title') }}</p>
    <InputField
      search
      :value="query"
      :placeholder="t('minePicker.search')"
      :label="t('minePicker.search')"
      @update:value="type"
    />
    <div class="dm-picker__list" role="listbox" :aria-label="t('minePicker.list.label')">
      <button
        v-for="row in visible"
        :key="row.mineId"
        class="dm-picker__opt dm-focus-inset"
        type="button"
        role="option"
        aria-selected="false"
        :disabled="row.disabled"
        :title="row.title"
        :data-mine="row.mineId"
        @click="pick(row)"
        @keydown="rowKey($event, row)"
      >
        <TierChip :tier="row.tier" /><span class="dm-picker__name">{{ row.name }}</span
        ><span class="dm-picker__hint">{{ row.hint }}</span>
      </button>
    </div>
    <p v-if="none !== null" class="dm-picker__none">{{ none }}</p>
    <!-- A refused Add a mine has no design of its own here: the Mines page's plain line (S22.15). -->
    <p v-if="notice !== null" class="dm-picker__notice" role="alert">{{ notice }}</p>
    <hr class="m-rule" />
    <button
      class="dm-picker__add dm-focus-inset"
      type="button"
      data-picker-add
      @click="emit('add')"
    >
      <PixelIcon name="add" />{{ t('minePicker.add') }}
    </button>
  </div>
</template>

<style scoped>
/* The design's mine-picker.css, rule for rule (DS/docs/components.md, Mine picker, Geometry). */
.dm-picker {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  box-sizing: border-box;
  width: 320px;
  gap: 6px;
  padding: 8px;
  z-index: var(--z-menu);
}
.dm-picker__title {
  margin: 0;
  padding: 2px 2px 0;
  font: var(--fs-meta) / 1 var(--f-meta);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.dm-picker__list {
  display: grid;
  max-height: 240px;
  overflow-y: auto;
}
.dm-picker__opt,
.dm-picker__add {
  display: flex;
  min-height: var(--row);
  gap: 8px;
  padding: 0 8px;
  color: var(--ink);
  align-items: center;
  text-align: left;
}
.dm-picker__opt:hover:not(:disabled),
.dm-picker__opt:focus-visible,
.dm-picker__add:hover,
.dm-picker__add:focus-visible {
  background: var(--hover-wash);
  box-shadow: inset 2px 0 0 0 var(--brass);
}
.dm-picker__opt:disabled {
  color: var(--ink-faint);
}
.dm-picker__opt:disabled :deep(.dm-tier) {
  opacity: 0.5;
}
.dm-picker__name {
  flex: 1;
  min-width: 0;
  font: var(--fs-section) / 1.1 var(--f-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-picker__hint {
  max-width: 120px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-picker__none {
  margin: 0;
  padding: 8px;
  font: var(--fs-body) / 1.35 var(--f-talk);
  color: var(--ink-soft);
}
/* The Mines page's notice line (MinesList `.dm-mines__notice`). */
.dm-picker__notice {
  margin: 0;
  padding: 4px;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink);
}
.dm-picker__add {
  font: var(--fs-section) / 1 var(--f-label);
  color: var(--brass);
}
/* The input atom draws its own "Clear search"; Chromium's own cancel glyph on a search field would be a second one. */
.dm-picker :deep(input::-webkit-search-cancel-button) {
  appearance: none;
  display: none;
}
</style>
