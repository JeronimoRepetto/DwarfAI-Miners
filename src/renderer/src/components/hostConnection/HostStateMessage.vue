<script setup lang="ts">
/*
 * The one Host-state message over the Panel (ADR-002 D9; 07 §12B; 14 §6.4 `useHostConnection`): its text and its one
 * action — Retry (A-N05) or Stop everything and quit (ADR-002 D8 item 5) — announced in a live region, `alert` for a
 * Host that is down and `status` for a reconnect or a degraded Host. A message with an action is this dialog and never
 * a toast; one without an action is a toast (below); neither is ever an OS notification (ADR-002 D9).
 *
 * A message with an action is the design's dialog (owner's design ruling 2026-10-02): the same `molecules/dialog` as
 * the remove-mine popup (MinesList) and ISSUE-317's confirmation, through ModalDialog. That gives a title, the message
 * in the body, the one action in the actions row holding the focus, Tab trapped, and focus back to the opener. The
 * Host being down is a danger state, drawn as the danger card. Two rules are this dialog's own:
 * - It has no Cancel, and Esc leaves it open. The design's dialog cancels on Esc (components.md, Dialog), but here
 *   there is nothing to go back to: the board is read-only while the Host is down, and the message stays until the
 *   Host connects or the person acts. The docs are silent on a dialog with no Cancel; ISSUE-056 decision.
 * - While another dialog holds the window (`covered`: the Stop everything and quit confirmation that its own action
 *   or the tray opens), it steps aside, and it comes back when that one closes. Two modal dialogs would fight over the
 *   focus trap, and only one message shows at a time.
 * A message without an action (reconnecting, elevated-refused, in-job) draws nothing here: it is one toast that
 * useHostConnection raises when its state is entered (owner's ruling 2026-10-02), so no Host-state banner sits over
 * the Panel. An action that cannot run here (Stop everything with no caller) draws nothing either, never a dead button.
 *
 * Presentational: the message comes from lib/hostConnection/hostStateMessage, and App.vue owns the calls. The words
 * are design's (ADR-002 O-4, O-5), looked up in the copy dictionary: every one is a marked placeholder so far. Stop everything and quit shows only when the
 * caller can run it (`onStopEverything`). With nothing to run it the action is absent, never a dead button (21 §1
 * item 8).
 */
import { computed } from 'vue'
import { t, type PlainCopyKey } from '@dwarfai/contracts'
import ModalDialog from '../overlay/ModalDialog.vue'
import type { DialogAction } from '../../lib/overlay/dialog'
import type { HostStateMessage, HostStateVariant } from '../../lib/hostConnection/hostStateMessage'

const props = withDefaults(
  defineProps<{
    message: HostStateMessage
    retrying?: boolean
    onStopEverything?: () => void
    /** Another dialog holds the window: the Host-state dialog steps aside until it closes. */
    covered?: boolean
  }>(),
  { retrying: false, onStopEverything: undefined, covered: false }
)
const emit = defineEmits<{ retry: [] }>()

/** The dialog titles of the variants that carry an action: design's words, none written yet (ADR-002 O-5, O-15). */
const TITLE: Readonly<Partial<Record<HostStateVariant, PlainCopyKey>>> = {
  'crash-loop': 'hostState.crashLoop.title',
  unresponsive: 'hostState.unresponsive.title',
  'spawn-failed': 'hostState.spawnFailed.title',
  incompatible: 'hostState.incompatible.title'
}

const role = computed(() => (props.message.live === 'assertive' ? 'alert' : 'status'))
const offersRetry = computed(() => props.message.action === 'retry')
const offersStop = computed(
  () => props.message.action === 'stop-everything' && props.onStopEverything !== undefined
)
const title = computed(() => {
  const key = TITLE[props.message.variant]
  return key === undefined ? undefined : t(key)
})
const asDialog = computed(
  () => (offersRetry.value || offersStop.value) && title.value !== undefined
)

const actions = computed<DialogAction[]>(() => [
  offersStop.value
    ? { label: props.message.actionLabel ?? '', variant: 'danger' }
    : { label: props.message.actionLabel ?? '', disabled: props.retrying }
])

function act(): void {
  if (offersStop.value) props.onStopEverything?.()
  else if (!props.retrying) emit('retry')
}
</script>

<template>
  <ModalDialog
    v-if="asDialog"
    :open="!covered"
    :title="title ?? ''"
    :actions="actions"
    danger
    @action="act"
  >
    <div
      class="dm-host-state__body dm-host-state"
      :role="role"
      :aria-live="message.live"
      :data-variant="message.variant"
    >
      <p>{{ message.text }}</p>
    </div>
  </ModalDialog>
</template>
