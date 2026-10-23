<script setup lang="ts">
/*
 * The Panel's own Add panel, fed by the window's message dock's launch (BR-21: the same component, fed by the same
 * `useMessageDock`, in every mode). Veta's risen window hosts it (ISSUE-290), and so does a Valle Add pin (a Valle
 * package gap resolved in development, EPIC-20 task TVC). Its root is the Add panel's own, so a host's rule on its direct
 * child reaches the panel.
 */
import type { useMessageDock } from '../../composables/useMessageDock'
import AddPanel from '../launch/AddPanel.vue'

type MessageDock = ReturnType<typeof useMessageDock>

defineProps<{
  dock: MessageDock
  /** The name of the mine the Add panel is aimed at. */
  mineName: string
}>()

const emit = defineEmits<{
  /** The panel's own close (its ×, or Esc inside it). */
  close: []
}>()
</script>

<template>
  <AddPanel
    :mine-name="mineName"
    :chips="dock.launch.chips.value"
    :phase="dock.launch.phase.value"
    :enabled="dock.launch.enabled.value"
    :command="dock.launch.state.value.command"
    :prompt="dock.launch.state.value.prompt"
    :refusal="dock.launch.refusal.value"
    :error="dock.launch.state.value.error"
    :model-picker="dock.launch.modelPicker.value"
    :effort-picker="dock.launch.effortPicker.value"
    :permissions-visible="dock.launch.permissionsVisible.value"
    :jev="dock.launch.jev.value"
    :model="dock.launch.state.value.model"
    :effort="dock.launch.state.value.effort"
    :permission-mode="dock.launch.state.value.permissionMode"
    :failure="dock.launch.state.value.failure"
    :integration-notice="dock.launch.integrationNotice.value"
    :jev-accepted="dock.launch.jevAccepted.value"
    @enable-integration="dock.launch.enableIntegration"
    @choose="dock.launch.choose"
    @command="dock.launch.setCommand"
    @commit="dock.launch.commit"
    @prompt="dock.launch.setPrompt"
    @model="dock.launch.setModel"
    @effort="dock.launch.setEffort"
    @permission-mode="dock.launch.setPermissionMode"
    @toggle-jev="dock.launch.toggleJevEnabled"
    @toggle-jev-auto="dock.launch.toggleJevAutoAccept"
    @dismiss-jev="dock.launch.dismissJevDecision"
    @submit="dock.launch.submit"
    @retry="dock.launch.retry"
    @pick-manually="dock.launch.pickManually"
    @close="emit('close')"
  />
</template>
