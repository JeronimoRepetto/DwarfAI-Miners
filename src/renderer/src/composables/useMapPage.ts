/*
 * The Map page in use (#136, #635): the painting it wears by the time of day, and whether the board is still to arrive,
 * so the page claims no empty valley before it has been read (`loading`). Moved out of `App.vue` for ISSUE-304 so the
 * Valle window draws the same page; the Panel's behaviour is unchanged. Its mines, projects and actions are the board's
 * (`useMines`) and the Mines page's (`useMinesPage`).
 *
 * Call it in a component's setup: the time-of-day tick follows that component's mount.
 */
import { ref } from 'vue'
import { useMapTime } from './useMapTime'

export function useMapPage() {
  /** The painting the Map page wears, by the time of day (#136). */
  const variant = useMapTime()
  /** True until the board was first read, answered or not. */
  const loading = ref(true)
  return {
    variant,
    loading,
    /** The board was read once: the page draws what it holds, empty or not. */
    loaded(): void {
      loading.value = false
    }
  }
}

export type MapPage = ReturnType<typeof useMapPage>
