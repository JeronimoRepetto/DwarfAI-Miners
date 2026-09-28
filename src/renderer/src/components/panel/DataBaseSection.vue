<script setup lang="ts">
import ActionButton from '../controls/ActionButton.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * Settings › Data (#138, #635): the danger zone "Data Base" and its one action, Reset metrics…,
 * which opens the typed confirmation SettingsPanel owns (the dialog, molecules/dialog) — this
 * component only asks for it to open. The copy follows today's section (screens/settings.md, As
 * built: "copy from DataBaseSection.vue and ResetMetricsModal.vue"); the ellipsis says the action
 * asks before it acts.
 */
const emit = defineEmits<{
  'open-reset': []
}>()
</script>

<template>
  <SettingsRow label="Data Base" tone="danger">
    <ActionButton
      class="reset-metrics"
      label="Reset metrics…"
      variant="danger"
      @click="emit('open-reset')"
    />
  </SettingsRow>
</template>
