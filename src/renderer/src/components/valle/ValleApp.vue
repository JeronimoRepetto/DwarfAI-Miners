<script setup lang="ts">
/*
 * The Valle window's root (ADR-025 item 1; 07 machine 39; ISSUE-299): its own renderer of the same bundle, mounted for
 * `?mode=valle` once its stores were read (S39.03, `main.ts`), so its first paint is the stored layout. The window
 * around it lies on the work area of the display it was entered from (UI main, `ValleWindowController`).
 *
 * - The stores (`useValleStores`): the persisted preset, layouts, mosaic order, pins, last Work front mine and muted
 *   mines, and the session's Valle fields; read again after Reset metrics (S39.10). The presets, zones, pins and the
 *   rest that draw from them arrive with their issues (ISSUE-300…ISSUE-310); until then the root draws nothing of its
 *   own and no copy (hidden until built, 21 §1 item 8).
 * - The read models (`createValleReadModel`): the Host's mines and dwarfs, held as last known while the Host is
 *   unreachable (`data-held`, S34.12), a re-snapshot applied without motion.
 * - On screen (`useVallePresence`, S39.04, S39.05): each zone registers itself through `track` (provided as
 *   `VALLE_TRACK_ZONE`); only zones showing their mine and at least half inside the viewport are reported, nothing while
 *   hidden.
 * - The "started in" toast (`useValleArrivalToast`, S39.11) through the window's one toast queue (BR-23).
 *
 * The bridge is the composition root's (`valleBridgeOf(window.api)`, R13); the observer is the browser's own unless a
 * test hands one.
 */
import { computed, onMounted, onUnmounted, provide, shallowRef } from 'vue'
import { useValleArrivalToast } from '../../composables/useValleArrivalToast'
import { useVallePresence, type VallePresenceDeps } from '../../composables/useVallePresence'
import { useValleStores, type ValleStores } from '../../composables/useValleStores'
import { useToasts } from '../../composables/useToasts'
import { createValleReadModel } from '../../lib/valle/valleReadModel'
import ToastHost from '../overlay/ToastHost.vue'
import { VALLE_TRACK_ZONE } from './valleZones'
import type { ValleBridge } from './valleEntry'

const props = defineProps<{
  bridge: ValleBridge
  stores: ValleStores
  observer?: VallePresenceDeps['observer']
}>()

const { stores } = useValleStores(props.bridge, props.stores)
const model = createValleReadModel(props.bridge)

/** Whether Valle is the shown mode window: a hidden window's page is hidden (ADR-025 item 7). */
const shown = shallowRef(document.visibilityState === 'visible')
const visibilityChanged = (): void => {
  shown.value = document.visibilityState === 'visible'
}
document.addEventListener('visibilitychange', visibilityChanged)

const presence = useVallePresence({
  bridge: props.bridge,
  // No nav page covers the main zone until the pages are built (ISSUE-300).
  facts: () => ({ shown: shown.value, pageOverMain: false }),
  observer:
    props.observer ??
    ((callback, options) =>
      new IntersectionObserver(
        (entries) =>
          callback(entries.map(({ target, intersectionRatio }) => ({ target, intersectionRatio }))),
        options
      ))
})
provide(VALLE_TRACK_ZONE, presence.track)

const { showToast } = useToasts()
useValleArrivalToast({
  facts: model,
  onScreen: () => presence.onScreen(),
  shown: () => shown.value,
  showToast: (text) => showToast(text)
})
const held = computed(() => String(model.held.value))

onMounted(() => {
  void model.start()
})
onUnmounted(() => {
  document.removeEventListener('visibilitychange', visibilityChanged)
  model.stop()
})
</script>

<template>
  <main class="valle" data-valle-root :data-preset="stores.preset" :data-held="held">
    <ToastHost />
  </main>
</template>

<style scoped>
.valle {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
</style>
