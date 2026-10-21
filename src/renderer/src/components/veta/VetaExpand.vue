<script setup lang="ts">
/*
 * Veta's expand "▲" (`DS/docs/screens/veta.md` V1 item 4; `DS/docs/components.md`, Veta strip; ISSUE-287): one click
 * back to the Panel. It sits at the anchor end of a strip with chambers and is never drawn with the closed entrance,
 * which is then the one way back (US-VETA-011.AC04). Its chevron points into the screen: up on a bottom edge, down on a
 * top edge, inward on a side edge. Presentational: its container moves to the Panel.
 */
import { t, type VetaDock } from '@dwarfai/contracts'
import PixelIcon from '../icon/PixelIcon.vue'

defineProps<{ edge: VetaDock['edge'] }>()
const emit = defineEmits<{ activate: [] }>()
</script>

<template>
  <button
    type="button"
    class="veta-expand m-mat dm-focus-inset"
    :data-edge="edge"
    :aria-label="t('veta.expand.label')"
    :title="t('veta.expand.label')"
    data-veta-expand
    data-veta-part="expand"
    @click="emit('activate')"
  >
    <PixelIcon name="chevron" />
  </button>
</template>

<style scoped>
/* `.dm-veta__expand` (DS/docs/components.md, Veta strip): 32 × 44, 44 × 32 on a side edge, on the control material. */
.veta-expand {
  --mat-fill: var(--control);
  --mat-hi: var(--control-hi);
  --mat-lo: var(--control-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 44px;
  margin: var(--px);
  padding: 0;
  border: 0;
  color: var(--ink);
  cursor: pointer;
  transition: transform var(--dur-press) var(--ease-step);
}

.veta-expand[data-edge='left'],
.veta-expand[data-edge='right'] {
  width: 44px;
  height: 32px;
}

.veta-expand:hover {
  --mat-edge: var(--brass);
}

.veta-expand:active {
  transform: translateY(var(--px));
}

.veta-expand[data-edge='bottom'] :deep(.dm-icon) {
  transform: rotate(180deg);
}

.veta-expand[data-edge='left'] :deep(.dm-icon) {
  transform: rotate(-90deg);
}

.veta-expand[data-edge='right'] :deep(.dm-icon) {
  transform: rotate(90deg);
}
</style>
