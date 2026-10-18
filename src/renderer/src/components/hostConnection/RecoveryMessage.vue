<script setup lang="ts">
/*
 * The grouped recovery message (ADR-015 item 5, O-15; 14 §6.4 recovery-message store; 07 machine 16; ISSUE-330): after
 * a Host restart that could not resume every session, ONE message names every dwarf that could not come back, with
 * Dismiss and Try again. It sits on the Host-state surface in the crash-loop message's family (ADR-002 D9), so it is
 * the same design dialog as HostStateMessage.vue (molecules/dialog through ModalDialog), and it is never a toast and
 * never one message per dwarf (INV-58: one report per Host epoch).
 *
 * - The words are the owner's, approved 2026-10-17 (copy keys `recovery.message.*`): one plain-language body, the
 *   dwarfs' display names listed after it, each in a <bdi> so a name's direction never reorders the list.
 * - Dismiss comes first, as the dialog's Cancel does, and Try again is the primary action. Esc leaves it open:
 *   dismissing is a Host mutation (A-N11), so it is only ever the button.
 * - While an action is on its way both are disabled. While another dialog holds the window (`covered`) it steps
 *   aside and comes back when that one closes, as the Host-state message does.
 *
 * Presentational: useRecoveryReport holds the report, and App.vue owns the calls (ADR-033 item 2).
 */
import { computed } from 'vue'
import { t } from '@dwarfai/contracts'
import ModalDialog from '../overlay/ModalDialog.vue'
import type { DialogAction } from '../../lib/overlay/dialog'

const props = withDefaults(
  defineProps<{
    /** Whether the Host holds a report that has not settled. */
    shown: boolean
    /** The display names of the dwarfs that could not be recovered, in the report's order. */
    names: string[]
    /** A Try again or Dismiss is on its way. */
    acting?: boolean
    /** Another dialog holds the window: this one steps aside until it closes. */
    covered?: boolean
  }>(),
  { acting: false, covered: false }
)
const emit = defineEmits<{ retry: []; dismiss: [] }>()

const actions = computed<DialogAction[]>(() => [
  { label: t('recovery.message.dismiss'), disabled: props.acting },
  { label: t('recovery.message.retry'), variant: 'primary', disabled: props.acting }
])

function act(index: number): void {
  if (props.acting) return
  if (index === 0) emit('dismiss')
  else emit('retry')
}
</script>

<template>
  <ModalDialog
    v-if="shown"
    :open="!covered"
    :title="t('recovery.message.title')"
    :actions="actions"
    @action="act"
  >
    <div class="dm-recovery" role="status" aria-live="polite">
      <p>{{ t('recovery.message.body') }}</p>
      <ul class="dm-recovery__names">
        <li v-for="(name, index) in names" :key="index">
          <bdi>{{ name }}</bdi>
        </li>
      </ul>
    </div>
  </ModalDialog>
</template>

<style scoped>
.dm-recovery__names {
  margin: 0;
  padding-inline-start: 1.25em;
}
</style>
