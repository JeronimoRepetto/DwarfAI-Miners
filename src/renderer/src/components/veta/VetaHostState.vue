<script setup lang="ts">
/*
 * Veta's Host-state surface (ADR-002 D9; 07 §12B; UC-067; ISSUE-296): the Panel's one Host-state message
 * (`HostStateMessage`, its dialog, its words and its Retry, A-N05), hosted unchanged inside the Veta window, so the
 * person reaches it by pointer and by keyboard where they are and Veta never switches to the Panel to show it.
 *
 * - It follows the window's Host connection (`useHostConnection`, A-N03 then A-N04) for as long as it is mounted: the
 *   same singleton the hosted chat and launch gate their mutations on (`readOnly`), so Veta is read-only while the Host
 *   is away (S20.15).
 * - The window hugs the island, so the message needs it grown first (DR-03: the risen window's geometry, 07 machine 24,
 *   until design places it): `room(true)` is asked, and the message shows once that is answered; once it has gone, the
 *   room is given back with `room(false)`. A later change of the connection stamps out an earlier one's late answer.
 * - What it shows is what `HostStateMessage` draws as a dialog: a message with Retry (crash loop, hung Host, spawn
 *   failed). Reconnecting and the other notices without an action draw nothing here (S12.B04: no toast, the strip
 *   held). The incompatible message's one action, Stop everything and quit, needs its confirmation surface, which Veta
 *   does not host: an action that cannot run here is absent, so that message draws nothing in Veta (21 §1 item 8).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HostStateMessage from '../hostConnection/HostStateMessage.vue'
import { useHostConnection } from '../../composables/useHostConnection'

const props = defineProps<{
  /** Grows the window for the message (`true`), or gives the room back (`false`); resolves once answered. */
  room: (open: boolean) => Promise<void>
}>()
const emit = defineEmits<{ shown: [shown: boolean] }>()

const { message, retrying, start, stop, retry } = useHostConnection()

/** A message with Retry: the one kind Veta can show with its action. */
const wanted = computed(() => message.value.action === 'retry' && message.value.text !== null)
const shown = ref(false)
/** The window holds the message's room. */
let placed = false
/** Stamps each change, so a late answer never shows a message that has gone meanwhile. */
let stamp = 0

watch(
  wanted,
  async (now) => {
    const mine = ++stamp
    if (now) {
      await props.room(true)
      placed = true
      if (mine === stamp) shown.value = true
      return
    }
    shown.value = false
    if (!placed) return
    // It leaves the page first; the window shrinks only after (ADR-025 item 2).
    await nextTick()
    if (mine !== stamp) return
    placed = false
    await props.room(false)
  },
  { immediate: true }
)
watch(shown, (now) => emit('shown', now))

onMounted(() => {
  void start()
})
onBeforeUnmount(() => {
  stop()
})
</script>

<template>
  <HostStateMessage v-if="shown" :message="message" :retrying="retrying" @retry="retry" />
</template>
