<script setup lang="ts">
/*
 * A recorded shortcut shown as a sunken key cap (#635), `DM.ui.kbd` in the design's settings-row
 * molecule. `button` draws the same cap as a real button, which is how the Panel shortcut row
 * keeps its recorder (screens/settings.md: the shortcut does not change, only its row is
 * restyled): every attribute and listener falls through to the root, so the recorder's own
 * behaviour stays in ShortcutSettings.
 */
withDefaults(defineProps<{ button?: boolean }>(), { button: false })
</script>

<template>
  <button v-if="button" class="dm-kbd" type="button"><slot /></button>
  <span v-else class="dm-kbd"><slot /></span>
</template>

<style scoped>
/* The design's settings-row.css `.dm-kbd`, rule for rule. */
.dm-kbd {
  display: inline-flex;
  align-items: center;
  height: var(--hit);
  padding: 0 10px;
  margin: var(--px);
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--parchment);
  background: var(--rock);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo),
    inset 2px 2px 0 0 var(--rock-lo),
    inset -2px -2px 0 0 var(--rock-hi);
  white-space: nowrap;
}
</style>
