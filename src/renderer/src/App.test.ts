// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import MapView from './components/map/MapView.vue'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useView } from './composables/useView'

const DEFAULT_SHORTCUT = {
  accelerator: 'Control+Alt+Shift+P',
  registered: true,
  platform: 'win32'
}

/**
 * Deliberately not this repo's real version (#79): the panel must print what
 * main reported, so a stub that happened to match package.json could not tell
 * a working read from a value baked in somewhere else.
 */
const DEFAULT_BUILD = { version: '1.2.3', packaged: true }

/** The docked shell as main reports it once expanded (#90). */
const OPEN_LAYOUT = { edge: 'right', expanded: true, mineOpen: false }

/*
 * Selectors for the redesigned shell (#90). The old titlebar and its four
 * window controls are gone; every entry point they carried moved, and these
 * name where it moved to. They are constants rather than literals because the
 * same three appear in nearly every test below.
 */
const NAV = '.shell-nav .nav-button'
const NAV_SETTINGS = `${NAV}[aria-label="Settings"]`
const NAV_MAP = `${NAV}[aria-label="Map"]`
const NAV_MINES = `${NAV}[aria-label="Mines"]`

/**
 * Full window.api stub: App touches the mines surface on mount (load + push
 * subscription), the panel-layout surface for the docked window, the pin
 * surface, the shortcut surface for the settings panel, the build surface for
 * the version and the answer surface for a dwarf's pending question, so every
 * member must exist even in tests that only look at the rail.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    hidePanel: vi.fn(),
    getMines: vi.fn().mockResolvedValue({ mines: [], tokensObserved: 0 }),
    onMinesUpdated: vi.fn().mockReturnValue(() => undefined),
    activateDwarf: vi.fn(),
    sendDwarfText: vi.fn(),
    kickDwarf: vi.fn(),
    answerDwarfQuestion: vi.fn().mockResolvedValue({ answered: true }),
    getAlwaysOnTop: vi.fn().mockResolvedValue(true),
    setAlwaysOnTop: vi.fn().mockResolvedValue(false),
    // The docked shell (#90). Answers "closed" by default, which is what main
    // actually creates the window as; mountOpenApp expands it.
    getPanelLayout: vi.fn().mockResolvedValue({ edge: 'right', expanded: false, mineOpen: false }),
    setPanelLayout: vi
      .fn()
      .mockImplementation((request: { expanded: boolean; mineOpen: boolean }) =>
        Promise.resolve({ edge: 'right', ...request })
      ),
    getToggleShortcut: vi.fn().mockResolvedValue(DEFAULT_SHORTCUT),
    setToggleShortcut: vi.fn().mockResolvedValue(DEFAULT_SHORTCUT),
    getAppBuild: vi.fn().mockResolvedValue(DEFAULT_BUILD),
    // The browse surface (#92). Answered empty by default: only the tests that
    // are about the Mines panel care what comes back.
    queryProjects: vi.fn().mockResolvedValue({ answered: true, projects: [] }),
    // Adopting a folder (#85). Answers "cancelled" by default, the one verdict
    // that changes nothing, so only the tests about it see any effect.
    declareMine: vi.fn().mockResolvedValue({ outcome: 'cancelled' }),
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

/**
 * Mount and open the panel, which is what almost every test below needs: the
 * app now STARTS as a 20px rail with nothing else drawn, so a test that mounts
 * and immediately looks for a screen finds an empty shell.
 */
async function mountOpenApp(overrides: Record<string, unknown> = {}) {
  const mounted = await mountApp({
    getPanelLayout: vi.fn().mockResolvedValue(OPEN_LAYOUT),
    ...overrides
  })
  await flushPromises()
  return mounted
}

/*
 * useView is a module-scope singleton, and since #90 it holds the AREA as well
 * as the open mine — so a test that visits settings leaves the next one already
 * there, looking for a map that is not drawn. Two blocks below already reset it
 * for the mine they enter; this makes the reset universal, because every
 * navigation now leaks and not only the ones that walk into a mine.
 */
beforeEach(() => useView().clear())

/*
 * The pin (#35) outlived the titlebar that carried it (#90).
 *
 * The design gives it no home of its own, so it moved into the settings panel,
 * beside the shortcut it sits next to conceptually — a stored preference among
 * the other stored preferences, rather than furniture on a 20px rail. Every
 * test here kept its subject and changed where it looks.
 */
describe('App pin control', () => {
  async function openSettings(overrides: Record<string, unknown> = {}) {
    const mounted = await mountOpenApp(overrides)
    await mounted.wrapper.find(NAV_SETTINGS).trigger('click')
    return mounted
  }

  it('lives in the settings panel, not on a rail with no room for it', async () => {
    // REMOVED with the titlebar: the assertion that the pin sat immediately
    // left of a close button in a row of four window controls. There is no such
    // row — the browse and settings entry points moved to the navigation stack
    // (covered below), and the window has no close control at all (see the
    // activation test at the end of this block).
    const { wrapper } = await mountOpenApp()
    expect(wrapper.find('.pin').exists()).toBe(false)
    await wrapper.find(NAV_SETTINGS).trigger('click')
    expect(wrapper.find('.pin').exists()).toBe(true)
  })

  it('is a real keyboard-reachable button with a stable name, tooltip and pressed state', async () => {
    const { wrapper } = await openSettings()
    const pin = wrapper.find('.pin')
    expect(pin.attributes('type')).toBe('button')
    expect(pin.attributes('aria-label')).toBe('Keep panel on top')
    expect(pin.attributes('title')).toBeTruthy()
    expect(pin.attributes('aria-pressed')).toBe('true')
  })

  it('says what it is in words, now that it is a settings control', async () => {
    // REMOVED: the assertion that the pin was drawn as inline pixel art with no
    // text. It was a 16px glyph in a titlebar with no room for a label; in a
    // settings panel a labelled control is the honest form, and the pressed
    // state still carries the meaning.
    const { wrapper } = await openSettings()
    expect(wrapper.find('.pin').text()).toBe('Always on top')
  })

  it('reflects the real state synced from the window on mount', async () => {
    const { wrapper } = await openSettings({
      getAlwaysOnTop: vi.fn().mockResolvedValue(false)
    })
    expect(wrapper.find('.pin').attributes('aria-pressed')).toBe('false')
  })

  it('asks main for the opposite state on click and renders the returned verdict', async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue(false)
    const { wrapper } = await openSettings({ setAlwaysOnTop })
    await wrapper.find('.pin').trigger('click')
    await flushPromises()
    expect(setAlwaysOnTop).toHaveBeenCalledWith(false)
    expect(wrapper.find('.pin').attributes('aria-pressed')).toBe('false')
  })

  it('re-renders the actual window state after a failed toggle', async () => {
    // The toggle wished for "unpinned", but the call failed: the button must
    // show what the BrowserWindow actually is (still pinned), never the wish.
    const { wrapper } = await openSettings({
      setAlwaysOnTop: vi.fn().mockRejectedValue(new Error('handler crashed')),
      getAlwaysOnTop: vi.fn().mockResolvedValue(true)
    })
    await wrapper.find('.pin').trigger('click')
    await flushPromises()
    expect(wrapper.find('.pin').attributes('aria-pressed')).toBe('true')
  })

  it('keeps a way to hide the panel entirely, beside the pin', async () => {
    // AMENDED: this was the titlebar's close button. The design has no
    // window-close control — the panel's way out of the user's way is
    // collapsing to the rail — and `shouldHidePanelAfterActivation` returns
    // false for every activation, so that button was the renderer's ONLY
    // caller of hidePanel. Dropping it would have removed the capability
    // rather than relocated it, so it moved here with the pin. Hiding also
    // remains on the tray and the global shortcut, both in main.
    const { wrapper, api } = await openSettings()
    await wrapper.find('.hide-panel').trigger('click')
    expect(api.hidePanel).toHaveBeenCalledOnce()
  })
})

/*
 * The settings entry point (#17) moved from the titlebar's gear to the
 * navigation stack's Settings button (#90) — where the design puts it, first in
 * the stack. Settings is now an AREA rather than an overlay, so it is selected
 * rather than toggled, and the state it carries is `aria-pressed` rather than
 * `aria-expanded`.
 */
describe('App settings entry point', () => {
  it('is a real keyboard-reachable button drawn from the design’s own icon', async () => {
    // AMENDED: the old assertion looked for an inline <svg> of hand-drawn pixel
    // art. The redesign's icons are the designer's SVG files, drawn through a
    // CSS mask so idle and selected take their colour from the tokens — so what
    // is checked is that a real icon is bound, not that it is inlined.
    const { wrapper } = await mountOpenApp()
    const gear = wrapper.find(NAV_SETTINGS)
    expect(gear.attributes('type')).toBe('button')
    expect(gear.attributes('aria-label')).toBe('Settings')
    expect(gear.attributes('title')).toBeTruthy()
    expect(gear.find('.nav-icon').attributes('style')).toMatch(/--nav-icon:\s*url\(/)
    expect(gear.text()).toBe('')
  })

  it('opens the settings panel, reporting the state on the button', async () => {
    // AMENDED: settings used to TOGGLE open and closed from the same control.
    // It is one of five areas now, and the way out is selecting another area —
    // pressing Settings again would be asking for the screen you are on.
    const { wrapper } = await mountOpenApp()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find(NAV_SETTINGS).attributes('aria-pressed')).toBe('false')

    await wrapper.find(NAV_SETTINGS).trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.find(NAV_SETTINGS).attributes('aria-pressed')).toBe('true')

    await wrapper.find(NAV_MAP).trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find(NAV_SETTINGS).attributes('aria-pressed')).toBe('false')
  })

  it('leaves the panel from its own close button', async () => {
    const { wrapper } = await mountOpenApp()
    await wrapper.find(NAV_SETTINGS).trigger('click')
    await wrapper.find('.close-settings').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('flags a shortcut that failed to register, without the panel being open', async () => {
    // The whole point of #17: a startup failure used to reach only the console.
    const { wrapper } = await mountOpenApp({
      getToggleShortcut: vi.fn().mockResolvedValue({
        accelerator: 'Control+Alt+Shift+P',
        registered: false,
        platform: 'win32',
        error: 'Ctrl + Alt + Shift + P is already in use by another application.'
      })
    })
    const gear = wrapper.find(NAV_SETTINGS)
    expect(gear.classes()).toContain('is-broken')
    expect(gear.attributes('title')).toMatch(/unavailable/i)
  })

  it('does not flag the gear when the shortcut is working', async () => {
    const { wrapper } = await mountOpenApp()
    expect(wrapper.find(NAV_SETTINGS).classes()).not.toContain('is-broken')
  })
})

describe('App shortcut settings', () => {
  async function openSettings(overrides: Record<string, unknown> = {}) {
    const mounted = await mountOpenApp(overrides)
    await mounted.wrapper.find(NAV_SETTINGS).trigger('click')
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

  it('stops listening when the panel is left mid-recording', async () => {
    // Otherwise the next visit would silently be capturing keystrokes. Leaving
    // is now selecting another area rather than toggling the gear.
    const { wrapper } = await openSettings()
    await wrapper.find('.recorder').trigger('click')
    await wrapper.find(NAV_MAP).trigger('click')
    await wrapper.find(NAV_SETTINGS).trigger('click')
    expect(wrapper.find('.recorder').attributes('aria-pressed')).toBe('false')
  })
})

/**
 * Which build is running (#79). The panel could not say, so a maintainer with
 * an installed 0.3.0 and a dev build of the same checkout diagnosed the wrong
 * one and had to read ProductVersion off the .exe from a shell.
 *
 * It sat beside the titlebar's app name until #90 removed the titlebar. The
 * design gives it no home either, so it moved to the settings panel with the
 * pin — where a reader looks for a build number, and where it is out of a
 * 20px rail that has room for one 19px icon.
 */
describe('App version label', () => {
  async function openSettings(overrides: Record<string, unknown> = {}) {
    const mounted = await mountOpenApp(overrides)
    await mounted.wrapper.find(NAV_SETTINGS).trigger('click')
    return mounted
  }

  it('prints the version main reported, in the settings panel', async () => {
    const { wrapper } = await openSettings({
      getAppBuild: vi.fn().mockResolvedValue({ version: '0.4.1', packaged: true })
    })
    expect(wrapper.find('.version').text()).toBe('0.4.1')
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
    const { wrapper } = await openSettings({
      getAppBuild: vi.fn().mockResolvedValue({ version: '0.3.0', packaged: false })
    })
    expect(wrapper.find('.version').text()).toBe('0.3.0-dev')
  })

  it('says which of the two builds it is in the hover line', async () => {
    const { wrapper } = await openSettings({
      getAppBuild: vi.fn().mockResolvedValue({ version: '0.3.0', packaged: false })
    })
    expect(wrapper.find('.version').attributes('title')).toMatch(/checkout/i)
  })

  it('stays a label rather than joining the controls beside it', async () => {
    // AMENDED: this used to count the titlebar's four window controls. There is
    // no titlebar; what survives is the rule it protected — the version is a
    // monitor, not an affordance, and must not be drawn as something clickable
    // among the settings controls it now sits with.
    const { wrapper } = await openSettings()
    expect(wrapper.find('.version').element.tagName).toBe('SPAN')
    expect(wrapper.find('.shell-preferences').findAll('button')).toHaveLength(2)
  })

  it('prints nothing at all when main cannot be asked', async () => {
    // An honest blank beats "unknown" furniture: a failed read means the
    // bridge is down, and inventing a placeholder version is the one thing
    // this feature exists to stop.
    const { wrapper } = await openSettings({
      getAppBuild: vi.fn().mockRejectedValue(new Error('bridge unavailable'))
    })
    expect(wrapper.find('.version').exists()).toBe(false)
    // The rest of the settings panel is untouched by the failure.
    expect(wrapper.find('.pin').exists()).toBe(true)
  })
})

/**
 * The whole answer loop through the real components (#125): a question reaches
 * the panel on a snapshot, an option is chosen inside the mine, and Enter
 * releases the agent's blocked ask over the bridge.
 */
describe('App answering an agent question', () => {
  const PENDING_QUESTION = {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }]
  }

  const ASKING_MINE = {
    id: 'mine:c:\\x\\importer',
    path: 'C:\\x\\importer',
    name: 'importer',
    tier: 'bronze',
    dwarfs: [
      {
        id: 'claude:s1',
        provider: 'claude',
        role: 'foreman',
        name: 'Foreman',
        status: 'waiting',
        sessionId: 's1',
        pendingQuestion: PENDING_QUESTION
      }
    ],
    tokensObserved: 0,
    updatedAt: 0
  }

  beforeEach(() => {
    // Both stores are module-scope singletons, so a test that walked into a
    // mine would leave the next one already there, with no map to click.
    useDwarfQuestion().clearAll()
    useView().clear()
  })

  /** Mount, open the panel, walk into the asking mine, and open that dwarf's action bar. */
  async function openAskingDwarf(overrides: Record<string, unknown> = {}) {
    const { wrapper, api } = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({ mines: [ASKING_MINE], tokensObserved: 0 }),
      ...overrides
    })
    wrapper.findComponent(MapView).vm.$emit('open', ASKING_MINE.id)
    await flushPromises()
    await wrapper.find('.dwarf-hit').trigger('click')
    return { wrapper, api }
  }

  it('answers the ask with the agent’s own words, over the answer channel', async () => {
    const { wrapper, api } = await openAskingDwarf()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.answerDwarfQuestion).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which database should the importer write to?': 'SQLite' }
    })
    // Free text is a different channel; answering must not have used it.
    expect(api.sendDwarfText).not.toHaveBeenCalled()
  })

  it('leaves the question standing after the answer was released', async () => {
    // Only main's next snapshot may drop a pendingQuestion. Clearing it here
    // would claim the ask was closed on the panel's own say-so.
    const { wrapper } = await openAskingDwarf()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.find('.question-card .question-text').text()).toBe(
      'Which database should the importer write to?'
    )
    expect(wrapper.find('.answer-ok').exists()).toBe(true)
  })

  it('shows main’s reason when the answer was refused', async () => {
    const { wrapper } = await openAskingDwarf({
      answerDwarfQuestion: vi.fn().mockResolvedValue({
        answered: false,
        error: 'That session is not one this panel is holding.'
      })
    })
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.find('.answer-error').text()).toBe(
      'That session is not one this panel is holding.'
    )
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
    // AMENDED: the accessible name was "Browse mines" on a titlebar button. It
    // is "Mines" now, because the design names the navigation buttons and this
    // is the name it gives this one.
    const { wrapper } = await mountOpenApp()
    const mines = wrapper.find(NAV_MINES)
    expect(mines.attributes('type')).toBe('button')
    expect(mines.attributes('aria-label')).toBe('Mines')
    expect(mines.attributes('aria-pressed')).toBe('false')
  })

  it('draws the entry point from the design’s own icon, not text or emoji', async () => {
    const { wrapper } = await mountOpenApp()
    const mines = wrapper.find(NAV_MINES)
    expect(mines.find('.nav-icon').attributes('style')).toMatch(/--nav-icon:\s*url\(/)
    expect(mines.text()).toBe('')
  })

  it('shows the map until the browse is asked for', async () => {
    const { wrapper } = await mountOpenApp()
    expect(wrapper.find('.mines-panel').exists()).toBe(false)
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('opens the browse and reads its first page', async () => {
    const { wrapper, api } = await mountOpenApp()
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    expect(wrapper.find('.mines-panel').exists()).toBe(true)
    expect(wrapper.find('.map-view').exists()).toBe(false)
    expect(api.queryProjects).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'addedAt', direction: 'desc', offset: 0 })
    )
  })

  it('returns to the map from the Map button', async () => {
    // AMENDED: the titlebar entry point was a TOGGLE, and pressing it again was
    // the only way back. The navigation stack has a Map button of its own, so
    // asking for Mines while already on Mines is asking for the screen you are
    // looking at — the way back is the area you want.
    const { wrapper } = await mountOpenApp()
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    expect(wrapper.find(NAV_MINES).attributes('aria-pressed')).toBe('true')
    await wrapper.find(NAV_MINES).trigger('click')
    expect(wrapper.find('.mines-panel').exists()).toBe(true)
    await wrapper.find(NAV_MAP).trigger('click')
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('renders a card for every project that was answered', async () => {
    const { wrapper } = await mountOpenApp({
      queryProjects: vi.fn().mockResolvedValue({
        answered: true,
        projects: [
          { id: 'a', path: 'a', name: 'Lalolanda', declared: false, addedAt: 1, live: false },
          { id: 'b', path: 'b', name: 'Lalo-Test', declared: true, addedAt: 2, live: false }
        ]
      })
    })
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.mine-card')).toHaveLength(2)
  })

  it('sends the typed term straight through to main', async () => {
    const { wrapper, api } = await mountOpenApp()
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    await wrapper.find('.search-field').setValue('lalo')
    await flushPromises()
    expect(api.queryProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ nameContains: 'lalo', offset: 0 })
    )
  })

  it('enters the mine a live card names', async () => {
    const { wrapper } = await mountOpenApp({
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
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    await wrapper.find('.mine-card button').trigger('click')
    expect(wrapper.find('.mine-scene').exists()).toBe(true)
  })

  it('asks main for a folder when the add control is pressed', async () => {
    const { wrapper, api } = await mountOpenApp()
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    await wrapper.find('.add-control').trigger('click')
    await flushPromises()
    expect(api.declareMine).toHaveBeenCalledWith()
  })

  it('shows the adopted project without the panel being reopened', async () => {
    const queryProjects = vi
      .fn()
      .mockResolvedValueOnce({ answered: true, projects: [] })
      .mockResolvedValueOnce({
        answered: true,
        projects: [
          {
            id: 'C:/dev/alpha',
            path: 'C:/dev/alpha',
            name: 'alpha',
            declared: true,
            addedAt: 1,
            live: true
          }
        ]
      })
    const { wrapper } = await mountOpenApp({
      queryProjects,
      declareMine: vi.fn().mockResolvedValue({ outcome: 'added', mineId: 'C:/dev/alpha' })
    })
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.mine-card')).toHaveLength(0)
    await wrapper.find('.add-control').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.mine-card')).toHaveLength(1)
  })

  it('says nothing at all when the picker was closed without a choice', async () => {
    const { wrapper } = await mountOpenApp()
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    await wrapper.find('.add-control').trigger('click')
    await flushPromises()
    expect(wrapper.find('.add-error').exists()).toBe(false)
    // Still the invitation to add one, not a complaint about the last attempt.
    expect(wrapper.get('.panel-empty').text()).toContain('Nothing here')
  })

  it('states why a folder could not be added', async () => {
    const { wrapper } = await mountOpenApp({
      declareMine: vi.fn().mockResolvedValue({
        outcome: 'failed',
        reason: 'That folder could not be saved as a mine.'
      })
    })
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    await wrapper.find('.add-control').trigger('click')
    await flushPromises()
    expect(wrapper.get('.add-error').text()).toBe('That folder could not be saved as a mine.')
  })

  it('reports a refused browse as a failure, never as an empty list', async () => {
    const { wrapper } = await mountOpenApp({
      queryProjects: vi
        .fn()
        .mockResolvedValue({ answered: false, projects: [], reason: 'The database is locked.' })
    })
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    expect(wrapper.find('.panel-empty').exists()).toBe(false)
    expect(wrapper.find('.panel-error').text()).toBe('The database is locked.')
  })
})

/*
 * The docked shell itself (#90): a 20px rail that opens into the panel, and
 * closes back into it. The window is main's, so every one of these renders the
 * layout main answered with rather than the one the click asked for.
 */
describe('App shell', () => {
  it('starts as the rail, with no screen drawn behind it', async () => {
    const { wrapper } = await mountApp()
    expect(wrapper.find('.edge-rail').exists()).toBe(true)
    expect(wrapper.find('.shell-nav').exists()).toBe(false)
    expect(wrapper.find('.map-view').exists()).toBe(false)
  })

  it('adopts the layout main reports rather than assuming one', async () => {
    const { wrapper, api } = await mountApp({
      getPanelLayout: vi.fn().mockResolvedValue({ edge: 'left', expanded: true, mineOpen: false })
    })
    expect(api.getPanelLayout).toHaveBeenCalledOnce()
    expect(wrapper.find('.shell').classes()).toContain('edge-left')
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('asks main to open, and draws the map it answered with', async () => {
    const { wrapper, api } = await mountApp()
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    expect(api.setPanelLayout).toHaveBeenCalledWith({ expanded: true, mineOpen: false })
    expect(wrapper.find('.map-view').exists()).toBe(true)
    expect(wrapper.find('.shell-nav').exists()).toBe(true)
  })

  it('stays closed when main refuses to open it', async () => {
    // The window is derived from the display; the rail must never paint itself
    // open against a window that did not move.
    const { wrapper } = await mountApp({
      setPanelLayout: vi.fn().mockResolvedValue({ edge: 'right', expanded: false, mineOpen: false })
    })
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    expect(wrapper.find('.map-view').exists()).toBe(false)
    expect(wrapper.find('.edge-rail').attributes('aria-expanded')).toBe('false')
  })

  it('collapses back to the rail', async () => {
    const { wrapper, api } = await mountOpenApp()
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    expect(api.setPanelLayout).toHaveBeenLastCalledWith({ expanded: false, mineOpen: false })
    expect(wrapper.find('.shell-nav').exists()).toBe(false)
  })

  it('shows the Lab and the Market as the design specifies them: unavailable', async () => {
    const { wrapper } = await mountOpenApp()
    await wrapper.find(`${NAV}[aria-label="Lab"]`).trigger('click')
    expect(wrapper.find('.unavailable').text()).toContain('rebuild the lab')
    await wrapper.find(`${NAV}[aria-label="Market"]`).trigger('click')
    expect(wrapper.find('.unavailable').text()).toContain('rebuild the market')
  })
})

/*
 * One mine beside one secondary panel — the concurrent model the design's
 * exports prove, and the reason the mine column is a second thing the WINDOW
 * has to be given room for.
 */
describe('App concurrent mine', () => {
  const LIVE_MINE = {
    id: 'C:/dev/alpha',
    path: 'C:/dev/alpha',
    name: 'alpha',
    tier: 'bronze',
    dwarfs: [],
    tokensObserved: 0,
    updatedAt: 0
  }

  async function openMine(overrides: Record<string, unknown> = {}) {
    const mounted = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({ mines: [LIVE_MINE], tokensObserved: 0 }),
      ...overrides
    })
    mounted.wrapper.findComponent(MapView).vm.$emit('open', LIVE_MINE.id)
    await flushPromises()
    return mounted
  }

  it('keeps the map behind the mine it was entered from', async () => {
    const { wrapper } = await openMine()
    expect(wrapper.find('.mine-scene').exists()).toBe(true)
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('asks main for the mine column, because it is width the window has to have', async () => {
    const { api } = await openMine()
    expect(api.setPanelLayout).toHaveBeenLastCalledWith({ expanded: true, mineOpen: true })
  })

  it('switches the secondary panel without closing the mine', async () => {
    const { wrapper } = await openMine()
    await wrapper.find(NAV_MINES).trigger('click')
    await flushPromises()
    expect(wrapper.find('.mines-panel').exists()).toBe(true)
    expect(wrapper.find('.mine-scene').exists()).toBe(true)
  })

  it('closes the mine from the design’s round close, leaving the panel behind it', async () => {
    const { wrapper } = await openMine()
    await wrapper.find('.close-mine').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mine-scene').exists()).toBe(false)
    expect(wrapper.find('.map-view').exists()).toBe(true)
  })

  it('gives the window its column back when the mine closes', async () => {
    const { wrapper, api } = await openMine()
    await wrapper.find('.close-mine').trigger('click')
    await flushPromises()
    expect(api.setPanelLayout).toHaveBeenLastCalledWith({ expanded: true, mineOpen: false })
  })

  it('lets go of the mine when it leaves the board', async () => {
    const { wrapper, api } = await openMine()
    // Main's next snapshot no longer carries it: the panel must not keep a
    // column open onto a mine that is gone.
    const push = api.onMinesUpdated.mock.calls[0]![0] as (snapshot: unknown) => void
    push({ mines: [], tokensObserved: 0 })
    await flushPromises()
    expect(wrapper.find('.mine-scene').exists()).toBe(false)
  })
})
