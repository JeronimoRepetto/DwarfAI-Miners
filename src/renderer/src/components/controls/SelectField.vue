<script setup lang="ts">
/*
 * The redesigned select (#635), `atoms/select` in the design: a wood face over the native
 * <select> and a chevron. The native control stays, so the platform keeps its keyboard and
 * screen-reader behaviour, and its popup list is the platform's own. What the options decide is
 * in lib/controls/select; this only draws it.
 */
import { computed } from 'vue'
import PixelIcon from '../icon/PixelIcon.vue'
import {
  selectClasses,
  selectedValue,
  selectOptions,
  type SelectOptions
} from '../../lib/controls/select'

const props = withDefaults(defineProps<SelectOptions>(), { disabled: false })
const emit = defineEmits<{ 'update:value': [value: string] }>()

const classes = computed(() => selectClasses(props))
const list = computed(() => selectOptions(props.options))
const shown = computed(() => selectedValue(props))
</script>

<template>
  <span :class="classes">
    <select
      :aria-label="label"
      :disabled="disabled"
      :value="shown"
      @change="emit('update:value', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in list" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
    <PixelIcon name="chevron" />
  </span>
</template>

<style scoped>
/* The design's select.css, rule for rule and in its order. */
.dm-select {
  --mat-fill: var(--control);
  --mat-hi: var(--control-hi);
  --mat-lo: var(--control-lo);
  --mat-edge: var(--rock-lo);
  display: inline-flex;
  min-height: var(--hit);
  min-width: max-content;
  position: relative;
  margin: var(--px);
  align-items: center;
}
.dm-select:hover,
.dm-select.is-hover {
  --mat-edge: var(--brass);
}
.dm-select:focus-within,
.dm-select.is-focus {
  --mat-edge: var(--brass);
  outline: var(--px) solid var(--parchment);
  outline-offset: 4px;
}
.dm-select.is-disabled {
  --mat-fill: var(--rock);
  --mat-hi: var(--rock-hi);
  --mat-lo: var(--rock-lo);
  color: var(--ink-faint);
}
.dm-select select {
  width: 100%;
  min-width: 96px;
  height: var(--hit);
  padding: 0 28px 0 10px;
  font: var(--fs-meta) / 1 var(--f-meta);
  background: transparent;
  color: var(--ink);
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  cursor: pointer;
  outline: none;
}
.dm-select select:disabled {
  color: var(--ink-faint);
  cursor: not-allowed;
}
.dm-select select option {
  background: var(--wood);
  color: var(--ink);
}
.dm-select .dm-icon {
  position: absolute;
  right: 6px;
  pointer-events: none;
}
</style>
