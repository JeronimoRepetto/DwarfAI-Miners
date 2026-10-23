<script setup lang="ts">
/*
 * The "Need you ▸" counter in Valle's top bar (`organisms/valle-bar` `.dm-vbar__needs`; 07 machine 34; US-VALLE-004;
 * ISSUE-306): "1 needs you", "`<n>` need you" or "Nobody waiting", disabled; brass with a bobbing "?" while someone
 * waits, the "?" still under reduced motion (`still`, read by the host from the viewer's preference, ISSUE-311;
 * US-SHELL-011.AC05; the stylesheet's own media rule holds it still too). Its accessible name counts and names no dwarf (AC07). It updates in place
 * and never moves in the top bar (AC05): one button, its words patched.
 */
import { COUNTER_TITLE, type CounterView } from '../../lib/valle/needsYou'

withDefaults(
  defineProps<{
    view: CounterView
    /** Reduced motion is on (NFR-A11Y-10): the "?" is drawn and does not bob. */
    still?: boolean
  }>(),
  { still: false }
)
const emit = defineEmits<{ press: [] }>()
</script>

<template>
  <button
    type="button"
    class="dm-vbar__needs m-mat"
    data-needs-counter
    :data-count="view.count"
    :data-still="still ? 'true' : 'false'"
    :disabled="view.disabled"
    :aria-label="view.label"
    :title="view.disabled ? undefined : COUNTER_TITLE"
    @click="emit('press')"
  >
    <span class="dm-vbar__q" aria-hidden="true">?</span>
    <span class="dm-vbar__count">{{ view.text }}</span>
    <span class="dm-vbar__go" aria-hidden="true">▸</span>
  </button>
</template>

<style scoped>
.dm-vbar__needs {
  --mat-fill: var(--brass);
  --mat-hi: var(--brass-hi);
  --mat-lo: var(--brass-lo);
  --mat-edge: var(--rock-lo);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 36px;
  margin: var(--px);
  padding: 0 10px 0 6px;
  font: 400 var(--fs-section) / 1 var(--f-label);
  color: var(--ink-on-light);
  white-space: nowrap;
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-vbar__needs:hover:not(:disabled) {
  --mat-edge: var(--parch-hi);
  --mat-fill: var(--brass-hi);
}
.dm-vbar__needs:active:not(:disabled) {
  transform: translateY(var(--px));
}
.dm-vbar__q {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--brass);
  background: var(--rock-lo);
  animation: dm-bob 1s steps(1, end) infinite;
}
.dm-vbar__needs:disabled {
  --mat-fill: var(--rock);
  --mat-hi: var(--rock-hi);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--wood-lo);
  color: var(--ink-faint);
  cursor: default;
}
.dm-vbar__needs:disabled .dm-vbar__q,
.dm-vbar__needs:disabled .dm-vbar__go {
  display: none;
}
.dm-vbar__needs[data-still='true'] .dm-vbar__q {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .dm-vbar__q {
    animation: none;
  }
}
</style>
