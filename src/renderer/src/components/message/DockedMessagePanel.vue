<script setup lang="ts">
/*
 * The Panel's own MessagePanel on one dwarf, fed by the window's message dock (BR-21: the same component, fed by the
 * same `useMessageDock`, in every mode). Veta's risen chat hosts it (ISSUE-290), and so do Valle's pins and panes, one
 * per pin (a Valle package gap resolved in development, EPIC-20 task TVC). Its root is the MessagePanel's own, so a
 * host's rule on its direct child reaches the panel.
 *
 * - The conversation is the dock's (`conversationOf`): the open chat's with its older pages, a chat shown beside it
 *   from the same stores, its newest page alone (the dock pages the open chat), its paths opened against its own dwarf.
 * - `readOnly`: a `gone` pin's chat (07 S18.02; US-VALLE-007.AC07): its dwarf is drawn ended, so the composer is the
 *   closed session's, and nothing it would send, retry, answer or stop leaves.
 */
import type { ChatViewState } from '@dwarfai/contracts'
import { computed } from 'vue'
import type { useMessageDock } from '../../composables/useMessageDock'
import type { Dwarf } from '../../types'
import DwarfMessagePanel from './DwarfMessagePanel.vue'

type MessageDock = ReturnType<typeof useMessageDock>

const props = defineProps<{
  dock: MessageDock
  dwarfId: string
  /** The mode window hosting it (DwarfMessagePanel `hostedIn`). */
  hostedIn: 'panel' | 'veta' | 'valle'
  openAt?: ChatViewState['scrollAnchor']
  /** A gone pin's chat (S18.02): shown, never sending. */
  readOnly?: boolean
  /** In Valle, the chat in focus: the one a mode run carries (DwarfMessagePanel `inFocus`, ISSUE-311). */
  inFocus?: boolean
}>()

const emit = defineEmits<{
  /** The chat's draft as it is typed. */
  draft: [dwarfId: string, text: string]
  /** The panel's own close (its ×, or Esc inside it). */
  close: []
  /** "▢ Open in the Panel" in the chat header (S24.12). */
  'open-in-panel': []
  /** "Mine history" in the chat header or its ⋯ menu: the host shows the mine's history (07 S31.11, S36.01). */
  history: []
}>()

const chat = computed(() => props.dock.conversationOf(props.dwarfId))
const dwarf = computed((): Dwarf | undefined => {
  const shown = chat.value.dwarf
  if (shown === undefined || props.readOnly !== true || shown.status === 'leaving') return shown
  return { ...shown, status: 'leaving' }
})

/** Runs `act` on the shown dwarf unless the chat is read-only. */
function live(act: (dwarf: Dwarf) => void): void {
  if (props.readOnly === true || dwarf.value === undefined) return
  act(dwarf.value)
}
</script>

<template>
  <DwarfMessagePanel
    v-if="dwarf"
    :dwarf="dwarf"
    :route-gone="chat.routeGone"
    :feed="chat.feed"
    :paging-note="chat.pagingNote"
    :draft="dock.drafts.value[dwarfId]"
    :send-state="dock.messageStateFor(dwarfId)"
    :echoes="dock.sentEchoes[dwarfId]"
    :echo-attachments="dock.sentEchoAttachments[dwarfId]"
    :stop-disabled="dock.stopDisabled(dwarfId)"
    :answer-state="dock.questionState.byDwarfId[dwarfId]"
    :hosted-in="hostedIn"
    :in-focus="inFocus"
    :open-at="openAt"
    @open-in-panel="emit('open-in-panel')"
    @history="emit('history')"
    @draft="emit('draft', dwarfId, $event)"
    @send="(payload) => live((d) => dock.sendText(d, payload))"
    @retry="(echoId) => live((d) => dock.retryMessage(d, echoId))"
    @copy="dock.copyMessage"
    @stop="live((d) => dock.stopDwarf(d))"
    @answer="(answer) => live((d) => dock.answerQuestion(d, answer))"
    @answer-text="(text) => live((d) => dock.answerQuestionInWords(d, text))"
    @decide="(decision) => live((d) => dock.decidePermission(d, decision))"
    @open-console="dwarf && dock.activate(dwarf)"
    @open-path="(target) => dock.openPath(target, dwarfId)"
    @open-link="dock.openLink"
    @page-back="dwarfId === dock.openDwarfId.value && dock.pageBack()"
    @close="emit('close')"
  />
</template>
