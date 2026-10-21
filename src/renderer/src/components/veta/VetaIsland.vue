<script setup lang="ts">
/*
 * The Veta island itself (`.dm-veta`, `DS/docs/components.md` Veta strip; ISSUE-287): the region named "Veta" that
 * holds the strip's parts, content-sized, 2 px of rock-lo around them, a column on a left or right edge. Presentational:
 * its container (`VetaApp`) places the parts in it, from the anchor outward, and moves it while dragged. Before the
 * Host has answered it draws nothing at all.
 */
import { t } from '@dwarfai/contracts'

defineProps<{
  /** `first` or `empty` for the closed entrance, `sessions` for the chambers, `null` before anything is known. */
  mode: 'first' | 'empty' | 'sessions' | null
  vertical: boolean
  dragging?: boolean
}>()
</script>

<template>
  <div
    class="veta-island"
    :class="{
      'is-dragging': dragging === true,
      'is-vertical': vertical,
      'is-unknown': mode === null
    }"
    role="region"
    :aria-label="mode === null ? undefined : t('veta.region.label')"
    :data-mode="mode ?? undefined"
    data-veta-island
  >
    <slot />
  </div>
</template>

<style scoped>
.veta-island {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  box-sizing: border-box;
  padding: 2px;
  background: var(--rock-lo);
  touch-action: none;
}

.veta-island.is-vertical {
  flex-direction: column;
}

.veta-island.is-unknown {
  padding: 0;
  background: transparent;
}

.veta-island.is-dragging {
  opacity: 0.85;
  will-change: transform;
}
</style>
