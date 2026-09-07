// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { usePanelLayout } from './usePanelLayout'
import { PANEL_LEAVE_BOUND_MS } from '../lib/shell/panelMotion'

/** A leave the frozen document timeline will never report as finished (#266). */
const stalledLeave = (): Promise<void> => new Promise<void>(() => undefined)

const CLOSED = { edge: 'right' as const, expanded: false, mineOpen: false }
const OPEN = { edge: 'right' as const, expanded: true, mineOpen: false }

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
  it('starts closed on the design’s default edge, before main has been asked', () => {
    stubApi()
    expect(usePanelLayout().layout.value).toEqual(CLOSED)
  })

  it('adopts the layout main reports', async () => {
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue({ ...OPEN, edge: 'left' }) })
    const { layout, sync } = usePanelLayout()
    await sync()
    expect(layout.value).toEqual({ edge: 'left', expanded: true, mineOpen: false })
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
    await apply({ expanded: true, mineOpen: false })
    expect(setPanelLayout).toHaveBeenCalledWith({ expanded: true, mineOpen: false })
    expect(layout.value.mineOpen).toBe(true)
  })

  it('re-reads the real layout after a failed request rather than assuming either outcome', async () => {
    const getPanelLayout = vi.fn().mockResolvedValue(OPEN)
    stubApi({
      getPanelLayout,
      setPanelLayout: vi.fn().mockRejectedValue(new Error('handler crashed'))
    })
    const { layout, apply } = usePanelLayout()
    await apply({ expanded: true, mineOpen: false })
    expect(getPanelLayout).toHaveBeenCalledOnce()
    expect(layout.value).toEqual(OPEN)
  })

  it('carries the mine column through the toggle helper', async () => {
    const setPanelLayout = vi.fn().mockResolvedValue(OPEN)
    stubApi({ setPanelLayout })
    const { toggle } = usePanelLayout()
    await toggle(true)
    expect(setPanelLayout).toHaveBeenCalledWith({ expanded: true, mineOpen: true })
  })

  it('asks main to move to the requested edge, keeping expanded and mineOpen (#138)', async () => {
    const setPanelLayout = vi
      .fn()
      .mockResolvedValue({ edge: 'left', expanded: true, mineOpen: false })
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue(OPEN), setPanelLayout })
    const { sync, setEdge } = usePanelLayout()
    await sync()
    await setEdge('left')
    expect(setPanelLayout).toHaveBeenCalledWith({ expanded: true, mineOpen: false, edge: 'left' })
  })

  it('renders the edge main actually applied, never the one the position control asked for', async () => {
    // Same honesty rule every other layout request follows: a display that
    // could not honor the move must reach the renderer as a fact.
    const setPanelLayout = vi
      .fn()
      .mockResolvedValue({ edge: 'right', expanded: true, mineOpen: false })
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue(OPEN), setPanelLayout })
    const { layout, setEdge } = usePanelLayout()
    await setEdge('left')
    expect(layout.value.edge).toBe('right')
  })

  it('collapses from whatever it is currently showing', async () => {
    const setPanelLayout = vi.fn().mockResolvedValue(CLOSED)
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue(OPEN), setPanelLayout })
    const { sync, toggle } = usePanelLayout()
    await sync()
    await toggle(false)
    expect(setPanelLayout).toHaveBeenCalledWith({ expanded: false, mineOpen: false })
  })

  it('queues a second request behind one still in flight rather than racing it', async () => {
    // Two resizes can land out of order and leave the shell drawn against a
    // rectangle the window no longer has. Dropping the second was worse: a
    // resize is triggered by opening a mine as well as by pressing the rail,
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
    const first = apply({ expanded: true, mineOpen: false })
    const second = apply({ expanded: false, mineOpen: false })
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
    const closing = panel.toggle(false)
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
      const closing = panel.toggle(false)
      await Promise.resolve()
      expect(api.setPanelLayout).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(PANEL_LEAVE_BOUND_MS)
      expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({
        expanded: false,
        mineOpen: false
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
    await panel.toggle(false)
    expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({
      expanded: false,
      mineOpen: false
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
    const opening = panel.toggle(false)
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
    const changing = panel.apply({ expanded: false, mineOpen: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({ expanded: true, mineOpen: true })
    expect(panel.layout.value).toEqual({ ...OPEN, mineOpen: true })
    expect(panel.visibleLayout.value).toEqual({ ...CLOSED, mineOpen: true })
    finish()
    await changing
    expect(api.setPanelLayout).toHaveBeenLastCalledWith({ expanded: false, mineOpen: true })
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
      const changing = panel.apply({ expanded: false, mineOpen: true })
      await Promise.resolve()
      await Promise.resolve()
      // The union is reserved and neither column is presented: exactly the
      // intermediate #266 got stuck in, and it may only last the bound.
      expect(api.setPanelLayout).toHaveBeenCalledExactlyOnceWith({ expanded: true, mineOpen: true })
      expect(panel.visibleLayout.value).toEqual({ ...CLOSED, mineOpen: true })
      await vi.advanceTimersByTimeAsync(PANEL_LEAVE_BOUND_MS)
      expect(api.setPanelLayout).toHaveBeenLastCalledWith({ expanded: false, mineOpen: true })
      await changing
      expect(panel.layout.value).toEqual({ ...CLOSED, mineOpen: true })
      expect(panel.visibleLayout.value).toEqual(panel.layout.value)
    } finally {
      vi.useRealTimers()
    }
  })

  it('interprets rapid double toggles as open then closed rather than two stale opens', async () => {
    const api = stubApi({
      setPanelLayout: vi.fn(async (request) => ({ edge: 'right', ...request }))
    })
    const panel = usePanelLayout()
    await Promise.all([panel.toggle(false), panel.toggle(false)])
    expect(api.setPanelLayout.mock.calls.map(([request]) => request.expanded)).toEqual([
      true,
      false
    ])
    expect(panel.visibleLayout.value).toEqual(CLOSED)
  })

  it('restores presentation to native readback after a rejected shrink', async () => {
    stubApi({
      getPanelLayout: vi.fn().mockResolvedValue(OPEN),
      setPanelLayout: vi.fn().mockRejectedValue(new Error('resize refused'))
    })
    const panel = usePanelLayout()
    await panel.sync()
    await panel.toggle(false)
    expect(panel.layout.value).toEqual(OPEN)
    expect(panel.visibleLayout.value).toEqual(OPEN)
  })
})
