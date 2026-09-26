<script setup lang="ts">
/*
 * The redesigned portrait (#635), `atoms/portrait` in the design: the painted face for a rank in
 * a stepped frame, a status mark in its corner, a gold trim when selected. Interactive, it is a
 * button that reports a click; otherwise a plain figure. The face has empty alt and the mark is
 * hidden: the button's name says both. What the options decide is lib/dwarf/portrait's.
 */
import { computed } from 'vue'
import { PORTRAIT_SRC } from '../../lib/art'
import {
  portraitAttributes,
  portraitClasses,
  portraitMark,
  type PortraitSize,
  type PortraitState,
  type PortraitStatus
} from '../../lib/dwarf/portrait'
import type { DwarfRole } from '../../types'

const props = withDefaults(
  defineProps<{
    role: DwarfRole
    status?: PortraitStatus
    size?: PortraitSize
    /** The dwarf's name, which an interactive portrait is named after. */
    name?: string
    selected?: boolean
    /** A button that reports a click, rather than a plain figure. */
    interactive?: boolean
    state?: PortraitState
  }>(),
  {
    status: 'idle',
    size: undefined,
    name: '',
    selected: false,
    interactive: false,
    state: undefined
  }
)

const classes = computed(() => portraitClasses(props))
const attributes = computed(() => portraitAttributes(props))
</script>

<template>
  <component :is="interactive ? 'button' : 'span'" :class="classes" v-bind="attributes">
    <img :src="PORTRAIT_SRC[role]" alt="" />
    <span class="dm-portrait__mark" aria-hidden="true">{{ portraitMark(status) }}</span>
  </component>
</template>

<style scoped>
/* The design's portrait.css, rule for rule and in its order. */
.dm-portrait {
  --size: 40px;
  --mat-fill: var(--rock);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: inline-block;
  flex: none;
  width: var(--size);
  height: var(--size);
  position: relative;
  margin: var(--px);
  padding: var(--px);
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-portrait--sm {
  --size: 32px;
}
.dm-portrait--lg {
  --size: 48px;
}
.dm-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 42%;
}
button.dm-portrait:hover,
.dm-portrait.is-hover {
  --mat-edge: var(--brass);
}
/* Press sinks one art pixel, stepped. */
button.dm-portrait:active,
.dm-portrait.is-active {
  transform: translateY(var(--px));
}
.dm-portrait[aria-pressed='true'],
.dm-portrait.is-selected {
  --mat-edge: var(--brass-hi);
  --mat-hi: var(--gold);
  --mat-lo: var(--gold-deep);
  --mat-fill: var(--gold-lo);
}
.dm-portrait__mark {
  display: grid;
  min-width: 14px;
  height: 14px;
  position: absolute;
  top: -6px;
  right: -6px;
  padding: 0 2px;
  font: var(--fs-meta) / 1 var(--f-meta);
  box-shadow: 0 0 0 var(--px) var(--rock-lo);
  place-items: center;
  pointer-events: none;
}
.dm-portrait[data-status='asking'] .dm-portrait__mark {
  background: var(--brass);
  color: var(--ink-on-light);
  animation: dm-bob 1s steps(1, end) infinite;
}
.dm-portrait[data-status='asleep'] .dm-portrait__mark {
  background: var(--wood-lo);
  color: var(--ink-soft);
}
.dm-portrait[data-status='asleep'] img {
  opacity: 0.55;
}
/* Working is a small green light low in the corner rather than a plate. */
.dm-portrait[data-status='working'] .dm-portrait__mark {
  min-width: 6px;
  width: 6px;
  height: 6px;
  top: auto;
  bottom: 2px;
  right: 2px;
  padding: 0;
  background: var(--ok);
}
.dm-portrait[data-status='done'] .dm-portrait__mark {
  background: var(--ok-lo);
  color: var(--ok);
}
.dm-portrait[data-status='idle'] .dm-portrait__mark {
  display: none;
}
</style>
