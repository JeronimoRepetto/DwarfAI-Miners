<script setup lang="ts">
/*
 * The current mine's mark (07 machine 35 `set`; US-VALLE-013.AC04, .AC07, .AC11; decision log, Selected mine mark;
 * ISSUE-307): the four stepped parchment L brackets of `.m-brackets::after` (design-tokens.css), drawn at the size its
 * place asks for (`CURRENT_MARK`) and shown by opacity alone, over `--dur-fast` and in one frame under reduced motion.
 *
 * A shape and never a colour: it changes no hue, border, outline or ring of what it marks, so it is never read as needs
 * you. It covers its positioned parent, so inside a zone's body it sits within the needs-you ring the zone draws
 * around it, the two nested and never merged. Which mine is current is the host's answer; this only draws it.
 */
import { computed } from 'vue'
import { CURRENT_MARK, type CurrentMarkSize } from '../../lib/valle/currentMine'

const props = defineProps<{ current: boolean; size: CurrentMarkSize }>()

const style = computed(() => {
  const { thickness, arm, inset } = CURRENT_MARK[props.size]
  return { '--mark-t': `${thickness}px`, '--mark-l': `${arm}px`, '--mark-in': `${inset}px` }
})
</script>

<template>
  <span
    class="dm-vmark m-brackets"
    data-current-mark
    :data-mark="size"
    :data-current="current ? 'true' : 'false'"
    :style="style"
    aria-hidden="true"
  ></span>
</template>

<style scoped>
.dm-vmark {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
}
.dm-vmark::after {
  --br-t: var(--mark-t);
  --br-l: var(--mark-l);
  inset: var(--mark-in);
}
/* The list line's brackets lie on its gold face, with no pixel shadow (`DS` organisms/mine-rows). */
.dm-vmark[data-mark='list']::after {
  filter: none;
}
.dm-vmark[data-current='true']::after {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .dm-vmark::after {
    transition: none;
  }
}
</style>
