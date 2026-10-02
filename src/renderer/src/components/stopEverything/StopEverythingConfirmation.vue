<script setup lang="ts">
/*
 * Stop everything and quit, as the window shows it (ISSUE-317; 07 S10.18…S10.21; ADR-002 D7 steps 1–4): the design's
 * dialog (`molecules/dialog`, through ModalDialog: Cancel first and holding focus, Tab trapped, Esc cancels, focus
 * back to the opener) over the current window. While the confirmation is open it states how many sessions DwarfAI
 * started will end — the Host-owned count useStopEverything reads, nothing added (OQ-78) — with Cancel and Confirm;
 * once Confirm was chosen it is held until A-N26 answers. When some dwarfs could not be ended, the same dialog
 * becomes ONE danger message naming them (S10.21; ADR-014 item 9), dismissed with its one action or Esc. When A-N26
 * answered an error, Stop everything did not finish and DwarfAI keeps running: the same dialog becomes ONE danger
 * message saying so, naming no dwarf (owner ruling 2026-10-01; ADR-002 D7 step 3). Only one is ever shown.
 *
 * Presentational: useStopEverything, owned by App, holds the state and the IPC (ADR-033 item 2).
 *
 * The words are design's (ADR-018 D5 copy items 4–7 and 9; ADR-002 O-3), looked up in the copy dictionary, and none
 * is written yet: each is a `⟦COPY NEEDED⟧` marker naming its copy item, the values it will carry filled into its
 * `{slot}`. Cancel is the design's own dialog label (copy.md, Dialog).
 */
import { computed } from 'vue'
import { formatList, t } from '@dwarfai/contracts'
import ModalDialog from '../overlay/ModalDialog.vue'
import type { DialogAction } from '../../lib/overlay/dialog'
import type { StopEverythingView } from '../../composables/useStopEverything'

const props = defineProps<{ view: StopEverythingView }>()
const emit = defineEmits<{ confirm: []; cancel: []; dismiss: [] }>()

interface Shown {
  title: string
  lines: string[]
  actions: DialogAction[]
}

const dialog = computed<Shown | null>(() => {
  const view = props.view
  if (view.kind === 'confirming') {
    const count = view.count
    return {
      title: t('stopEverything.confirmation.title'),
      lines: [
        t('stopEverything.confirmation.count', { count }),
        t('stopEverything.confirmation.ownTerminal')
      ],
      actions: [
        { label: t('dialog.cancel'), disabled: view.sending },
        {
          label: t('stopEverything.confirmation.confirm', { count }),
          variant: 'danger',
          disabled: view.sending
        }
      ]
    }
  }
  if (view.kind === 'incomplete') {
    return {
      title: t('stopEverything.incomplete.title'),
      lines: [t('stopEverything.incomplete.body', { names: formatList(view.failed) })],
      actions: [{ label: t('stopEverything.incomplete.dismiss') }]
    }
  }
  if (view.kind === 'unfinished') {
    return {
      title: t('stopEverything.unfinished.title'),
      lines: [t('stopEverything.unfinished.body')],
      actions: [{ label: t('stopEverything.unfinished.dismiss') }]
    }
  }
  return null
})

/** Esc and Cancel: the confirmation cancels (not once Confirm was chosen); the danger message is dismissed. */
function back(): void {
  const view = props.view
  if (view.kind === 'confirming' && !view.sending) emit('cancel')
  else if (view.kind === 'incomplete' || view.kind === 'unfinished') emit('dismiss')
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
