<script setup lang="ts">
/*
 * The redesigned slider (#635), `atoms/slider` in the design: a native 0-100 range, so dragging
 * and the arrow keys are the platform's own, drawn as a sunken track with a gold fill up to the
 * value and a brass thumb, and the percentage beside it as visible text. `--fill` is the one
 * value set at run time. What the options decide is in lib/controls/slider; this only draws it
 * and holds the volume.
 */
import { computed, ref, watch } from 'vue'
import { sliderClasses, sliderReadout, volume, type SliderOptions } from '../../lib/controls/slider'

const props = withDefaults(defineProps<SliderOptions>(), { disabled: false })
const emit = defineEmits<{ 'update:value': [value: number] }>()

const current = ref(volume(props.value))
watch(
  () => props.value,
  (value) => {
    current.value = volume(value)
  }
)

const classes = computed(() => sliderClasses(props))

function move(value: string): void {
  current.value = volume(Number(value))
  emit('update:value', current.value)
}
</script>

<template>
  <div :class="classes">
    <input
      type="range"
      :aria-label="label"
      :disabled="disabled"
      :value="current"
      :style="{ '--fill': sliderReadout(current) }"
      @input="move(($event.target as HTMLInputElement).value)"
    />
    <span class="dm-slider__value">{{ sliderReadout(current) }}</span>
  </div>
</template>

<style scoped>
/* The design's slider.css, rule for rule and in its order. */
.dm-slider {
  display: flex;
  min-height: var(--hit);
  min-width: 0;
  gap: 10px;
  align-items: center;
}
.dm-slider__value {
  min-width: 34px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dm-slider input[type='range'] {
  flex: 1;
  min-width: 80px;
  height: var(--hit);
  --fill: 50%;
  margin: 0;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.dm-slider input[type='range']:focus-visible {
  outline: var(--px) solid var(--parchment);
  outline-offset: 2px;
}
.dm-slider input[type='range']::-webkit-slider-runnable-track {
  height: 8px;
  background: linear-gradient(90deg, var(--gold) 0 var(--fill), var(--rock-lo) var(--fill) 100%);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo);
}
.dm-slider input[type='range']::-webkit-slider-thumb {
  width: 12px;
  height: 20px;
  margin-top: -6px;
  background: var(--brass);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo),
    inset 2px 2px 0 0 var(--brass-hi),
    inset -2px -2px 0 0 var(--brass-lo);
  -webkit-appearance: none;
}
.dm-slider input[type='range']:hover::-webkit-slider-thumb,
.dm-slider.is-hover input[type='range']::-webkit-slider-thumb {
  background: var(--brass-hi);
}
.dm-slider input[type='range']::-moz-range-track {
  height: 8px;
  background: var(--rock-lo);
}
.dm-slider input[type='range']::-moz-range-progress {
  height: 8px;
  background: var(--gold);
}
.dm-slider input[type='range']::-moz-range-thumb {
  width: 12px;
  height: 20px;
  background: var(--brass);
  border: 0;
  border-radius: 0;
}
.dm-slider input[type='range']:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
</style>
