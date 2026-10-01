<script setup lang="ts">
/*
 * The one Host-state message over the Panel (ADR-002 D9; 07 §12B; 14 §6.4 `useHostConnection`): its text and its one
 * action — Retry (A-N05) or Stop everything and quit (ADR-002 D8 item 5) — announced in a live region, `alert` for a
 * Host that is down and `status` for a reconnect or a degraded Host. No toast and no OS notification (ADR-002 D9).
 *
 * Presentational: the message comes from lib/hostConnection/hostStateMessage, and App.vue owns the calls. The
 * words and the look are design's (ADR-002 O-4, O-5): the strings are marked placeholders and the surface uses the
 * existing tokens and material until design draws it. Stop everything and quit shows only when the caller can run
 * it (`onStopEverything`); with nothing to run it the action is absent, never a dead button (21 §1 item 8).
 */
import { computed } from 'vue'
import ActionButton from '../controls/ActionButton.vue'
import type { HostStateMessage } from '../../lib/hostConnection/hostStateMessage'

const props = withDefaults(
  defineProps<{
    message: HostStateMessage
    retrying?: boolean
    onStopEverything?: () => void
  }>(),
  { retrying: false, onStopEverything: undefined }
)
const emit = defineEmits<{ retry: [] }>()

const role = computed(() => (props.message.live === 'assertive' ? 'alert' : 'status'))
const offersRetry = computed(() => props.message.action === 'retry')
const offersStop = computed(
  () => props.message.action === 'stop-everything' && props.onStopEverything !== undefined
)
</script>

<template>
  <div
    v-if="message.variant !== 'none'"
    class="dm-host-state m-mat m-raised"
    :class="{ 'dm-host-state--down': message.live === 'assertive' }"
    :role="role"
    :aria-live="message.live"
    :data-variant="message.variant"
  >
    <p class="dm-host-state__text">{{ message.text }}</p>
    <ActionButton
      v-if="offersRetry"
      :label="message.actionLabel ?? undefined"
      :disabled="retrying"
      type="button"
      @click="emit('retry')"
    />
    <ActionButton
      v-else-if="offersStop"
      :label="message.actionLabel ?? undefined"
      variant="danger"
      type="button"
      @click="onStopEverything?.()"
    />
  </div>
</template>

<style scoped>
/* Undrawn by design yet (ADR-002 O-5): the dialog's material and type tokens, nothing invented. */
.dm-host-state {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--parchment);
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-overlay);
  width: min(380px, calc(100% - 16px));
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
}
.dm-host-state--down {
  --mat-edge: var(--danger);
}
.dm-host-state__text {
  flex: 1;
  font: var(--fs-body) / 1.4 var(--f-talk);
  color: var(--ink);
}
</style>
