<script setup lang="ts">
/*
 * Stop everything and quit, as the window shows it (ISSUE-317; 07 S10.18…S10.21; ADR-002 D7 steps 1–4): the design's
 * dialog (`molecules/dialog`, through ModalDialog: Cancel first and holding focus, Tab trapped, Esc cancels, focus
 * back to the opener) over the current window. While the confirmation is open it states how many sessions DwarfAI
 * started will end — the Host-owned count useStopEverything reads, nothing added (OQ-78) — with Cancel and Confirm;
 * once Confirm was chosen it is held until A-N26 answers. When some dwarfs could not be ended, the same dialog
 * becomes ONE danger message naming them (S10.21; ADR-014 item 9), dismissed with its one action or Esc.
 *
 * Presentational: useStopEverything, owned by App, holds the state and the IPC (ADR-033 item 2).
 *
 * The words are design's (ADR-018 D5 copy items 4–7 and 9; ADR-002 O-3) and none is written yet: each is a
 * `⟦COPY NEEDED⟧` marker naming its copy item, the values it will carry filled into its `{slot}`. Cancel is the
 * design's own dialog label (copy.md, Dialog).
 */
import { computed } from 'vue'
import ModalDialog from '../overlay/ModalDialog.vue'
import type { DialogAction } from '../../lib/overlay/dialog'
import type { StopEverythingView } from '../../composables/useStopEverything'

const props = defineProps<{ view: StopEverythingView }>()
const emit = defineEmits<{ confirm: []; cancel: []; dismiss: [] }>()

const COPY = {
  title: '⟦COPY NEEDED: Stop everything and quit, confirmation title (ADR-018 D5 copy item 4)⟧',
  count:
    '⟦COPY NEEDED: Stop everything and quit, {count} sessions DwarfAI started will end, singular, plural and zero forms (ADR-018 D5 copy item 5)⟧',
  ownTerminal:
    "⟦COPY NEEDED: Stop everything and quit, sessions started in the person's own terminal keep running and are no longer watched (ADR-018 D5 copy item 6)⟧",
  confirm:
    '⟦COPY NEEDED: Stop everything and quit, confirm button naming the count {count} (ADR-018 D5 copy item 7)⟧',
  cancel: 'Cancel',
  incompleteTitle:
    '⟦COPY NEEDED: Stop everything and quit could not end every session, danger message title (ADR-018 D5 copy item 9)⟧',
  incompleteBody:
    '⟦COPY NEEDED: Stop everything and quit could not end {names}, danger message naming the dwarfs (ADR-018 D5 copy item 9)⟧',
  dismiss:
    '⟦COPY NEEDED: Stop everything and quit could not end every session, dismiss button (ADR-018 D5 copy item 9)⟧'
} as const

const fill = (text: string, slot: string, value: string): string => text.replace(`{${slot}}`, value)

interface Shown {
  title: string
  lines: string[]
  actions: DialogAction[]
}

const dialog = computed<Shown | null>(() => {
  const view = props.view
  if (view.kind === 'confirming') {
    const count = String(view.count)
    return {
      title: COPY.title,
      lines: [fill(COPY.count, 'count', count), COPY.ownTerminal],
      actions: [
        { label: COPY.cancel, disabled: view.sending },
        { label: fill(COPY.confirm, 'count', count), variant: 'danger', disabled: view.sending }
      ]
    }
  }
  if (view.kind === 'incomplete') {
    return {
      title: COPY.incompleteTitle,
      lines: [fill(COPY.incompleteBody, 'names', view.failed.join(', '))],
      actions: [{ label: COPY.dismiss }]
    }
  }
  return null
})

/** Esc and Cancel: the confirmation cancels (not once Confirm was chosen); the danger message is dismissed. */
function back(): void {
  const view = props.view
  if (view.kind === 'confirming' && !view.sending) emit('cancel')
  else if (view.kind === 'incomplete') emit('dismiss')
}

function act(index: number): void {
  if (props.view.kind === 'confirming' && index === 1) {
    if (!props.view.sending) emit('confirm')
    return
  }
  back()
}
</script>

<template>
  <ModalDialog
    :open="dialog !== null"
    :title="dialog?.title ?? ''"
    :actions="dialog?.actions ?? []"
    danger
    @action="act"
    @cancel="back"
  >
    <p v-for="line in dialog?.lines ?? []" :key="line">{{ line }}</p>
  </ModalDialog>
</template>
