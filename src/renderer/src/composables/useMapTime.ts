import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { MAP_TIME_REFRESH_MS, mapVariantAt, type MapTimeVariant } from '../lib/map/mapTime'

/*
 * The painting the valley is wearing (#136), re-read from the clock on a slow tick (see
 * MAP_TIME_REFRESH_MS for why a tick and not one alarm at the boundary). Owned by the host, not the
 * Map page (#635): the page paints whichever variant it is handed. The interval is cleared with
 * its host, since a timer left running per visit is a leak nothing on screen would ever show.
 */
export function useMapTime(): Ref<MapTimeVariant> {
  const variant = ref<MapTimeVariant>(mapVariantAt(new Date()))
  let tick: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    tick = setInterval(() => {
      variant.value = mapVariantAt(new Date())
    }, MAP_TIME_REFRESH_MS)
  })
  onBeforeUnmount(() => {
    if (tick !== null) clearInterval(tick)
    tick = null
  })
  return variant
}
