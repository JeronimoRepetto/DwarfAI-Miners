import { ref } from 'vue'
import type { PanelLayout, PanelLayoutRequest } from '../types'

/**
 * State for the docked shell's own shape (#90).
 *
 * The same honesty rule `usePinnedWindow` enforces, and for a stronger reason:
 * main derives the window's rectangle from the DISPLAY, so a request can come
 * back changed — a screen too narrow for the whole composition, or an edge the
 * renderer never chose. `layout` therefore only ever changes to something main
 * reported, because the rail's arrow is drawn from `edge` and the shell's
 * columns from `expanded`, and drawing either against a wish rather than a fact
 * points the user at a panel that is not there.
 *
 * No module-scope singleton: App is the only consumer, so per-call refs keep
 * tests independent without a clearAll() ritual.
 */
export function usePanelLayout() {
  // Matches main's own starting layout, so the first paint is right before
  // sync() has answered; the design names Right as the default side.
  const layout = ref<PanelLayout>({ edge: 'right', expanded: false, mineOpen: false })
  const applying = ref(false)

  /** Adopt the window's real layout; on failure keep the last known one. */
  async function sync(): Promise<void> {
    try {
      layout.value = await window.api.getPanelLayout()
    } catch {
      // The bridge is unreachable: the last known layout is still the most
      // honest thing to render, and the next successful call corrects it.
    }
  }

  /**
   * Requests are SERIALIZED rather than dropped: two of them can land out of
   * order and leave the shell drawn against a rectangle the window no longer
   * has, but a dropped one leaves the window at a width nothing will correct.
   * Both matter here — a resize is triggered by opening a mine as well as by
   * pressing the rail, so the two can genuinely overlap.
   */
  let queue: Promise<void> = Promise.resolve()

  async function send(request: PanelLayoutRequest): Promise<void> {
    applying.value = true
    try {
      layout.value = await window.api.setPanelLayout(request)
    } catch {
      // The failed request may or may not have reached the window before
      // breaking: re-read the real layout rather than assume either outcome.
      await sync()
    } finally {
      applying.value = false
    }
  }

  /** Ask main to reshape the window, behind anything already in flight. */
  async function apply(request: PanelLayoutRequest): Promise<void> {
    queue = queue.then(() => send(request))
    await queue
  }

  /** Open or collapse, keeping whichever mine column the shell currently needs. */
  async function toggle(mineOpen: boolean): Promise<void> {
    await apply({ expanded: !layout.value.expanded, mineOpen })
  }

  return { layout, applying, sync, apply, toggle }
}
