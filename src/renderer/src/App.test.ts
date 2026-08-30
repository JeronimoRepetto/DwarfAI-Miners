// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import App from './App.vue'

/**
 * Full window.api stub: App touches the mines surface on mount (load + push
 * subscription) and the pin surface for the titlebar control, so every member
 * must exist even in tests that only look at the titlebar.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    hidePanel: vi.fn(),
    getMines: vi.fn().mockResolvedValue({ mines: [], tokensObserved: 0 }),
    onMinesUpdated: vi.fn().mockReturnValue(() => undefined),
    activateDwarf: vi.fn(),
    sendDwarfText: vi.fn(),
    kickDwarf: vi.fn(),
    getAlwaysOnTop: vi.fn().mockResolvedValue(true),
    setAlwaysOnTop: vi.fn().mockResolvedValue(false),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

async function mountApp(overrides: Record<string, unknown> = {}) {
  const api = stubApi(overrides)
  const wrapper = mount(App)
  await flushPromises()
  return { wrapper, api }
}

describe('App titlebar pin control', () => {
  it('renders the pin button immediately to the left of the close button', async () => {
    const { wrapper } = await mountApp()
    const buttons = wrapper.findAll('.titlebar button')
    expect(buttons.map((button) => button.classes())).toEqual([
      expect.arrayContaining(['pin']),
      expect.arrayContaining(['close'])
    ])
  })

  it('is a real keyboard-reachable button with a stable name, tooltip and pressed state', async () => {
    const { wrapper } = await mountApp()
    const pin = wrapper.find('.titlebar .pin')
    expect(pin.attributes('type')).toBe('button')
    expect(pin.attributes('aria-label')).toBe('Keep panel on top')
    expect(pin.attributes('title')).toBeTruthy()
    expect(pin.attributes('aria-pressed')).toBe('true')
  })

  it('draws the pin as inline pixel art, not text or emoji', async () => {
    const { wrapper } = await mountApp()
    const pin = wrapper.find('.titlebar .pin')
    expect(pin.find('svg').exists()).toBe(true)
    expect(pin.text()).toBe('')
  })

  it('reflects the real state synced from the window on mount', async () => {
    const { wrapper } = await mountApp({
      getAlwaysOnTop: vi.fn().mockResolvedValue(false)
    })
    expect(wrapper.find('.titlebar .pin').attributes('aria-pressed')).toBe('false')
  })

  it('asks main for the opposite state on click and renders the returned verdict', async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue(false)
    const { wrapper } = await mountApp({ setAlwaysOnTop })
    await wrapper.find('.titlebar .pin').trigger('click')
    await flushPromises()
    expect(setAlwaysOnTop).toHaveBeenCalledWith(false)
    expect(wrapper.find('.titlebar .pin').attributes('aria-pressed')).toBe('false')
  })

  it('re-renders the actual window state after a failed toggle', async () => {
    // The toggle wished for "unpinned", but the call failed: the button must
    // show what the BrowserWindow actually is (still pinned), never the wish.
    const { wrapper } = await mountApp({
      setAlwaysOnTop: vi.fn().mockRejectedValue(new Error('handler crashed')),
      getAlwaysOnTop: vi.fn().mockResolvedValue(true)
    })
    await wrapper.find('.titlebar .pin').trigger('click')
    await flushPromises()
    expect(wrapper.find('.titlebar .pin').attributes('aria-pressed')).toBe('true')
  })

  it('keeps the close button working next to the new control', async () => {
    const { wrapper, api } = await mountApp()
    await wrapper.find('.titlebar .close').trigger('click')
    expect(api.hidePanel).toHaveBeenCalledOnce()
  })
})
