<script setup lang="ts">
/*
 * Veta's grip (US-VETA-002; 07 machine 21; `DS/docs/screens/veta.md` Layout): the handle the island is dragged by and
 * docked from with the arrow keys. Presentational: it captures the pointer on a primary press, so the drag keeps its
 * events wherever the pointer goes, and hands every pointer and key event to its container (`VetaApp`, through
 * `useVetaDock`). A right-click is the grip menu's (US-VETA-003, ISSUE-288), never a drag.
 */
import { t } from '@dwarfai/contracts'

defineProps<{ vertical: boolean }>()

const emit = defineEmits<{
  press: [event: PointerEvent]
  move: [event: PointerEvent]
  release: [event: PointerEvent]
  cancel: [cause: 'pointer-cancel' | 'lost-capture']
  key: [event: KeyboardEvent]
}>()

function down(event: PointerEvent): void {
  if (event.button !== 0) return
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  emit('press', event)
}
</script>

<template>
  <button
    type="button"
    class="veta-grip"
    :class="{ 'is-vertical': vertical }"
    :aria-label="t('veta.grip.label')"
    :title="t('veta.grip.title')"
    data-veta-grip
    @pointerdown="down"
    @pointermove="emit('move', $event)"
    @pointerup="emit('release', $event)"
    @pointercancel="emit('cancel', 'pointer-cancel')"
    @lostpointercapture="emit('cancel', 'lost-capture')"
    @keydown="emit('key', $event)"
  />
</template>

<style scoped>
/* Expand, +N and grip: 32 × 44 on a top or bottom edge, 44 × 32 on a side edge (DS/docs/screens/veta.md). */
.veta-grip {
  flex: none;
  width: 32px;
  height: 44px;
  margin: var(--px);
  padding: 0;
  border: var(--px) solid var(--brass-lo);
  background: var(--wood-lo);
  cursor: grab;
  touch-action: none;
}

.veta-grip.is-vertical {
  width: 44px;
  height: 32px;
}

.veta-grip:focus-visible {
  outline: var(--px) solid var(--brass);
}
</style>
