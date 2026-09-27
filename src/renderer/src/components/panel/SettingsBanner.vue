<script setup lang="ts">
/*
 * The warning shown at the top of a Settings section (#635), `DM.ui.banner` in the design's
 * settings-row molecule: a warning glyph and one line on the warn plate, announced as an alert
 * (components.md, Settings row, Accessibility). General opens with it when the panel shortcut
 * failed to register (screens/settings.md, W6, Broken shortcut).
 */
import PixelIcon from '../icon/PixelIcon.vue'

defineProps<{ text: string }>()
</script>

<template>
  <div class="dm-banner" role="alert">
    <PixelIcon name="warning" />
    <span>{{ text }}</span>
  </div>
</template>

<style scoped>
/* The design's settings-row.css `.dm-banner`, rule for rule. */
.dm-banner {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px;
  margin: 2px 2px 10px;
  font: 400 var(--fs-meta) / 1.4 var(--f-meta);
  color: var(--parchment);
  background: var(--warn-lo);
  box-shadow:
    0 -2px 0 0 var(--warn),
    0 2px 0 0 var(--warn),
    -2px 0 0 0 var(--warn),
    2px 0 0 0 var(--warn);
}
</style>
