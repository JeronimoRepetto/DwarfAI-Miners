import { shallowRef } from 'vue'
import { createToastQueue, type Toast } from '../lib/overlay/toast'
import type { IconName } from '../lib/icon/iconGrids'

/*
 * The window's one toast queue (#635): a module singleton, because the host that draws the toasts
 * and every surface that raises one must share it, and there is exactly one host per window.
 */
const toasts = shallowRef<readonly Toast[]>([])
const queue = createToastQueue(
  (run, ms) => {
    setTimeout(run, ms)
  },
  (list) => {
    toasts.value = list
  }
)

export function useToasts() {
  return {
    toasts,
    showToast: (text: string, icon?: IconName): void => queue.show(text, icon)
  }
}
