// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { usePanelLayout } from './usePanelLayout'

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

  it('collapses from whatever it is currently showing', async () => {
    const setPanelLayout = vi.fn().mockResolvedValue(CLOSED)
    stubApi({ getPanelLayout: vi.fn().mockResolvedValue(OPEN), setPanelLayout })
    const { sync, toggle } = usePanelLayout()
    await sync()
    await toggle(false)
    expect(setPanelLayout).toHaveBeenCalledWith({ expanded: false, mineOpen: false })
  })

  it('ignores a second request while one is still in flight', async () => {
    // Two racing resizes could land out of order and leave the panel drawn
    // against a rectangle the window no longer has.
    let release: (value: unknown) => void = () => undefined
    const setPanelLayout = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    stubApi({ setPanelLayout })
    const { apply } = usePanelLayout()
    const first = apply({ expanded: true, mineOpen: false })
    await apply({ expanded: false, mineOpen: false })
    expect(setPanelLayout).toHaveBeenCalledOnce()
    release(OPEN)
    await first
  })
})
