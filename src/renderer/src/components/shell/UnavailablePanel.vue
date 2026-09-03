<script setup lang="ts">
import { computed } from 'vue'
import { UNAVAILABLE_ART_SRC } from '../../lib/art'

/**
 * The Lab and the Market (#90). Both are fully specified in the design source
 * and both are specified as unavailable: a painting under a 50% black filter,
 * and one centred message over it.
 *
 * There is deliberately nothing to press. The source names no action, no retry,
 * no availability date and no error state, and inventing any of them would be
 * filling a gap the source marked rather than left.
 */
const props = defineProps<{ feature: 'lab' | 'market' }>()

/** The design's copy, verbatim, including the apostrophe it is written with. */
const MESSAGES = {
  lab: "We're working to rebuild the lab.",
  market: "We're working to rebuild the market."
} as const

const headline = computed(() => MESSAGES[props.feature])
const art = computed(() => UNAVAILABLE_ART_SRC[props.feature])
</script>

<template>
  <div class="unavailable">
    <img class="unavailable-art" :src="art" alt="" aria-hidden="true" draggable="false" />
    <div class="unavailable-filter" aria-hidden="true"></div>
    <p class="unavailable-message" role="status">
      {{ headline }}<br />
      Please come back later.
    </p>
  </div>
</template>

<style scoped>
.unavailable {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
}
.unavailable-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}
/* The source's own treatment: the base image under #000000 at 50%. */
.unavailable-filter {
  position: absolute;
  inset: 0;
  background: var(--color-black);
  opacity: 0.5;
}
.unavailable-message {
  position: relative;
  margin: var(--space-map-pad);
  padding: var(--space-settings) var(--space-modal-margin);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  /* The centre surface is the same black at the same 50%, over the filtered art. */
  background: #00000080;
  font-size: var(--text-headline);
  line-height: 1.5;
  text-align: center;
}
</style>
