<script setup lang="ts">
/*
 * The redesigned map marker (#635), `atoms/marker` in the design: a tier hexagon over a stepped
 * pulse halo, with the "?" bubble in place of the gem when a dwarf there needs you. The caller
 * places it (left and top in image percent, never pixels) and it centres itself on that point.
 * Beside MineMarker, which today's map still draws, not a replacement for it. What the options
 * decide is in lib/map/tierMarker; this only draws it.
 */
import { computed } from 'vue'
import {
  tierMarkerAttributes,
  tierMarkerClasses,
  type TierMarkerOptions
} from '../../lib/map/tierMarker'

const props = withDefaults(defineProps<TierMarkerOptions>(), {
  asking: false,
  label: undefined,
  selected: false,
  state: undefined
})

const classes = computed(() => tierMarkerClasses(props))
const attributes = computed(() => tierMarkerAttributes(props))
</script>

<template>
  <button :class="classes" v-bind="attributes">
    <span class="dm-marker__pulse"></span>
    <span class="dm-marker__gem"><span v-if="asking" class="dm-marker__q">?</span></span>
  </button>
</template>

<style scoped>
/* The design's marker.css, rule for rule and in its order. */
.dm-marker {
  --hex: polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%);
  display: grid;
  width: var(--hit);
  height: var(--hit);
  position: relative;
  transform: translate(-50%, -50%);
  place-items: center;
}
.dm-marker__gem,
.dm-marker__pulse {
  width: 16px;
  height: 14px;
  grid-area: 1 / 1;
  clip-path: var(--hex);
}
.dm-marker__gem {
  display: grid;
  position: relative;
  background: var(--rock-lo);
  place-items: center;
  transition: transform var(--dur-fast) var(--ease-step);
}
.dm-marker__gem::before {
  content: '';
  width: 12px;
  height: 10px;
  background: linear-gradient(135deg, var(--tier-c) 0 65%, var(--tier-lo) 65% 100%);
  clip-path: var(--hex);
}
.dm-marker__pulse {
  width: 22px;
  height: 20px;
  background: var(--tier-c);
  opacity: 0;
  animation: dm-pulse var(--dur-pulse) steps(6, end) infinite;
}
.dm-marker:hover .dm-marker__gem,
.dm-marker.is-hover .dm-marker__gem {
  transform: scale(1.25);
}
.dm-marker:active .dm-marker__gem,
.dm-marker.is-active .dm-marker__gem {
  transform: translateY(2px);
}
.dm-marker[aria-pressed='true'] .dm-marker__gem {
  background: var(--parchment);
}
.dm-marker--ask .dm-marker__gem {
  width: 24px;
  height: 22px;
  background: var(--rock-lo);
}
.dm-marker--ask .dm-marker__gem::before {
  display: none;
}
.dm-marker--ask .dm-marker__q {
  width: 20px;
  height: 18px;
  font: var(--fs-meta) / 18px var(--f-meta);
  background: var(--brass);
  color: var(--ink-on-light);
  grid-area: 1 / 1;
  clip-path: var(--hex);
  text-align: center;
  animation: dm-bob 1s steps(1, end) infinite;
}
.dm-marker--ask .dm-marker__pulse {
  width: 32px;
  height: 30px;
  background: var(--brass);
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
