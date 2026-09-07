// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useMessagePanel } from './useMessagePanel'

const CLOSED = { surface: 'none' as const, mineId: '', dwarfId: '' }
const OPEN = { surface: 'message' as const, mineId: 'mine:a', dwarfId: 'claude:s1' }

function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getMessagePanel: vi.fn().mockResolvedValue(CLOSED),
    setMessagePanel: vi.fn().mockImplementation((state: unknown) => Promise.resolve(state)),
    onMessagePanel: vi.fn().mockReturnValue(() => undefined),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

describe('useMessagePanel', () => {
  it('starts closed, before main has been asked anything', () => {
    stubApi()
    expect(useMessagePanel().state.value).toEqual(CLOSED)
  })

  it('adopts the state main reports', async () => {
    stubApi({ getMessagePanel: vi.fn().mockResolvedValue(OPEN) })
    const { state, sync } = useMessagePanel()
    await sync()
    expect(state.value).toEqual(OPEN)
  })

  it('keeps the last known state when the bridge cannot be reached', async () => {
    stubApi({ getMessagePanel: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const { state, sync } = useMessagePanel()
    await sync()
    expect(state.value).toEqual(CLOSED)
  })

  it('opens on a dwarf, naming the mine the panel belongs to', async () => {
    const api = stubApi()
    const { state, openMessage } = useMessagePanel()
    await openMessage('mine:a', 'claude:s1')
    expect(api.setMessagePanel).toHaveBeenCalledWith(OPEN)
    expect(state.value).toEqual(OPEN)
  })

  it('opens the launch surface, which names a mine and no dwarf yet', async () => {
    const api = stubApi()
    const { state, openLaunch } = useMessagePanel()
    await openLaunch('mine:a')
    expect(api.setMessagePanel).toHaveBeenCalledWith({
      surface: 'launch',
      mineId: 'mine:a',
      dwarfId: ''
    })
    expect(state.value.surface).toBe('launch')
  })

  it('closes to nothing, naming neither', async () => {
    const api = stubApi()
    const { state, close, openMessage } = useMessagePanel()
    await openMessage('mine:a', 'claude:s1')
    await close()
    expect(api.setMessagePanel).toHaveBeenLastCalledWith(CLOSED)
    expect(state.value).toEqual(CLOSED)
  })

  it('renders the state main answered, never the one it asked for', async () => {
    // Main creates, moves and hides a real window off this, and the OTHER
    // window may have changed the state between the click and the answer.
    stubApi({ setMessagePanel: vi.fn().mockResolvedValue(CLOSED) })
    const { state, openMessage } = useMessagePanel()
    await openMessage('mine:a', 'claude:s1')
    expect(state.value).toEqual(CLOSED)
  })

  it('re-reads the real state after a failed request rather than assuming either outcome', async () => {
    const getMessagePanel = vi.fn().mockResolvedValue(OPEN)
    stubApi({
      getMessagePanel,
      setMessagePanel: vi.fn().mockRejectedValue(new Error('handler crashed'))
    })
    const { state, close } = useMessagePanel()
    await close()
    expect(getMessagePanel).toHaveBeenCalledOnce()
    expect(state.value).toEqual(OPEN)
  })

  it('serializes requests, so two of them cannot land out of order', async () => {
    // Both windows write this state and each can write it twice in a moment —
    // a dwarf clicked while a launch is handing over. A later answer landing
    // first would leave the window drawn against a state main no longer has.
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const setMessagePanel = vi.fn().mockImplementation((state: { dwarfId: string }) => {
      order.push(`ask:${state.dwarfId}`)
      if (releaseFirst === undefined) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(state)
        })
      }
      return Promise.resolve(state)
    })
    stubApi({ setMessagePanel })
    const { openMessage } = useMessagePanel()
    const first = openMessage('mine:a', 'claude:s1')
    const second = openMessage('mine:a', 'claude:s2')
    // The queue defers to a microtask, so let the first request start.
    await Promise.resolve()
    expect(order).toEqual(['ask:claude:s1'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual(['ask:claude:s1', 'ask:claude:s2'])
  })

  it('hears a state the OTHER window set, and stops listening when told to', () => {
    const stop = vi.fn()
    const api = stubApi({ onMessagePanel: vi.fn().mockReturnValue(stop) })
    const { state, listen } = useMessagePanel()
    const unlisten = listen()
    const push = api.onMessagePanel.mock.calls[0]?.[0] as (state: unknown) => void
    push(OPEN)
    expect(state.value).toEqual(OPEN)
    unlisten()
    expect(stop).toHaveBeenCalledOnce()
  })
})
