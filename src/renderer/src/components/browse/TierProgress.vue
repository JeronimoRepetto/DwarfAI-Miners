<script setup lang="ts">
/*
 * The redesigned tier progress (#635), `atoms/progress` in the design: a sunken track at full
 * width with a stepped fill in the colour of the tier it leads to, and the target tier's name
 * above it. Measuring shows a stepped scan band instead of a value, announced as a status; the
 * top tier shows "Max tier" and no bar. What it shows is lib/browse/tierProgress's.
 */
import { computed } from 'vue'
import { tierProgress, type TierProgressOptions } from '../../lib/browse/tierProgress'

const props = withDefaults(defineProps<TierProgressOptions>(), {
  value: undefined,
  max: undefined,
  nextTier: undefined,
  measuring: false,
  maxTier: false,
  label: undefined
})

const view = computed(() => tierProgress(props))
</script>

<template>
  <div v-if="view.kind === 'toward'" class="dm-progress" :data-tier="view.tier">
    <div class="dm-progress__row">
      <span
        >{{ view.lead }}<b>{{ view.tierLabel }}</b></span
      >
      <span class="dm-progress__num">{{ view.numbers }}</span>
    </div>
    <div
      class="dm-progress__track"
      role="progressbar"
      :aria-valuemin="view.bar.min"
      :aria-valuemax="view.bar.max"
      :aria-valuenow="view.bar.now"
      :aria-label="view.bar.label"
    >
      <span class="dm-progress__fill" :style="{ '--p': view.fill }"></span>
    </div>
  </div>
  <div v-else-if="view.kind === 'measuring'" class="dm-progress" role="status">
    <div class="dm-progress__row">
      <b>{{ view.title }}</b>
      <span class="dm-progress__num">{{ view.numbers }}</span>
    </div>
    <div class="dm-progress__track"><span class="dm-progress__scan"></span></div>
  </div>
  <div v-else class="dm-progress dm-progress--max">
    <div class="dm-progress__row">
      <b>{{ view.title }}</b>
      <span class="dm-progress__num">{{ view.numbers }}</span>
    </div>
  </div>
</template>

<style scoped>
/* The design's progress.css, rule for rule and in its order. */
.dm-progress {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.dm-progress__row {
  display: flex;
  gap: 8px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  justify-content: space-between;
}
.dm-progress__row b {
  font-weight: 400;
  color: var(--ink);
}
.dm-progress__num {
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}
.dm-progress__track {
  height: 10px;
  position: relative;
  margin: var(--px);
  background: var(--rock-lo);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo),
    inset 0 2px 0 0 var(--rock);
  overflow: hidden;
}
.dm-progress__fill {
  position: absolute;
  inset: 0;
  transform-origin: 0 50%;
  transform: scaleX(var(--p, 0));
  background: var(--tier-c, var(--brass));
  box-shadow:
    inset 0 2px 0 0 var(--parch-hi),
    inset 0 -2px 0 0 var(--shadow-drop);
  opacity: 0.9;
  transition: transform var(--dur-panel) var(--ease-out);
}
/* The quarter marks over the track. */
.dm-progress__track::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent calc(25% - 1px),
    var(--rock-lo) calc(25% - 1px),
    var(--rock-lo) calc(25% + 1px),
    transparent calc(25% + 1px),
    transparent calc(50% - 1px),
    var(--rock-lo) calc(50% - 1px),
    var(--rock-lo) calc(50% + 1px),
    transparent calc(50% + 1px),
    transparent calc(75% - 1px),
    var(--rock-lo) calc(75% - 1px),
    var(--rock-lo) calc(75% + 1px),
    transparent calc(75% + 1px)
  );
  opacity: 0.6;
}
.dm-progress__scan {
  width: 30%;
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--glow-parch);
  animation: dm-scan 1.2s steps(8, end) infinite;
}
.dm-progress--max .dm-progress__row b {
  color: var(--tier-uranium);
}
/* The chip's tier map (controls/chip.css), repeated because each component's rules are scoped. */
[data-tier='bronze'] {
  --tier-c: var(--tier-bronze);
  --tier-lo: var(--tier-bronze-lo);
}
[data-tier='copper'] {
  --tier-c: var(--tier-copper);
  --tier-lo: var(--tier-copper-lo);
}
[data-tier='silver'] {
  --tier-c: var(--tier-silver);
  --tier-lo: var(--tier-silver-lo);
}
[data-tier='gold'] {
  --tier-c: var(--tier-gold);
  --tier-lo: var(--tier-gold-lo);
}
[data-tier='uranium'] {
  --tier-c: var(--tier-uranium);
  --tier-lo: var(--tier-uranium-lo);
}
</style>
