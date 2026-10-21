<script setup lang="ts">
/*
 * Veta's grip (US-VETA-002; 07 machine 21; `DS/docs/screens/veta.md` Layout): the handle the island is dragged by and
 * docked from with the arrow keys. Presentational: it captures the pointer on a primary press, so the drag keeps its
 * events wherever the pointer goes, and hands every pointer and key event to its container (`VetaApp`, through
 * `useVetaDock`). A right-click is the grip menu's (US-VETA-003, ISSUE-288), never a drag.
 */
import { t } from '@dwarfai/contracts'
import PixelIcon from '../icon/PixelIcon.vue'

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
    class="veta-grip m-mat dm-focus-inset"
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
  >
    <PixelIcon name="grip" :scale="2" />
  </button>
</template>

<style scoped>
/*
 * `.dm-veta__grip` (DS/docs/components.md, Veta strip): 32 × 44 on a top or bottom edge, 44 × 32 on a side edge, with a
 * 2 px margin, on wood with a rock-lo edge (brass on hover), its 32 px grip icon turned on a side edge.
 */
.veta-grip {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  flex: none;
  place-items: center;
  box-sizing: border-box;
  width: 32px;
  height: 44px;
  margin: var(--px);
  padding: 0;
  border: 0;
  color: var(--ink);
  cursor: grab;
  touch-action: none;
}

.veta-grip:hover {
  --mat-edge: var(--brass);
}

.veta-grip.is-vertical {
  width: 44px;
  height: 32px;
}

.veta-grip.is-vertical :deep(.dm-icon) {
  transform: rotate(90deg);
}
</style>
