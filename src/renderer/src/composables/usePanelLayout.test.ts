// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { usePanelLayout } from './usePanelLayout'
import { panelLeaveBoundMs } from '../lib/shell/panelMotion'

/** A leave the frozen document timeline will never report as finished (#266). */
const stalledLeave = (): Promise<void> => new Promise<void>(() => undefined)

/*
 * AMENDED for #635, once here rather than at each use. `expanded` left the layout with the
 * closed rail (PO ruling 2026-09-27), and `dockOpen` — the dock's window slot beside the shell —
 * took its place as the second column the window grows and shrinks for. `CLOSED` is the Panel
 * with nothing docked beside it (was: the rail), `OPEN` the Panel with its dock slot open (was:
 * the page drawn); every case below keeps its subject, the queue and the leave bounds, over the
 * dimension that replaced the old one. The rail toggle helper went with the rail: its cases now
 * call `apply` with the request the toggle used to build.
 */
const CLOSED = { edge: 'right' as const, mineOpen: false, dockOpen: false }
const OPEN = { edge: 'right' as const, mineOpen: false, dockOpen: true }

function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getPanelLayout: vi.fn().mockResolvedValue(CLOSED),
    setPanelLayout: vi.fn().mockResolvedValue(OPEN),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

describe('usePanelLayout', () => {
  it('starts as the Panel with nothing docked, on the design’s default edge, before main has been asked', () => {
    stubApi()
    expect(usePanelLayout().layout.value).toEqual(CLOSED)
  })

  it('adopts the layout main reports', async () => {
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue({ ...OPEN, edge: 'left' }) })
    const { layout, sync } = usePanelLayout()
    await sync()
    expect(layout.value).toEqual({ edge: 'left', mineOpen: false, dockOpen: true })
  })

  it('keeps the last known layout when the bridge cannot be reached', async () => {
    stubApi({ getPanelLayout: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const { layout, sync } = usePanelLayout()
    await sync()
    expect(layout.value).toEqual(CLOSED)
  })

  it('renders the layout main answered, never the one it asked for', async () => {
    // The window is derived from the display: a screen too narrow for the
    // composition, or an edge the user has not chosen, comes back changed.
    const setPanelLayout = vi.fn().mockResolvedValue({ ...OPEN, mineOpen: true })
    stubApi({ setPanelLayout })
    const { layout, apply } = usePanelLayout()
    await apply({ mineOpen: false, dockOpen: true })
    expect(setPanelLayout).toHaveBeenCalledWith({ mineOpen: false, dockOpen: true })
    expect(layout.value.mineOpen).toBe(true)
  })

  it('re-reads the real layout after a failed request rather than assuming either outcome', async () => {
    const getPanelLayout = vi.fn().mockResolvedValue(OPEN)
    stubApi({
      getPanelLayout,
      setPanelLayout: vi.fn().mockRejectedValue(new Error('handler crashed'))
    })
    const { layout, apply } = usePanelLayout()
    await apply({ mineOpen: false, dockOpen: true })
    expect(getPanelLayout).toHaveBeenCalledOnce()
    expect(layout.value).toEqual(OPEN)
  })

  /*
   * REMOVED for #635, stated here rather than passing unseen: "carries the mine column through
   * the toggle helper". The helper was the rail's arrow and went with it; a request carries the
   * mine column because every request names both columns now, which "asks main to move to the
   * requested edge…" below asserts.
   */

  // AMENDED for #635 (was: "…keeping expanded and mineOpen"): the two columns a request names.
  it('asks main to move to the requested edge, keeping mineOpen and dockOpen (#138)', async () => {
    const setPanelLayout = vi
      .fn()
      .mockResolvedValue({ edge: 'left', mineOpen: false, dockOpen: true })
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue(OPEN), setPanelLayout })
    const { sync, setEdge } = usePanelLayout()
    await sync()
    await setEdge('left')
    expect(setPanelLayout).toHaveBeenCalledWith({ mineOpen: false, dockOpen: true, edge: 'left' })
  })

  it('renders the edge main actually applied, never the one the position control asked for', async () => {
    // Same honesty rule every other layout request follows: a display that
    // could not honor the move must reach the renderer as a fact.
    const setPanelLayout = vi
      .fn()
      .mockResolvedValue({ edge: 'right', mineOpen: false, dockOpen: true })
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue(OPEN), setPanelLayout })
    const { layout, setEdge } = usePanelLayout()
    await setEdge('left')
    expect(layout.value.edge).toBe('right')
  })

  // AMENDED for #635 (was: the rail toggle collapsing the page): the dock slot closing.
  it('closes the dock from whatever it is currently showing', async () => {
    const setPanelLayout = vi.fn().mockResolvedValue(CLOSED)
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue(OPEN), setPanelLayout })
    const { sync, apply } = usePanelLayout()
    await sync()
    await apply({ mineOpen: false, dockOpen: false })
    expect(setPanelLayout).toHaveBeenCalledWith({ mineOpen: false, dockOpen: false })
  })

  it('queues a second request behind one still in flight rather than racing it', async () => {
    // Two resizes can land out of order and leave the shell drawn against a
    // rectangle the window no longer has. Dropping the second was worse: a
    // resize is triggered by opening a mine as well as by opening the dock,
    // so the two genuinely overlap and a dropped one is never corrected.
    let release: (value: unknown) => void = () => undefined
    const setPanelLayout = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        })
      )
      .mockResolvedValue(CLOSED)
    stubApi({ setPanelLayout })
    const { layout, apply } = usePanelLayout()
    const first = apply({ mineOpen: false, dockOpen: true })
    const second = apply({ mineOpen: false, dockOpen: false })
    // One microtask is all the queue needs to start the first request; the
    // second is still waiting behind it.
    await Promise.resolve()
    expect(setPanelLayout).toHaveBeenCalledOnce()

    release(OPEN)
    await first
    await second
    expect(setPanelLayout).toHaveBeenCalledTimes(2)
    // The last request is what the window ended on, not the first to answer.
    expect(layout.value).toEqual(CLOSED)
  })

  it('keeps honest native bounds while closing presentation waits for the last leave', async () => {
    let finish!: () => void
    const waitForLeave = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const api = stubApi({
      getPanelLayout: vi.fn().mockResolvedValue(OPEN),
      setPanelLayout: vi.fn().mockResolvedValue(CLOSED)
    })
    const panel = usePanelLayout(waitForLeave)
    await panel.sync()
    const closing = panel.apply({ mineOpen: false, dockOpen: false })
    await Promise.resolve()
    expect(panel.layout.value).toEqual(OPEN)
    expect(panel.visibleLayout.value).toEqual(CLOSED)
    expect(api.setPanelLayout).not.toHaveBeenCalled()
    finish()
    await closing
    expect(panel.layout.value).toEqual(CLOSED)
  })

  it('lands the shrink on the bound when the last leave never reports completion (#266)', async () => {
    // An occluded window freezes Chromium's document timeline, so the leave
    // finishes on screen and never says so. Waiting on it forever left the
    // shell painting its amber ground over columns nothing would remove.
    vi.useFakeTimers()
    try {
      const api = stubApi({
        getPanelLayout: vi.fn().mockResolvedValue(OPEN),
        setPanelLayout: vi.fn().mockResolvedValue(CLOSED)
      })
      const panel = usePanelLayout(stalledLeave)
      await panel.sync()
      const closing = panel.apply({ mineOpen: false, dockOpen: false })
      await Promise.resolve()
      expect(api.setPanelLayout).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(panelLeaveBoundMs())
      expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({
        mineOpen: false,
        dockOpen: false
      })
      await closing
      expect(panel.layout.value).toEqual(CLOSED)
      expect(panel.visibleLayout.value).toEqual(panel.layout.value)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles presentation to the real layout when a leave rejects instead of resolving (#266)', async () => {
    // A thrown leave is not evidence the shrink should be abandoned: dropping
    // it left the window at its old width with nothing drawn in the width.
    const api = stubApi({
      getPanelLayout: vi.fn().mockResolvedValue(OPEN),
      setPanelLayout: vi.fn().mockResolvedValue(CLOSED)
    })
    const panel = usePanelLayout(() => Promise.reject(new Error('leave torn down')))
    await panel.sync()
    await panel.apply({ mineOpen: false, dockOpen: false })
    expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({
      mineOpen: false,
      dockOpen: false
    })
    expect(panel.visibleLayout.value).toEqual(CLOSED)
  })

  it('does not mount opening content before main has reserved its bounds', async () => {
    let answer!: (value: typeof OPEN) => void
    stubApi({
      setPanelLayout: vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve
          })
      )
    })
    const panel = usePanelLayout()
    const opening = panel.apply({ mineOpen: false, dockOpen: true })
    await Promise.resolve()
    expect(panel.visibleLayout.value).toEqual(CLOSED)
    answer(OPEN)
    await opening
    expect(panel.visibleLayout.value).toEqual(OPEN)
  })

  it('reserves the union before swapping columns and shrinks only after the outgoing leave', async () => {
    let finish!: () => void
    const api = stubApi({
      getPanelLayout: vi.fn().mockResolvedValue(OPEN),
      setPanelLayout: vi.fn(async (request) => ({ edge: 'right', ...request }))
    })
    const panel = usePanelLayout(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await panel.sync()
    const changing = panel.apply({ mineOpen: true, dockOpen: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({ mineOpen: true, dockOpen: true })
    expect(panel.layout.value).toEqual({ ...OPEN, mineOpen: true })
    expect(panel.visibleLayout.value).toEqual({ ...CLOSED, mineOpen: true })
    finish()
    await changing
    expect(api.setPanelLayout).toHaveBeenLastCalledWith({ mineOpen: true, dockOpen: false })
  })

  it('finishes a column swap on the bound when the outgoing leave never finishes (#266)', async () => {
    vi.useFakeTimers()
    try {
      const api = stubApi({
        getPanelLayout: vi.fn().mockResolvedValue(OPEN),
        setPanelLayout: vi.fn(async (request) => ({ edge: 'right', ...request }))
      })
      const panel = usePanelLayout(stalledLeave)
      await panel.sync()
      const changing = panel.apply({ mineOpen: true, dockOpen: false })
      await Promise.resolve()
      await Promise.resolve()
      // The union is reserved and neither column is presented: exactly the
      // intermediate #266 got stuck in, and it may only last the bound.
      expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({ mineOpen: true, dockOpen: true })
      expect(panel.visibleLayout.value).toEqual({ ...CLOSED, mineOpen: true })
      await vi.advanceTimersByTimeAsync(panelLeaveBoundMs())
      expect(api.setPanelLayout).toHaveBeenLastCalledWith({ mineOpen: true, dockOpen: false })
      await changing
      expect(panel.layout.value).toEqual({ ...CLOSED, mineOpen: true })
      expect(panel.visibleLayout.value).toEqual(panel.layout.value)
    } finally {
      vi.useRealTimers()
    }
  })

  /*
   * REMOVED for #635, stated here rather than passing unseen: "interprets rapid double toggles
   * as open then closed rather than two stale opens". It held the rail toggle's one rule — read
   * the state it flips when dequeued, not when pressed — and the toggle went with the rail. Every
   * request left names the state it wants, and "queues a second request behind one still in
   * flight" above holds that the last one asked for is what the window ends on.
   */

  it('restores presentation to native readback after a rejected shrink', async () => {
    stubApi({
      getPanelLayout: vi.fn().mockResolvedValue(OPEN),
      setPanelLayout: vi.fn().mockRejectedValue(new Error('resize refused'))
    })
    const panel = usePanelLayout()
    await panel.sync()
    await panel.apply({ mineOpen: false, dockOpen: false })
    expect(panel.layout.value).toEqual(OPEN)
    expect(panel.visibleLayout.value).toEqual(OPEN)
  })
})
