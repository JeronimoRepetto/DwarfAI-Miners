<script setup lang="ts">
/**
 * The Data Base section of the redesigned Settings screen (#138,
 * screens/settings.md): the section label and the action that opens the
 * typed reset-metrics confirmation modal (ResetMetricsModal, a sibling owned
 * by SettingsPanel — this component only asks for it to open).
 */
const emit = defineEmits<{
  'open-reset': []
}>()
</script>

<template>
  <section class="data-base-settings">
    <span class="field-label">Data Base</span>
    <button class="reset-metrics" type="button" @click="emit('open-reset')">Reset metrics</button>
  </section>
</template>

<style scoped>
.data-base-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  /* Verified visuals (settings-panel.png, settings-reset-metrics-section.png)
     show Data Base sitting near the bottom of the panel, well below Position
     rather than immediately after it — an auto top margin carries this
     section (and SettingsPanel's own Application section right after it)
     down together, absorbing the panel's leftover height. */
  margin-top: auto;
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
/* The shared button model (components.md): always enabled, so it uses the
   plain enabled/selected styling. */
.reset-metrics {
  align-self: flex-start;
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
.reset-metrics:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
