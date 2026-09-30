<script setup lang="ts">
/*
 * The redesigned button (#635), `atoms/button` in the design: control wood by default, one brass
 * primary per surface, danger red and apart, and a link with no plate. Press sinks one art pixel;
 * hover lights the edge; a toggle that is on turns gold. What the options decide is in
 * lib/controls/button; this only draws it. A click falls through to the native button, which a
 * disabled one never fires.
 */
import { computed } from 'vue'
import PixelIcon from '../icon/PixelIcon.vue'
import {
  buttonAttributes,
  buttonClasses,
  buttonIconScale,
  type ButtonOptions
} from '../../lib/controls/button'

// `pressed` defaults to undefined, not false: only a toggle states aria-pressed at all.
const props = withDefaults(defineProps<ButtonOptions>(), {
  pressed: undefined,
  block: false,
  disabled: false
})

const classes = computed(() => buttonClasses(props))
const attributes = computed(() => buttonAttributes(props))
const scale = computed(() => buttonIconScale(props))
</script>

<template>
  <button :class="classes" v-bind="attributes">
    <PixelIcon v-if="icon !== undefined" :name="icon" :scale="scale" />
    <span v-if="label" class="dm-btn__label">{{ label }}</span>
  </button>
</template>

<style scoped>
/*
 * The design's button.css, rule for rule and in its order: each state only repoints the --btn-*
 * variables, and .dm-btn hands them to the material recipe (.m-mat), which paints the notched
 * plate. Scoping adds one attribute to every rule alike, so the rules keep the cascade they have
 * in the design.
 */
.dm-btn {
  --btn-fill: var(--control);
  --btn-hi: var(--control-hi);
  --btn-lo: var(--control-lo);
  --btn-edge: var(--rock-lo);
  --btn-edge-hover: var(--brass);
  --mat-fill: var(--btn-fill);
  --mat-hi: var(--btn-hi);
  --mat-lo: var(--btn-lo);
  --mat-edge: var(--btn-edge);
  display: inline-flex;
  min-height: var(--hit);
  min-width: var(--hit);
  position: relative;
  gap: var(--sp-3);
  margin: var(--px);
  padding: 0 var(--sp-4);
  font: var(--fs-meta) / 1 var(--f-meta);
  letter-spacing: 0.04em;
  color: var(--ink);
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  user-select: none;
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-btn:hover:not(:disabled),
.dm-btn.is-hover {
  --mat-edge: var(--btn-edge-hover);
}
/* Press sinks one art pixel, stepped, and the light swaps to the far lip. */
.dm-btn:active:not(:disabled),
.dm-btn.is-active {
  transform: translateY(var(--px));
  --mat-hi: var(--btn-lo);
  --mat-lo: var(--btn-hi);
}
.dm-btn[aria-pressed='true'],
.dm-btn.is-selected {
  color: var(--parch-hi);
  --btn-fill: var(--gold-lo);
  --btn-hi: var(--gold);
  --btn-lo: var(--gold-deep);
  --btn-edge: var(--brass-lo);
  --btn-edge-hover: var(--brass-hi);
}
/* A labelled toggle that is on carries text, so its fill is the gold that text reaches contrast on. */
.dm-btn[aria-pressed='true']:not(.dm-btn--icon),
.dm-btn.is-selected:not(.dm-btn--icon) {
  --btn-fill: var(--gold-select);
}
.dm-btn:disabled,
.dm-btn.is-disabled {
  color: var(--ink-faint);
  --btn-fill: var(--rock);
  --btn-hi: var(--rock-hi);
  --btn-lo: var(--rock-lo);
  --btn-edge: var(--wood-lo);
}
.dm-btn:disabled .dm-icon,
.dm-btn.is-disabled .dm-icon {
  opacity: 0.45;
}
.dm-btn--primary {
  color: var(--ink-on-light);
  --btn-fill: var(--brass);
  --btn-hi: var(--brass-hi);
  --btn-lo: var(--brass-lo);
  --btn-edge-hover: var(--parch-hi);
}
.dm-btn--primary:hover:not(:disabled),
.dm-btn--primary.is-hover {
  --btn-fill: var(--brass-hi);
  --btn-hi: var(--parch-hi);
}
.dm-btn--danger {
  color: var(--danger-hi);
  --btn-fill: var(--danger-lo);
  --btn-hi: var(--danger);
  --btn-lo: var(--rock-lo);
  --btn-edge-hover: var(--danger-hi);
}
.dm-btn--link {
  padding: 0 var(--sp-2);
  color: var(--ink-soft);
  --btn-fill: transparent;
  --btn-hi: transparent;
  --btn-lo: transparent;
  --btn-edge: transparent;
  --btn-edge-hover: transparent;
}
.dm-btn--link:hover:not(:disabled),
.dm-btn--link.is-hover {
  color: var(--brass);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.dm-btn--link:active:not(:disabled),
.dm-btn--link.is-active {
  --mat-hi: transparent;
  --mat-lo: transparent;
}
.dm-btn--lg {
  min-height: var(--hit-nav);
  padding: 0 var(--sp-5);
  font-size: var(--fs-section);
}
.dm-btn--block {
  display: flex;
  width: calc(100% - var(--px) * 2);
}
.dm-btn--icon {
  width: var(--hit-tool);
  height: var(--hit-tool);
  min-height: 0;
  padding: 0;
}
.dm-btn--icon.dm-btn--sm {
  width: var(--hit);
  height: var(--hit);
}
</style>
