import { ref } from 'vue'
import type { PanelEdge, PanelLayout, PanelLayoutRequest } from '../types'
import { panelLeaveBoundMs } from '../lib/shell/panelMotion'

/**
 * State for the docked shell's own shape (#90).
 *
 * The same honesty rule `usePinnedWindow` enforces, and for a stronger reason:
 * main derives the window's rectangle from the DISPLAY, so a request can come
 * back changed — a screen too narrow for the whole composition, or an edge the
 * renderer never chose. `layout` therefore only ever changes to something main
 * reported, because the shell's columns and its dock slot are drawn from it,
 * and drawing them against a wish rather than a fact paints columns into width
 * the window does not have.
 *
 * No module-scope singleton: App is the only consumer, so per-call refs keep
 * tests independent without a clearAll() ritual.
 */
export function usePanelLayout(waitForLeave: () => Promise<void> = () => Promise.resolve()) {
  // Matches main's own starting layout, so the first paint is right before
  // sync() has answered: the Panel with nothing beside its page (#635), on the
  // side the design names as the default.
  const layout = ref<PanelLayout>({ edge: 'right', mineOpen: false, dockOpen: false })
  // Presentation may put a column away while its last frame still needs native
  // bounds. This is never evidence that main has already resized the window.
  const visibleLayout = ref<PanelLayout>({ ...layout.value })
  const applying = ref(false)

  /** Adopt the window's real layout; on failure keep the last known one. */
  async function sync(): Promise<void> {
    try {
      layout.value = await window.api.getPanelLayout()
    } catch {
      // The bridge is unreachable: the last known layout is still the most
      // honest thing to render, and the next successful call corrects it.
    }
    visibleLayout.value = layout.value
  }

  /**
   * Requests are SERIALIZED rather than dropped: two of them can land out of
   * order and leave the shell drawn against a rectangle the window no longer
   * has, but a dropped one leaves the window at a width nothing will correct.
   * Both matter here — a resize is triggered by opening a mine as well as by
   * opening the dock, so the two can genuinely overlap.
   */
  let queue: Promise<void> = Promise.resolve()

  /**
   * `visibleLayout` may diverge from `layout` only for a BOUNDED time (#266).
   *
   * The divergence is the shell drawn as its widest composition with a column
   * on its way out, and it is the one state in which the amber ground can be
   * painted over nothing at all. Presentation asked to end it and nothing here
   * can make it: a leave reports completion from an animation whose timeline
   * the platform is free to freeze, and one that never reports held this queue
   * open forever — so every later request stopped answering too, and the window
   * kept the width of a column it was no longer showing.
   *
   * A leave that overruns therefore loses its say rather than the shrink. Its
   * rejection is swallowed for the same reason: a torn-down leave is not
   * evidence that the layout it was retiring should stay.
   */
  async function boundedLeave(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        waitForLeave().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, panelLeaveBoundMs())
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function send(request: PanelLayoutRequest): Promise<void> {
    applying.value = true
    try {
      const shrinking =
        (layout.value.dockOpen && !request.dockOpen) || (layout.value.mineOpen && !request.mineOpen)
      const growing =
        (!layout.value.dockOpen && request.dockOpen) || (!layout.value.mineOpen && request.mineOpen)
      if (shrinking) {
        // A swap can grow one column while retiring another. Reserve their
        // union first; neither animation may draw outside the native window.
        if (growing) {
          layout.value = await window.api.setPanelLayout({
            ...request,
            mineOpen: layout.value.mineOpen || request.mineOpen,
            dockOpen: layout.value.dockOpen || request.dockOpen
          })
        }
        visibleLayout.value = {
          ...layout.value,
          mineOpen: layout.value.mineOpen && request.mineOpen,
          dockOpen: layout.value.dockOpen && request.dockOpen
        }
        await boundedLeave()
      }
      layout.value = await window.api.setPanelLayout(request)
      // The one place the divergence above is closed: whatever presentation
      // was showing mid-shrink, what stands afterwards is what main reported.
      visibleLayout.value = layout.value
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

  /*
   * `toggle` stood here until #635: the closed rail's arrow opening and closing
   * the page. The rail went (PO ruling 2026-09-27), and every request left names
   * the state it wants.
   */

  /**
   * Settings' position control asking to redock (#138) — the only caller that
   * may ever send `edge`. Keeps mineOpen/dockOpen as they currently are: the
   * position control moves the docked side, not what stands beside the page.
   */
  async function setEdge(edge: PanelEdge): Promise<void> {
    queue = queue.then(() =>
      send({ mineOpen: layout.value.mineOpen, dockOpen: layout.value.dockOpen, edge })
    )
    await queue
  }

  return { layout, visibleLayout, applying, sync, apply, setEdge }
}
