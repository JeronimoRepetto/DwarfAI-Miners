<script setup lang="ts">
/*
 * The redesigned toggle (#635), `atoms/toggle` in the design: a <button role="switch"> with a
 * sunken track, a steel knob that slides to brass when on, and On or Off beside it. The label is
 * the accessible name only. A disabled native button fires no click, so it never changes. What
 * the options decide is in lib/controls/toggle; this only draws it and holds the state.
 */
import { computed, ref, watch } from 'vue'
import {
  toggleAttributes,
  toggleClasses,
  toggleStateText,
  type ToggleOptions
} from '../../lib/controls/toggle'

const props = withDefaults(defineProps<ToggleOptions>(), { on: false, disabled: false })
const emit = defineEmits<{ 'update:on': [on: boolean] }>()

const current = ref(props.on)
watch(
  () => props.on,
  (on) => {
    current.value = on
  }
)

const classes = computed(() => toggleClasses(props))
const attributes = computed(() => toggleAttributes({ ...props, on: current.value }))

function flip(): void {
  current.value = !current.value
  emit('update:on', current.value)
}
</script>

<template>
  <button :class="classes" v-bind="attributes" @click="flip">
    <span class="dm-toggle__track m-mat"><span class="dm-toggle__knob"></span></span>
    <span class="dm-toggle__state">{{ toggleStateText(current) }}</span>
  </button>
</template>

<style scoped>
/* The design's toggle.css, rule for rule and in its order. */
.dm-toggle {
  display: inline-flex;
  min-height: var(--hit);
  gap: 8px;
  padding: 0 2px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  align-items: center;
}
.dm-toggle__track {
  --mat-fill: var(--rock);
  --mat-hi: var(--rock-lo);
  --mat-lo: var(--rock-hi);
  --mat-edge: var(--rock-lo);
  width: 40px;
  height: 20px;
  position: relative;
  margin: var(--px);
}
.dm-toggle__knob {
  width: 16px;
  height: 16px;
  position: absolute;
  top: 2px;
  left: 2px;
  background: var(--steel);
  box-shadow:
    inset 2px 2px 0 0 var(--steel-hi),
    inset -2px -2px 0 0 var(--steel-lo);
  transition: transform var(--dur-fast) var(--ease-out);
}
.dm-toggle__state {
  min-width: 22px;
}
.dm-toggle[aria-checked='true'] .dm-toggle__track {
  --mat-fill: var(--gold-lo);
  --mat-hi: var(--gold-deep);
  --mat-lo: var(--gold);
}
.dm-toggle[aria-checked='true'] .dm-toggle__knob {
  transform: translateX(20px);
  background: var(--brass);
  box-shadow:
    inset 2px 2px 0 0 var(--brass-hi),
    inset -2px -2px 0 0 var(--brass-lo);
}
.dm-toggle[aria-checked='true'] .dm-toggle__state {
  color: var(--brass);
}
.dm-toggle:hover .dm-toggle__track,
.dm-toggle.is-hover .dm-toggle__track {
  --mat-edge: var(--brass);
}
.dm-toggle:active .dm-toggle__knob,
.dm-toggle.is-active .dm-toggle__knob {
  height: 14px;
  top: 4px;
}
.dm-toggle:disabled {
  color: var(--ink-faint);
}
.dm-toggle:disabled .dm-toggle__track {
  --mat-edge: var(--wood-lo);
  opacity: 0.5;
}
</style>
