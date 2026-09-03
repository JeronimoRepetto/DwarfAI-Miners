<script setup lang="ts">
import type { PanelEdge } from '../../types'

/**
 * The Position section of the redesigned Settings screen (#138,
 * screens/settings.md): a Left/Right segmented control that reports which
 * edge the docked shell should sit on.
 *
 * Presentational, like ShortcutSettings: `edge` arrives as a prop (main's
 * verdict, read back through usePanelLayout) and every intent leaves as
 * `select`. App.vue owns usePanelLayout.setEdge and therefore the IPC and the
 * persistence, which keeps the "render only what main verified" rule in one
 * place — the same reason a click on the ALREADY-selected segment still
 * emits: this component does not know or decide that the request would be a
 * no-op, and it must not silently swallow it for its owner.
 */
defineProps<{
  edge: PanelEdge
  /** True while a move is in flight; locks both segments (see usePanelLayout.applying). */
  applying: boolean
}>()

const emit = defineEmits<{
  select: [edge: PanelEdge]
}>()
</script>

<template>
  <section class="position-settings">
    <span class="field-label">Position</span>
    <div class="segments">
      <button
        class="position-left"
        type="button"
        :class="{ 'is-selected': edge === 'left' }"
        :aria-pressed="edge === 'left' ? 'true' : 'false'"
        :disabled="applying"
        @click="emit('select', 'left')"
      >
        Left
      </button>
      <button
        class="position-right"
        type="button"
        :class="{ 'is-selected': edge === 'right' }"
        :aria-pressed="edge === 'right' ? 'true' : 'false'"
        :disabled="applying"
        @click="emit('select', 'right')"
      >
        Right
      </button>
    </div>
    <p class="hint">Select Left or Right to place the panel at the edges of the screen.</p>
  </section>
</template>

<style scoped>
.position-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
.segments {
  display: flex;
  gap: var(--space-settings);
}
/* The shared button/segmented-control model (components.md): the selected
   segment reads as an active control, the other fades to the deep
   background — both stay clickable, since switching sides is the point. */
.segments button {
  flex: 1;
  padding: 6px var(--space-settings);
  border: 2px solid var(--color-control);
  border-radius: var(--radius-default);
  color: var(--color-control);
  cursor: pointer;
  background: var(--color-panel-deep);
  font: inherit;
  font-size: var(--text-meta);
}
.segments button.is-selected {
  border: var(--border-active);
  color: var(--color-cream);
  background: var(--color-control);
}
.segments button:disabled {
  cursor: default;
}
.segments button:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.hint {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
</style>
