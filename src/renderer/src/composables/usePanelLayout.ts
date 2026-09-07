import { ref } from 'vue'
import type { PanelEdge, PanelLayout, PanelLayoutRequest } from '../types'
import { PANEL_LEAVE_BOUND_MS } from '../lib/shell/panelMotion'

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
export function usePanelLayout(waitForLeave: () => Promise<void> = () => Promise.resolve()) {
  // Matches main's own starting layout, so the first paint is right before
  // sync() has answered; the design names Right as the default side.
  const layout = ref<PanelLayout>({ edge: 'right', expanded: false, mineOpen: false })
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
   * pressing the rail, so the two can genuinely overlap.
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
   * open forever — so the rail stopped answering too, and the window kept the
   * width of a column it was no longer showing.
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
          timer = setTimeout(resolve, PANEL_LEAVE_BOUND_MS)
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
        (layout.value.expanded && !request.expanded) || (layout.value.mineOpen && !request.mineOpen)
      const growing =
        (!layout.value.expanded && request.expanded) || (!layout.value.mineOpen && request.mineOpen)
      if (shrinking) {
        // A swap can grow one column while retiring another. Reserve their
        // union first; neither animation may draw outside the native window.
        if (growing) {
          layout.value = await window.api.setPanelLayout({
            ...request,
            expanded: layout.value.expanded || request.expanded,
            mineOpen: layout.value.mineOpen || request.mineOpen
          })
        }
        visibleLayout.value = {
          ...layout.value,
          expanded: layout.value.expanded && request.expanded,
          mineOpen: layout.value.mineOpen && request.mineOpen
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

  /** Open or collapse, keeping whichever mine column the shell currently needs. */
  async function toggle(mineOpen: boolean): Promise<void> {
    // Evaluate toggles when dequeued, not against the same stale pre-IPC state.
    queue = queue.then(() => send({ expanded: !layout.value.expanded, mineOpen }))
    await queue
  }

  /**
   * Settings' position control asking to redock (#138) — the only caller that
   * may ever send `edge`. Keeps expanded/mineOpen as they currently are: the
   * position control moves the docked side, not whether the panel is open or
   * whether a mine is held beside it.
   */
  async function setEdge(edge: PanelEdge): Promise<void> {
    queue = queue.then(() =>
      send({ expanded: layout.value.expanded, mineOpen: layout.value.mineOpen, edge })
    )
    await queue
  }

  return { layout, visibleLayout, applying, sync, apply, toggle, setEdge }
}
