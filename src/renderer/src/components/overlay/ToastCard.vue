<script setup lang="ts">
/*
 * One toast (#635), `molecules/toast` in the design: a raised plate, an optional icon and one line.
 * Only drawn: when it shows and when it leaves are the queue's (lib/overlay/toast), and the host
 * around it is what screen readers hear.
 */
import PixelIcon from '../icon/PixelIcon.vue'
import type { IconName } from '../../lib/icon/iconGrids'

withDefaults(defineProps<{ text: string; icon?: IconName }>(), { icon: undefined })
</script>

<template>
  <div class="dm-toast m-mat m-raised">
    <PixelIcon v-if="icon !== undefined" :name="icon" />{{ text }}
  </div>
</template>

<style scoped>
/* The design's toast.css, rule for rule; the host's placement is ToastHost's. */
.dm-toast {
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--brass-lo);
  display: flex;
  max-width: 420px;
  gap: 8px;
  padding: 8px 12px;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--parchment);
  align-items: center;
}
</style>
