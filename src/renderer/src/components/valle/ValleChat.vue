<script setup lang="ts">
/*
 * One pin's chat in Valle's chat zone or a split pane (a Valle package gap resolved in development, EPIC-20 task TVC;
 * BR-21; 07 machines 18, 29): a dwarf's pin holds the Panel's own MessagePanel on that dwarf, read-only once its pin is
 * `gone` (S18.02); an Add pin holds the Panel's own Add panel aimed at its mine, while the window's launch serves it.
 * Both are fed by the Valle root's message dock (`useValleChats`). Its root is the panel's own, so the stack's and the
 * deck's host rules reach it (ISSUE-305).
 *
 * - The panel's own close (its ×, or Esc inside it) unpins it, as × on its line or tab does (S18.04, S29.10, S29.18).
 * - Esc inside it stops there: it never also leaves the Work front or a page beneath (NFR-A11Y-02).
 */
import type { PinView } from '../../lib/valle/pins'
import type { useMessageDock } from '../../composables/useMessageDock'
import DockedAddPanel from '../message/DockedAddPanel.vue'
import DockedMessagePanel from '../message/DockedMessagePanel.vue'

type MessageDock = ReturnType<typeof useMessageDock>

const props = defineProps<{
  pin: PinView
  dock: MessageDock
  /** The name of the mine an Add pin is aimed at. */
  mineName: string
}>()
const emit = defineEmits<{ close: [] }>()

function hold(event: KeyboardEvent): void {
  event.preventDefault()
}

function draft(dwarfId: string, text: string): void {
  props.dock.setDraft(dwarfId, text)
}
</script>

<template>
  <DockedMessagePanel
    v-if="pin.kind === 'chat'"
    :key="pin.key"
    :dock="dock"
    :dwarf-id="pin.key"
    hosted-in="valle"
    :read-only="pin.readOnly"
    :data-valle-chat="pin.key"
    @draft="draft"
    @close="emit('close')"
    @keydown.escape="hold"
  />
  <DockedAddPanel
    v-else-if="dock.launchOpen.value && dock.launch.mineId.value === pin.mineId"
    :dock="dock"
    :mine-name="mineName"
    :data-valle-chat="pin.key"
    @close="emit('close')"
    @keydown.escape="hold"
  />
</template>
