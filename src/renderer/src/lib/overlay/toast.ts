/*
 * The toast queue (#635), `molecules/toast` in the design: a one-line confirmation of something
 * that already happened, with an optional icon, that leaves by itself after 2.6s. Each toast keeps
 * its own clock, so a second one never shortens the first. The timer is injected, so the queue is
 * a plain value the tests drive by hand; the host component draws what it lists.
 */
import type { IconName } from '../icon/iconGrids'

/** How long a toast stays before it leaves (motion.md, Overlays). */
export const TOAST_MS = 2600

export interface Toast {
  id: number
  text: string
  icon: IconName
}

export interface ToastQueue {
  show(text: string, icon?: IconName): void
  toasts(): readonly Toast[]
}

export function createToastQueue(
  schedule: (run: () => void, ms: number) => void,
  onChange: (toasts: readonly Toast[]) => void = () => {}
): ToastQueue {
  let list: Toast[] = []
  let next = 0
  return {
    show(text, icon = 'info') {
      const toast = { id: ++next, text, icon }
      list = [...list, toast]
      onChange(list)
      schedule(() => {
        list = list.filter((t) => t.id !== toast.id)
        onChange(list)
      }, TOAST_MS)
    },
    toasts: () => list
  }
}
