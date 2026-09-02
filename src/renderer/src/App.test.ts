// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import { useView } from './composables/useView'

const DEFAULT_SHORTCUT = {
  accelerator: 'Control+Alt+Shift+P',
  registered: true,
  platform: 'win32'
}

/**
 * Deliberately not this repo's real version (#79): the titlebar must print
 * what main reported, so a stub that happened to match package.json could not
 * tell a working read from a value baked in somewhere else.
 */
const DEFAULT_BUILD = { version: '1.2.3', packaged: true }

/**
 * Full window.api stub: App touches the mines surface on mount (load + push
 * subscription), the pin surface for the titlebar control, the shortcut
 * surface for the settings panel and the build surface for the version beside
 * the title, so every member must exist even in tests that only look at the
 * titlebar.
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
    getToggleShortcut: vi.fn().mockResolvedValue(DEFAULT_SHORTCUT),
    setToggleShortcut: vi.fn().mockResolvedValue(DEFAULT_SHORTCUT),
    getAppBuild: vi.fn().mockResolvedValue(DEFAULT_BUILD),
    // The browse surface (#92). Answered empty by default: only the tests that
    // are about the Mines panel care what comes back.
    queryProjects: vi.fn().mockResolvedValue({ answered: true, projects: [] }),
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
      // The browse entry point joined the row on the far side of the gear
      // (#92); the pin still sits immediately left of close.
      expect.arrayContaining(['mines']),
      expect.arrayContaining(['settings']),
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

describe('App settings entry point', () => {
  it('is a real keyboard-reachable button drawn as pixel art, not text or emoji', async () => {
    const { wrapper } = await mountApp()
    const gear = wrapper.find('.titlebar .settings')
    expect(gear.attributes('type')).toBe('button')
    expect(gear.attributes('aria-label')).toBe('Settings')
    expect(gear.attributes('title')).toBeTruthy()
    expect(gear.find('svg').exists()).toBe(true)
    expect(gear.text()).toBe('')
  })

  it('opens and closes the settings panel, reporting the state on the gear', async () => {
    const { wrapper } = await mountApp()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.titlebar .settings').attributes('aria-expanded')).toBe('false')

    await wrapper.find('.titlebar .settings').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.find('.titlebar .settings').attributes('aria-expanded')).toBe('true')

    await wrapper.find('.titlebar .settings').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('closes the panel from its own close button', async () => {
    const { wrapper } = await mountApp()
    await wrapper.find('.titlebar .settings').trigger('click')
    await wrapper.find('.close-settings').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('flags a shortcut that failed to register, without the panel being open', async () => {
    // The whole point of #17: a startup failure used to reach only the console.
    const { wrapper } = await mountApp({
      getToggleShortcut: vi.fn().mockResolvedValue({
        accelerator: 'Control+Alt+Shift+P',
        registered: false,
        platform: 'win32',
        error: 'Ctrl + Alt + Shift + P is already in use by another application.'
      })
    })
    const gear = wrapper.find('.titlebar .settings')
    expect(gear.classes()).toContain('is-broken')
    expect(gear.attributes('title')).toMatch(/unavailable/i)
  })

  it('does not flag the gear when the shortcut is working', async () => {
    const { wrapper } = await mountApp()
    expect(wrapper.find('.titlebar .settings').classes()).not.toContain('is-broken')
  })
})

describe('App shortcut settings', () => {
  async function openSettings(overrides: Record<string, unknown> = {}) {
    const mounted = await mountApp(overrides)
    await mounted.wrapper.find('.titlebar .settings').trigger('click')
    return mounted
  }

  it('shows the real shortcut read from main on mount', async () => {
    const { wrapper } = await openSettings({
      getToggleShortcut: vi
        .fn()
        .mockResolvedValue({ accelerator: 'Control+Alt+M', registered: true, platform: 'win32' })
    })
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + M')
  })

  it('records a combination and renders the accelerator main confirmed', async () => {
    const setToggleShortcut = vi
      .fn()
      .mockResolvedValue({ accelerator: 'Control+Alt+M', registered: true, platform: 'win32' })
    const { wrapper } = await openSettings({ setToggleShortcut })

    await wrapper.find('.recorder').trigger('click')
    expect(wrapper.find('.recorder').attributes('aria-pressed')).toBe('true')
    await wrapper.find('.recorder').trigger('keydown', {
      key: 'm',
      code: 'KeyM',
      ctrlKey: true,
      altKey: true
    })
    await flushPromises()

    expect(setToggleShortcut).toHaveBeenCalledWith('Control+Alt+M')
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + M')
    expect(wrapper.find('.recorder').attributes('aria-pressed')).toBe('false')
  })

  it('renders the combination that was KEPT after a refusal, plus the reason', async () => {
    // Main reverted to the previous accelerator; showing the requested one
    // would claim a shortcut that is bound to nothing.
    const setToggleShortcut = vi.fn().mockResolvedValue({
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      platform: 'win32',
      error:
        'Ctrl + Alt + M is already in use by another application. Still using Ctrl + Alt + Shift + P.'
    })
    const { wrapper } = await openSettings({ setToggleShortcut })

    await wrapper.find('.recorder').trigger('click')
    await wrapper.find('.recorder').trigger('keydown', {
      key: 'm',
      code: 'KeyM',
      ctrlKey: true,
      altKey: true
    })
    await flushPromises()

    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + Shift + P')
    expect(wrapper.find('[role="alert"]').text()).toMatch(/already in use/i)
  })

  it('refuses a combination with no modifier without bothering main', async () => {
    const setToggleShortcut = vi.fn()
    const { wrapper } = await openSettings({ setToggleShortcut })
    await wrapper.find('.recorder').trigger('click')
    await wrapper.find('.recorder').trigger('keydown', { key: 'p', code: 'KeyP' })
    await flushPromises()
    expect(setToggleShortcut).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').text()).toMatch(/modifier/i)
  })

  it('asks main for the documented default when reset', async () => {
    const setToggleShortcut = vi.fn().mockResolvedValue({
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      platform: 'win32'
    })
    const { wrapper } = await openSettings({
      getToggleShortcut: vi
        .fn()
        .mockResolvedValue({ accelerator: 'Control+Alt+M', registered: true, platform: 'win32' }),
      setToggleShortcut
    })
    await wrapper.find('.reset').trigger('click')
    await flushPromises()
    expect(setToggleShortcut).toHaveBeenCalledWith('Control+Alt+Shift+P')
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + Shift + P')
  })

  it('stops listening when the panel is closed mid-recording', async () => {
    // Otherwise the next open would silently be capturing keystrokes.
    const { wrapper } = await openSettings()
    await wrapper.find('.recorder').trigger('click')
    await wrapper.find('.titlebar .settings').trigger('click')
    await wrapper.find('.titlebar .settings').trigger('click')
    expect(wrapper.find('.recorder').attributes('aria-pressed')).toBe('false')
  })
})

/**
 * Which build is running (#79). The panel could not say, so a maintainer with
 * an installed 0.3.0 and a dev build of the same checkout diagnosed the wrong
 * one and had to read ProductVersion off the .exe from a shell.
 */
describe('App titlebar version', () => {
  it('prints the version main reported, beside the title', async () => {
    const { wrapper } = await mountApp({
      getAppBuild: vi.fn().mockResolvedValue({ version: '0.4.1', packaged: true })
    })
    expect(wrapper.find('.titlebar .title .version').text()).toBe('0.4.1')
  })

  it('asks main once on mount rather than deriving it in the renderer', async () => {
    // Context isolation is on and node integration is off: there is no
    // package.json to read here and no process.env to consult, so a version
    // that did NOT come over the bridge came from somewhere it cannot be
    // trusted from.
    const getAppBuild = vi.fn().mockResolvedValue(DEFAULT_BUILD)
    await mountApp({ getAppBuild })
    expect(getAppBuild).toHaveBeenCalledOnce()
    expect(getAppBuild).toHaveBeenCalledWith()
  })

  it('marks a development build so it cannot be read as the installed one', async () => {
    const { wrapper } = await mountApp({
      getAppBuild: vi.fn().mockResolvedValue({ version: '0.3.0', packaged: false })
    })
    expect(wrapper.find('.titlebar .version').text()).toBe('0.3.0-dev')
  })

  it('says which of the two builds it is in the hover line', async () => {
    const { wrapper } = await mountApp({
      getAppBuild: vi.fn().mockResolvedValue({ version: '0.3.0', packaged: false })
    })
    expect(wrapper.find('.titlebar .version').attributes('title')).toMatch(/checkout/i)
  })

  it('stays out of the window controls, which are all still buttons', async () => {
    // The version is a label, not an affordance: putting it among the pin,
    // gear and close controls would make a monitor look clickable and would
    // put it inside the no-drag region for no reason.
    const { wrapper } = await mountApp()
    expect(wrapper.find('.window-controls .version').exists()).toBe(false)
    // Four since #92 added the browse entry point: mines, gear, pin, close.
    expect(wrapper.findAll('.titlebar button')).toHaveLength(4)
  })

  it('prints nothing at all when main cannot be asked', async () => {
    // An honest blank beats "unknown" furniture: a failed read means the
    // bridge is down, and inventing a placeholder version is the one thing
    // this feature exists to stop.
    const { wrapper } = await mountApp({
      getAppBuild: vi.fn().mockRejectedValue(new Error('bridge unavailable'))
    })
    expect(wrapper.find('.titlebar .version').exists()).toBe(false)
    // The rest of the titlebar is untouched by the failure.
    expect(wrapper.find('.titlebar .title').text()).toContain('DwarfAI-Miners')
  })
})

/*
 * The browse over every project the app remembers (#92). App owns the
 * composable, and therefore the IPC, so MinesPanel stays presentational — the
 * same split the settings surface uses.
 */
describe('App mines browse', () => {
  // useView is a module singleton, so a test that navigates leaves the next one
  // wherever it stopped. Only this block navigates; the reset stays with it.
  beforeEach(() => useView().clear())
  afterEach(() => useView().clear())

  it('is a real keyboard-reachable button with a stable name and pressed state', async () => {
    const { wrapper } = await mountApp()
    const mines = wrapper.find('.titlebar .mines')
    expect(mines.attributes('type')).toBe('button')
    expect(mines.attributes('aria-label')).toBe('Browse mines')
    expect(mines.attributes('aria-pressed')).toBe('false')
  })

  it('draws the entry point as inline pixel art, not text or emoji', async () => {
    const { wrapper } = await mountApp()
    const mines = wrapper.find('.titlebar .mines')
    expect(mines.find('svg').exists()).toBe(true)
    expect(mines.text()).toBe('')
  })

  it('shows the map until the browse is asked for', async () => {
    const { wrapper } = await mountApp()
    expect(wrapper.find('.mines-panel').exists()).toBe(false)
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('opens the browse and reads its first page', async () => {
    const { wrapper, api } = await mountApp()
    await wrapper.find('.titlebar .mines').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mines-panel').exists()).toBe(true)
    expect(wrapper.find('.map-view').exists()).toBe(false)
    expect(api.queryProjects).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'addedAt', direction: 'desc', offset: 0 })
    )
  })

  it('returns to the map when the entry point is pressed again', async () => {
    const { wrapper } = await mountApp()
    await wrapper.find('.titlebar .mines').trigger('click')
    await flushPromises()
    expect(wrapper.find('.titlebar .mines').attributes('aria-pressed')).toBe('true')
    await wrapper.find('.titlebar .mines').trigger('click')
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('renders a card for every project that was answered', async () => {
    const { wrapper } = await mountApp({
      queryProjects: vi.fn().mockResolvedValue({
        answered: true,
        projects: [
          { id: 'a', path: 'a', name: 'Lalolanda', declared: false, addedAt: 1, live: false },
          { id: 'b', path: 'b', name: 'Lalo-Test', declared: true, addedAt: 2, live: false }
        ]
      })
    })
    await wrapper.find('.titlebar .mines').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.mine-card')).toHaveLength(2)
  })

  it('sends the typed term straight through to main', async () => {
    const { wrapper, api } = await mountApp()
    await wrapper.find('.titlebar .mines').trigger('click')
    await flushPromises()
    await wrapper.find('.search-field').setValue('lalo')
    await flushPromises()
    expect(api.queryProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ nameContains: 'lalo', offset: 0 })
    )
  })

  it('enters the mine a live card names', async () => {
    const { wrapper } = await mountApp({
      getMines: vi.fn().mockResolvedValue({
        mines: [
          {
            id: 'C:/dev/alpha',
            path: 'C:/dev/alpha',
            name: 'alpha',
            tier: 'bronze',
            dwarfs: [],
            tokensObserved: 0,
            updatedAt: 0
          }
        ],
        tokensObserved: 0
      }),
      queryProjects: vi.fn().mockResolvedValue({
        answered: true,
        projects: [
          {
            id: 'C:/dev/alpha',
            path: 'C:/dev/alpha',
            name: 'alpha',
            declared: false,
            addedAt: 1,
            live: true
          }
        ]
      })
    })
    await wrapper.find('.titlebar .mines').trigger('click')
    await flushPromises()
    await wrapper.find('.mine-card button').trigger('click')
    expect(wrapper.find('.mine-scene').exists()).toBe(true)
  })

  it('reports a refused browse as a failure, never as an empty list', async () => {
    const { wrapper } = await mountApp({
      queryProjects: vi
        .fn()
        .mockResolvedValue({ answered: false, projects: [], reason: 'The database is locked.' })
    })
    await wrapper.find('.titlebar .mines').trigger('click')
    await flushPromises()
    expect(wrapper.find('.panel-empty').exists()).toBe(false)
    expect(wrapper.find('.panel-error').text()).toBe('The database is locked.')
  })
})
