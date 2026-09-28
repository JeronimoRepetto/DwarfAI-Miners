<script setup lang="ts">
/*
 * The redesigned nav slot (#635), `atoms/slot` in the design: a 40px wood slot with brass trim
 * holding a 16px icon at 2x, an optional needs-you badge or warning, and its label rising on the
 * inner side after the tooltip delay. Current turns it gold; press sinks it one art pixel. What
 * the options decide is in lib/shell/navSlot; this only draws it. Stacked slots keep a 6px gap,
 * which is the nav column's to give.
 */
import { computed } from 'vue'
import CountBadge from '../dwarf/CountBadge.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import { navSlotAttributes, navSlotClasses, type NavSlotOptions } from '../../lib/shell/navSlot'

// `pressed` defaults to undefined, not false: only a toggle states aria-pressed at all.
const props = withDefaults(defineProps<NavSlotOptions>(), {
  pressed: undefined,
  current: false,
  badge: 0,
  warn: false,
  state: undefined
})

const classes = computed(() => navSlotClasses(props))
const attributes = computed(() => navSlotAttributes(props))
</script>

<template>
  <button :class="classes" v-bind="attributes">
    <PixelIcon :name="icon" :scale="2" />
    <CountBadge v-if="badge > 0" class="dm-slot__badge" :count="badge" />
  </button>
</template>

<style scoped>
/* The design's slot.css, rule for rule and in its order. */
.dm-slot {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--brass-lo);
  display: grid;
  width: var(--hit-nav);
  height: var(--hit-nav);
  position: relative;
  margin: var(--px);
  place-items: center;
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-slot:hover,
.dm-slot.is-hover {
  --mat-edge: var(--brass);
}
/* Press sinks one art pixel, stepped, and the light swaps to the far lip. */
.dm-slot:active,
.dm-slot.is-active {
  transform: translateY(var(--px));
  --mat-hi: var(--wood-lo);
  --mat-lo: var(--wood-hi);
}
.dm-slot[aria-current='page'],
.dm-slot.is-selected {
  --mat-fill: var(--gold-lo);
  --mat-hi: var(--gold);
  --mat-lo: var(--gold-deep);
  --mat-edge: var(--brass-hi);
}
.dm-slot[aria-pressed='false'] .dm-icon {
  opacity: 0.7;
}
.dm-slot:disabled {
  --mat-fill: var(--rock);
  --mat-edge: var(--wood-lo);
}
.dm-slot:disabled .dm-icon {
  opacity: 0.35;
}
.dm-slot__badge {
  position: absolute;
  top: -6px;
  right: -6px;
  z-index: 1;
  pointer-events: none;
}
.dm-slot[data-warn='true']::before {
  content: '';
  width: 6px;
  height: 6px;
  position: absolute;
  right: 3px;
  bottom: 3px;
  background: var(--warn);
  box-shadow: 0 0 0 var(--px) var(--rock-lo);
}
/* The label, on the inner side: it rises after the tooltip delay and leaves at once. */
.dm-slot::after {
  content: attr(data-label);
  position: absolute;
  top: 50%;
  right: calc(100% + 10px);
  transform: translate(4px, -50%);
  padding: 6px 8px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--parchment);
  background: var(--wood-lo);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  z-index: var(--z-float);
  transition:
    opacity var(--dur-fast) var(--ease-step) 0ms,
    transform var(--dur-fast) var(--ease-out) 0ms;
}
.dm-slot:hover::after,
.dm-slot:focus-visible::after,
.dm-slot.is-hover::after {
  transform: translate(0, -50%);
  opacity: 1;
  transition-delay: var(--dur-tip-delay);
}
[data-dock='left'] .dm-slot::after {
  right: auto;
  left: calc(100% + 10px);
  transform: translate(-4px, -50%);
}
[data-dock='left'] .dm-slot:hover::after,
[data-dock='left'] .dm-slot:focus-visible::after {
  transform: translate(0, -50%);
}
</style>
