// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import MapView from './components/map/MapView.vue'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
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
 *
 * ## Every member that is AWAITED must resolve its real shape
 *
 * A bare `vi.fn()` resolves `undefined`, and the delivery stores read their
 * verdict off the result the moment it lands:
 *
 *     try { result = await window.api.sendDwarfText(...) } catch { ... }
 *     const next = { phase: result.delivered ? ... }   // OUTSIDE the try
 *
 * The `catch` is deliberately only around the await — it means "the panel lost
 * contact with the app", not "whatever came back was garbage" — so an
 * `undefined` result throws one line later, past it. And because App fires
 * these and does not await them (`void sendDwarfText(...)`, so the panel stays
 * usable while a relay takes seconds), the throw becomes an UNHANDLED
 * REJECTION that lands after the test has already passed. Vitest reports it as
 * `Errors 1 error` and exits 1 with every test green; whether the process
 * lives long enough to report it at all is a matter of timing, so it passed
 * locally and went red in CI.
 *
 * So the rule for this stub: anything the app awaits resolves the shape its
 * contract declares, and anything fire-and-forget with no return (`retireDwarf`
 * is `ipcRenderer.send`) is a plain spy. The same discipline
 * MineScene.test.ts's own stub states in as many words.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    hidePanel: vi.fn(),
    // Fire-and-forget, like hidePanel: the shell reports every click on itself
    // so main can raise the window, and there is no verdict to render (#165).
    raisePanel: vi.fn(),
    getMines: vi.fn().mockResolvedValue({ mines: [], tokensObserved: 0 }),
    onMinesUpdated: vi.fn().mockReturnValue(() => undefined),
    // Answers "a window was focused", the verdict that leaves the panel alone.
    activateDwarf: vi.fn().mockResolvedValue({ focused: true, openedTerminal: false, feed: [] }),
    // The message panel reads an observed session's transcript on selection
    // (#159); a readable-but-empty answer is the quiet default.
    getDwarfFeed: vi.fn().mockResolvedValue({ readable: true, messages: [] }),
    sendDwarfText: vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' }),
    kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' }),
    // A promoted kick retires its dwarf through this (#46). Stubbed rather
    // than made optional in the composable: a missing member should fail a
    // test loudly, not be swallowed at every call site.
    retireDwarf: vi.fn(),
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
    // Settings' "Reset metrics" action (#138). Answered as a no-op success by
    // default; only the tests about it care what main actually did.
    resetMetrics: vi.fn().mockResolvedValue({ outcome: 'reset' }),
    // The launch surface (#86). Both are AWAITED, so both resolve their real
    // shape for the reason stated at length above. Claude detected and
    // launchable is the ordinary machine; a launch answers "started", the
    // verdict that says a session began and claims no dwarf.
    listAgentProviders: vi.fn().mockResolvedValue({
      providers: [{ provider: 'claude', installed: true, launchable: true }]
    }),
    launchHeldSession: vi.fn().mockResolvedValue({ launched: true }),
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
    // AMENDED twice now. First (#90): settings used to TOGGLE open and closed
    // from the same control; it is one of five areas, and the way out is
    // selecting another area. Second (#138): the rebuilt Settings screen
    // (SettingsPanel) carries no `role="dialog"` at all — that role belonged
    // to the interim overlay ShortcutSettings drew, and #142 already flagged
    // it as stale for what is now a full-page screen (see
    // ShortcutSettings.test.ts). `.settings-panel` is the screen's own root
    // and is what "settings is open" now means.
    const { wrapper } = await mountOpenApp()
    expect(wrapper.find('.settings-panel').exists()).toBe(false)
    expect(wrapper.find(NAV_SETTINGS).attributes('aria-pressed')).toBe('false')

    await wrapper.find(NAV_SETTINGS).trigger('click')
    expect(wrapper.find('.settings-panel').exists()).toBe(true)
    expect(wrapper.find(NAV_SETTINGS).attributes('aria-pressed')).toBe('true')

    await wrapper.find(NAV_MAP).trigger('click')
    expect(wrapper.find('.settings-panel').exists()).toBe(false)
    expect(wrapper.find(NAV_SETTINGS).attributes('aria-pressed')).toBe('false')
  })

  // REMOVED (#138): Settings drew its own close (x) only as part of the
  // interim overlay ShortcutSettings mounted directly (#142). The rebuilt
  // screen (screens/settings.md) has no close control of its own — like Map
  // and Mines, its title/divider are the whole header, and the way out is
  // selecting another nav area. That coverage now lives in the test just
  // above ("opens the settings panel...", the `NAV_MAP` branch) and in
  // ShortcutSettings.test.ts's "emits close on Escape" — the escape hatch a
  // recording user still has, which this component still exposes.

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
 * The Position section (#138, screens/settings.md): a Left/Right segmented
 * control wired to usePanelLayout.setEdge, which is what actually persists
 * the choice (main writes it to userData, see panelEdgePreference.ts) and
 * redocks the window live.
 */
describe('App position settings', () => {
  async function openSettings(overrides: Record<string, unknown> = {}) {
    const mounted = await mountOpenApp(overrides)
    await mounted.wrapper.find(NAV_SETTINGS).trigger('click')
    return mounted
  }

  it('renders the edge main reported as selected', async () => {
    const { wrapper } = await openSettings({
      getPanelLayout: vi.fn().mockResolvedValue({ edge: 'left', expanded: true, mineOpen: false })
    })
    expect(wrapper.find('.position-left').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.position-right').attributes('aria-pressed')).toBe('false')
  })

  it('asks main to redock when the other side is chosen', async () => {
    const setPanelLayout = vi
      .fn()
      .mockResolvedValue({ edge: 'left', expanded: true, mineOpen: false })
    const { wrapper } = await openSettings({ setPanelLayout })

    await wrapper.find('.position-left').trigger('click')
    await flushPromises()

    expect(setPanelLayout).toHaveBeenCalledWith({ expanded: true, mineOpen: false, edge: 'left' })
    expect(wrapper.find('.position-left').attributes('aria-pressed')).toBe('true')
  })

  it('renders the edge main actually applied, never the one clicked', async () => {
    // Same honesty rule the rest of the layout surface follows: a display
    // that could not honor the move must reach the renderer as a fact.
    const setPanelLayout = vi
      .fn()
      .mockResolvedValue({ edge: 'right', expanded: true, mineOpen: false })
    const { wrapper } = await openSettings({ setPanelLayout })

    await wrapper.find('.position-left').trigger('click')
    await flushPromises()

    expect(wrapper.find('.position-right').attributes('aria-pressed')).toBe('true')
  })
})

/**
 * Settings' "Reset metrics" action (#138): the Data Base section opens the
 * typed confirmation modal, and Confirm only reaches main once the gate
 * (isValidResetConfirmation) is satisfied.
 */
describe('App reset metrics', () => {
  async function openSettings(overrides: Record<string, unknown> = {}) {
    const mounted = await mountOpenApp(overrides)
    await mounted.wrapper.find(NAV_SETTINGS).trigger('click')
    return mounted
  }

  it('opens the modal from Data Base and confirms only once "yes" is typed', async () => {
    const resetMetrics = vi.fn().mockResolvedValue({ outcome: 'reset' })
    const { wrapper } = await openSettings({ resetMetrics })

    await wrapper.find('.reset-metrics').trigger('click')
    expect(wrapper.find('.modal-confirm').attributes('disabled')).toBeDefined()

    await wrapper.find('.modal-input').setValue('yes')
    expect(wrapper.find('.modal-confirm').attributes('disabled')).toBeUndefined()

    await wrapper.find('.modal-confirm').trigger('click')
    await flushPromises()
    expect(resetMetrics).toHaveBeenCalledOnce()
  })

  it('shows main’s refusal reason without closing the modal', async () => {
    const resetMetrics = vi
      .fn()
      .mockResolvedValue({ outcome: 'failed', reason: 'Nothing was deleted.' })
    const { wrapper } = await openSettings({ resetMetrics })

    await wrapper.find('.reset-metrics').trigger('click')
    await wrapper.find('.modal-input').setValue('yes')
    await wrapper.find('.modal-confirm').trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toBe('Nothing was deleted.')
    expect(wrapper.find('.reset-modal').exists()).toBe(true)
  })

  it('closes the modal from its own close control without asking main anything', async () => {
    const resetMetrics = vi.fn()
    const { wrapper } = await openSettings({ resetMetrics })

    await wrapper.find('.reset-metrics').trigger('click')
    await wrapper.find('.modal-close').trigger('click')

    expect(wrapper.find('.reset-modal').exists()).toBe(false)
    expect(resetMetrics).not.toHaveBeenCalled()
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
    // AMENDED twice now. First (#90): this used to count the titlebar's four
    // window controls; what survives is the rule it protected. Second (#138):
    // the pin/hide/version group moved from App's inline `.shell-preferences`
    // into SettingsPanel's own "Application" section, `.application-controls`
    // — the version is still a monitor, not an affordance, and must not be
    // drawn as something clickable among the two real buttons it sits with.
    const { wrapper } = await openSettings()
    expect(wrapper.find('.version').element.tagName).toBe('SPAN')
    expect(wrapper.find('.application-controls').findAll('button')).toHaveLength(2)
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

  /**
   * Mount, open the panel, walk into the asking mine, and select that dwarf —
   * which is what opens the MessagePanel its question card now lives in (#159).
   */
  async function openAskingDwarf(overrides: Record<string, unknown> = {}) {
    const { wrapper, api } = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({ mines: [ASKING_MINE], tokensObserved: 0 }),
      ...overrides
    })
    wrapper.findComponent(MapView).vm.$emit('open', ASKING_MINE.id)
    await flushPromises()
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()
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

  it('collapses back to the rail when there is no mine to keep', async () => {
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

  /*
   * #153's fifth correction: three controls, three different jobs. The rail's
   * arrow used to collapse the whole shell, the app mark was inert, and the
   * interior's round close already worked. What the maintainer ruled is that the
   * arrow closes only the secondary panel, the mark takes the whole shell back
   * into the rail, and the close is untouched.
   */
  it('closes only the secondary panel from the rail’s arrow, keeping the mine', async () => {
    const { wrapper, api } = await openMine()
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    expect(api.setPanelLayout).toHaveBeenLastCalledWith({ expanded: false, mineOpen: true })
    expect(wrapper.find('.map-view').exists()).toBe(false)
    expect(wrapper.find('.mine-scene').exists()).toBe(true)
    // The navigation stack stays: it is how the panel comes back.
    expect(wrapper.find('.shell-nav').exists()).toBe(true)
  })

  /*
   * #156's first correction, and the reason the shell now says which of the
   * BOOK's compositions it is in rather than reading `expanded` alone.
   *
   * Closing the left page beside an open mine left the shell classified as the
   * bare rail: no amber ground, no padding, no radius and no shadow, so a void
   * opened where the navigation column stood, the interior grew into the eight
   * pixels of padding that were no longer there, and the mine's frame vanished.
   */
  it('keeps the shell’s own frame when only the mine is left', async () => {
    const { wrapper } = await openMine()
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    const shell = wrapper.find('.shell')
    expect(shell.classes()).toContain('is-mine')
    expect(shell.classes()).not.toContain('is-rail')
  })

  it('is the bare rail only when neither page is drawn', async () => {
    const { wrapper } = await openMine()
    expect(wrapper.find('.shell').classes()).toContain('is-pages')
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    await wrapper.find('.close-mine').trigger('click')
    await flushPromises()
    expect(wrapper.find('.shell').classes()).toContain('is-rail')
  })

  /*
   * The second app icon the acceptance run found floating in that void: the rail
   * drew the mark whenever the secondary panel was closed, and the navigation
   * stack drew its own whenever the stack was on screen. Both were true at once
   * in the mine-only composition.
   */
  it('draws the app mark exactly once, in every composition', async () => {
    const { wrapper } = await openMine()
    const marks = (): number => wrapper.findAll('.rail-mark, .nav-mark-art').length
    expect(marks()).toBe(1)
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    expect(marks()).toBe(1)
    await wrapper.find('.close-mine').trigger('click')
    await flushPromises()
    expect(marks()).toBe(1)
  })

  /*
   * AMENDED for #156's second correction. Both cases were written for #153's
   * ruling, where the app mark collapsed the whole shell into the rail. The
   * maintainer's ruling now is that it HIDES the window — the same action the
   * global shortcut takes — and the layout is left exactly as it stands, so
   * whatever was drawn is what comes back. Each case kept its subject: what the
   * mark does, and what it must not forget.
   */
  it('hides the whole window from the app mark, mine and all', async () => {
    const { wrapper, api } = await openMine()
    const beforeMark = api.setPanelLayout.mock.calls.length
    await wrapper.find('.nav-mark').trigger('click')
    await flushPromises()
    expect(api.hidePanel).toHaveBeenCalledOnce()
    // The window went away; the panel it will come back as did not change.
    expect(api.setPanelLayout.mock.calls.length).toBe(beforeMark)
  })

  it('leaves the mine and the page standing, because hiding forgets nothing', async () => {
    const { wrapper } = await openMine()
    await wrapper.find('.nav-mark').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mine-scene').exists()).toBe(true)
    expect(wrapper.find('.map-view').exists()).toBe(true)
    expect(wrapper.find('.shell-nav').exists()).toBe(true)
  })

  it('lands on the rail when the last mine closes with the panel already closed', async () => {
    const { wrapper, api } = await openMine()
    await wrapper.find('.edge-rail').trigger('click')
    await flushPromises()
    await wrapper.find('.close-mine').trigger('click')
    await flushPromises()
    expect(api.setPanelLayout).toHaveBeenLastCalledWith({ expanded: false, mineOpen: false })
    expect(wrapper.find('.mine-scene').exists()).toBe(false)
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

/**
 * The MessagePanel, wired end to end (#159): selecting a dwarf inside a mine
 * opens the design's bottom-docked panel, and the mine stays exactly where it
 * was — the source is explicit that a selected dwarf is not paused and its
 * mine stays visible.
 */
describe('App message panel', () => {
  const OBSERVED_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'Halfway down the shaft'
  }

  const HELD_DWARF = {
    ...OBSERVED_DWARF,
    id: 'claude:s2',
    sessionId: 's2',
    name: 'Held',
    conversation: [{ role: 'user', text: 'dig here', timestamp: 'then' }]
  }

  const MINE = {
    id: 'mine:c:\\x\\anvil',
    path: 'C:\\x\\anvil',
    name: 'anvil',
    tier: 'bronze',
    dwarfs: [OBSERVED_DWARF],
    tokensObserved: 0,
    updatedAt: 0
  }

  beforeEach(() => {
    useView().clear()
    // Both delivery stores are module-scope singletons that hold a verdict for
    // a minute while they watch for a reaction, so a test that sent or kicked
    // would leave its marker sitting in the next test's panel.
    useDwarfMessaging().clearAll()
    useDwarfKicking().clearAll()
  })

  async function openMineWith(dwarfs: unknown[], overrides: Record<string, unknown> = {}) {
    const { wrapper, api } = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({ mines: [{ ...MINE, dwarfs }], tokensObserved: 0 }),
      ...overrides
    })
    wrapper.findComponent(MapView).vm.$emit('open', MINE.id)
    await flushPromises()
    return { wrapper, api }
  }

  it('opens the panel on the dwarf that was clicked, and leaves the mine standing', async () => {
    const { wrapper } = await openMineWith([OBSERVED_DWARF])
    expect(wrapper.find('.message-panel').exists()).toBe(false)

    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    expect(wrapper.find('.message-panel').exists()).toBe(true)
    expect(wrapper.find('.panel-agent').text()).toBe('Foreman')
    // The mine is still drawn, and its crew still in it.
    expect(wrapper.find('.mine-scene .interior').exists()).toBe(true)
    expect(wrapper.find('.dwarf-sprite').classes()).toContain('is-selected')
  })

  it('closes the panel from its own close control', async () => {
    const { wrapper } = await openMineWith([OBSERVED_DWARF])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    await wrapper.find('.panel-close').trigger('click')
    expect(wrapper.find('.message-panel').exists()).toBe(false)
    expect(wrapper.find('.dwarf-sprite').classes()).not.toContain('is-selected')
  })

  it('closes it again when the same dwarf is clicked a second time', async () => {
    const { wrapper } = await openMineWith([OBSERVED_DWARF])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it("reads an observed session's transcript, and shows what came back", async () => {
    const { wrapper, api } = await openMineWith([OBSERVED_DWARF], {
      getDwarfFeed: vi.fn().mockResolvedValue({
        readable: true,
        messages: [{ role: 'assistant', text: 'Blasting the last metre', timestamp: 'now' }]
      })
    })
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledWith('claude:s1')
    expect(wrapper.find('.bubble').text()).toBe('Blasting the last metre')
    expect(wrapper.find('.panel-note').text()).toContain('Latest activity')
  })

  it('never reads a transcript for a session it is holding: it has the words first-hand', async () => {
    const { wrapper, api } = await openMineWith([HELD_DWARF])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    expect(api.getDwarfFeed).not.toHaveBeenCalled()
    expect(wrapper.find('.bubble').text()).toBe('dig here')
    expect(wrapper.find('.panel-note').text()).toContain('holding this session')
  })

  it('sends what was typed over the ordinary message channel', async () => {
    const { wrapper, api } = await openMineWith([{ ...OBSERVED_DWARF, textDelivery: 'terminal' }])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.sendDwarfText).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      text: 'dig deeper',
      pressEnter: true
    })
    // The verdict has to LAND, not just be asked for. Asserting it is what
    // makes a stub that resolves the wrong shape fail this test outright,
    // instead of rejecting into the void after it has already passed: the send
    // is fire-and-forget, so nothing else in the app would ever notice.
    expect(wrapper.find('.panel-status').text()).toContain('Handed over via terminal')
  })

  it('kicks through the panel, and the verdict lands where it was asked for', async () => {
    const { wrapper, api } = await openMineWith([
      {
        ...OBSERVED_DWARF,
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      }
    ])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    // Arm, then fire — the confirmation the old action bar carried.
    await wrapper.find('.control-kick').trigger('click')
    await wrapper.find('.control-kick').trigger('click')
    await flushPromises()

    expect(api.kickDwarf).toHaveBeenCalledWith({ dwarfId: 'claude:s1' })
    // Handed over, never "reacted": only a session SEEN stopping earns that.
    expect(wrapper.find('.panel-status').text()).toContain('Kick handed over via terminal')
    expect(wrapper.find('.panel-status').text()).not.toContain('the session reacted')
  })

  /*
   * AMENDED (#192). This used to assert the panel DROPPED when its dwarf left
   * the board, which threw the conversation away — final reply included — at
   * the one moment a person is most likely to be reading it. The panel now
   * stays on the dwarf as the board last reported it, says the session has
   * ended, and waits to be closed by hand. What the test protected survives:
   * main still owns which dwarfs exist, and the panel still follows the
   * snapshot — it just no longer forgets the last one it was given.
   */
  it('keeps the panel on the last known dwarf when it walks out of the mine, and says so', async () => {
    const { wrapper, api } = await openMineWith([{ ...OBSERVED_DWARF, textDelivery: 'terminal' }], {
      getDwarfFeed: vi.fn().mockResolvedValue({
        readable: true,
        messages: [{ role: 'assistant', text: 'Blasting the last metre', timestamp: 'now' }]
      })
    })
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeUndefined()

    const push = api.onMinesUpdated.mock.calls[0]![0] as (snapshot: unknown) => void
    push({ mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()

    expect(wrapper.find('.message-panel').exists()).toBe(true)
    expect(wrapper.find('.panel-agent').text()).toBe('Foreman')
    expect(wrapper.find('.bubble').text()).toBe('Blasting the last metre')
    // Ended is said in words, and typing into a session that is gone is
    // refused with the same words rather than handed to main to refuse.
    expect(wrapper.find('.panel-note').text()).toContain('ended')
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.panel-input').attributes('title')).toContain('ended')
  })

  it("leaves closing an ended session's panel to the person", async () => {
    const { wrapper, api } = await openMineWith([OBSERVED_DWARF])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    const push = api.onMinesUpdated.mock.calls[0]![0] as (snapshot: unknown) => void
    push({ mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()
    expect(wrapper.find('.message-panel').exists()).toBe(true)

    await wrapper.find('.panel-close').trigger('click')
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it('still lets go of the panel with the mine it was opened in', async () => {
    // The panel outlives its dwarf, not its mine: closing the mine is the
    // person's own act, and a conversation docked to nothing has no place.
    const { wrapper } = await openMineWith([OBSERVED_DWARF])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    await wrapper.find('.close-mine').trigger('click')
    await flushPromises()

    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })
})

/**
 * The feed for an observed dwarf used to refresh only when `lastMessage`
 * changed — the assistant's own last text — so a human turn typed into the
 * terminal, or sent from this panel, sat invisible until the agent next spoke
 * (#183). Two remedies, smallest first: re-read on the panel's OWN successful
 * send, and watch a second signal — `transcriptUpdatedAt`, the transcript's
 * raw mtime — that moves for any writer, not only the assistant.
 */
describe('App feed refresh (#183)', () => {
  const REFRESH_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'Halfway down the shaft',
    textDelivery: 'terminal'
  }

  const HELD_REFRESH_DWARF = {
    ...REFRESH_DWARF,
    id: 'claude:s2',
    sessionId: 's2',
    conversation: [{ role: 'user', text: 'dig here', timestamp: 'then' }]
  }

  const MINE = {
    id: 'mine:c:\\x\\anvil',
    path: 'C:\\x\\anvil',
    name: 'anvil',
    tier: 'bronze',
    dwarfs: [REFRESH_DWARF],
    tokensObserved: 0,
    updatedAt: 0
  }

  beforeEach(() => {
    useView().clear()
    useDwarfMessaging().clearAll()
  })

  async function openRefreshDwarf(overrides: Record<string, unknown> = {}) {
    const { wrapper, api } = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 }),
      ...overrides
    })
    wrapper.findComponent(MapView).vm.$emit('open', MINE.id)
    await flushPromises()
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()
    return { wrapper, api }
  }

  async function sendFromPanel(wrapper: VueWrapper, text: string) {
    await wrapper.find('.panel-input').setValue(text)
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }

  it("re-reads the feed once the panel's own send lands, without waiting for the agent to reply", async () => {
    const { wrapper, api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.sendDwarfText).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      text: 'dig deeper',
      pressEnter: true
    })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(api.getDwarfFeed).toHaveBeenLastCalledWith('claude:s1')
  })

  it('does not re-read a failed delivery: nothing proves the tail moved', async () => {
    const { wrapper, api } = await openRefreshDwarf({
      sendDwarfText: vi.fn().mockResolvedValue({
        delivered: false,
        via: 'terminal',
        error: 'The terminal would not come forward.'
      })
    })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
  })

  it('never reads a transcript for a session it is holding, even from its own send', async () => {
    // Held sessions carry their exchange first-hand on `conversation`; a
    // delivered send must not open a second, second-hand channel for it.
    const { wrapper, api } = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({
        mines: [{ ...MINE, dwarfs: [HELD_REFRESH_DWARF] }],
        tokensObserved: 0
      })
    })
    wrapper.findComponent(MapView).vm.$emit('open', MINE.id)
    await flushPromises()
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()
    expect(api.getDwarfFeed).not.toHaveBeenCalled()

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.getDwarfFeed).not.toHaveBeenCalled()
  })

  it('drops a delivered send’s refresh once the panel is no longer open on that dwarf', async () => {
    // The relay can take seconds; the user is free to close the panel, or pick
    // another dwarf, before it answers. A stale delivery must not fetch a feed
    // nobody is looking at any more.
    let resolveSend: (value: { delivered: boolean; via: string }) => void = () => {}
    const sendDwarfText = vi.fn(
      () =>
        new Promise<{ delivered: boolean; via: string }>((resolve) => {
          resolveSend = resolve
        })
    )
    const { wrapper, api } = await openRefreshDwarf({ sendDwarfText })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    await wrapper.find('.panel-close').trigger('click')
    resolveSend({ delivered: true, via: 'terminal' })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the transcript-movement signal changes, even when lastMessage does not', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    const push = api.onMinesUpdated.mock.calls[0]![0] as (snapshot: unknown) => void
    push({
      mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
  })

  it('stays put on an ordinary poll where neither signal moved', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    const push = api.onMinesUpdated.mock.calls[0]![0] as (snapshot: unknown) => void
    push({ mines: [MINE], tokensObserved: 0 })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
  })

  /*
   * #192: the assistant's final reply and the session's end can land inside
   * one poll, so the snapshot that first shows the dwarf leaving is the first
   * that can read that reply — and the last: once the grace window drops the
   * dwarf, main no longer answers for it, and a read then would replace the
   * words with "no transcript". One more read, at the leaving edge, never after.
   */
  it('re-reads once when the dwarf turns leaving, and not again once the board drops it', async () => {
    const getDwarfFeed = vi
      .fn()
      .mockResolvedValueOnce({
        readable: true,
        messages: [{ role: 'assistant', text: 'Halfway down the shaft', timestamp: 't1' }]
      })
      .mockResolvedValue({
        readable: true,
        messages: [{ role: 'assistant', text: 'Seam exhausted, packing up.', timestamp: 't2' }]
      })
    const { wrapper, api } = await openRefreshDwarf({ getDwarfFeed })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    const push = api.onMinesUpdated.mock.calls[0]![0] as (snapshot: unknown) => void
    push({
      mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, status: 'leaving' }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.bubble').text()).toBe('Seam exhausted, packing up.')

    push({ mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.bubble').text()).toBe('Seam exhausted, packing up.')
  })
})

/**
 * The Add Panel, wired end to end (#86): the mine's Add action opens it in the
 * MessagePanel's own dock, submitting starts a held session in that mine's
 * folder, and the panel hands over to the MessagePanel when the dwarf it
 * started turns up on an ordinary poll.
 */
describe('App add panel', () => {
  const MINE = {
    id: 'mine:c:\\x\\anvil',
    path: 'C:\\x\\anvil',
    name: 'anvil',
    tier: 'bronze',
    dwarfs: [],
    tokensObserved: 0,
    updatedAt: 0
  }

  const OTHER_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'Halfway down the shaft'
  }

  /** The dwarf a launch of `prompt` leaves behind: held, and seeded with it. */
  function launchedDwarf(prompt: string) {
    return {
      id: 'claude:s9',
      provider: 'claude',
      role: 'foreman',
      name: 'Newcomer',
      status: 'working',
      sessionId: 's9',
      conversation: [{ role: 'user', text: prompt, timestamp: 'then' }]
    }
  }

  beforeEach(() => {
    useView().clear()
    // Module-scope singleton, exactly as the view and the delivery stores are:
    // a test that opened the panel would leave it open in the next one.
    useAgentLaunch().close()
  })

  async function openMineWith(dwarfs: unknown[], overrides: Record<string, unknown> = {}) {
    const { wrapper, api } = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({ mines: [{ ...MINE, dwarfs }], tokensObserved: 0 }),
      ...overrides
    })
    wrapper.findComponent(MapView).vm.$emit('open', MINE.id)
    await flushPromises()
    return { wrapper, api }
  }

  async function openAddPanel(overrides: Record<string, unknown> = {}) {
    const mounted = await openMineWith([], overrides)
    await mounted.wrapper.find('.add-agent').trigger('click')
    await flushPromises()
    return mounted
  }

  async function submitPrompt(wrapper: VueWrapper, prompt: string) {
    await wrapper.findAll('.provider-chip')[0]!.trigger('click')
    await wrapper.find('.launch-input').setValue(prompt)
    await wrapper.find('.launch-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }

  function pushSnapshot(api: Record<string, ReturnType<typeof vi.fn>>, dwarfs: unknown[]) {
    const push = api.onMinesUpdated!.mock.calls[0]![0] as (snapshot: unknown) => void
    push({ mines: [{ ...MINE, dwarfs }], tokensObserved: 0 })
  }

  it('opens the Add Panel from the mine own action, mine still standing', async () => {
    const { wrapper } = await openMineWith([])
    expect(wrapper.find('.add-panel').exists()).toBe(false)

    await wrapper.find('.add-agent').trigger('click')
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.mine-scene .interior').exists()).toBe(true)
  })

  it('asks main which providers this machine has when it opens', async () => {
    const { api, wrapper } = await openAddPanel()

    expect(api.listAgentProviders).toHaveBeenCalled()
    expect(wrapper.findAll('.provider-chip').map((chip) => chip.text())).toEqual([
      'claude',
      'Other'
    ])
  })

  /*
   * The design docks both panels in the same slot — the transition is one
   * replacing the other — so they cannot both be there. Opening either closes
   * the other rather than stacking two surfaces in one place.
   */
  it('takes the dock from an open MessagePanel', async () => {
    const { wrapper } = await openMineWith([OTHER_DWARF])
    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()
    expect(wrapper.find('.message-panel').exists()).toBe(true)

    await wrapper.find('.add-agent').trigger('click')
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it('gives the dock back when a dwarf is selected instead', async () => {
    const { wrapper } = await openMineWith([OTHER_DWARF])
    await wrapper.find('.add-agent').trigger('click')
    await flushPromises()

    await wrapper.find('.dwarf-hit').trigger('click')
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(false)
    expect(wrapper.find('.message-panel').exists()).toBe(true)
  })

  it('closes from its own close control', async () => {
    const { wrapper } = await openAddPanel()

    await wrapper.find('.launch-close').trigger('click')

    expect(wrapper.find('.add-panel').exists()).toBe(false)
  })

  it('starts a held session in the mine it was opened from', async () => {
    const { wrapper, api } = await openAddPanel()

    await submitPrompt(wrapper, 'dig the east gallery')

    expect(api.launchHeldSession).toHaveBeenCalledWith({
      mineId: MINE.id,
      provider: 'claude',
      prompt: 'dig the east gallery'
    })
  })

  /*
   * The verdict says a session STARTED and claims no dwarf, so the panel
   * acknowledges from the verdict and waits — it must not look like nothing
   * happened for the two seconds before the poll finds the session.
   */
  it('acknowledges the launch and keeps the prompt on screen while it spawns', async () => {
    const { wrapper } = await openAddPanel()

    await submitPrompt(wrapper, 'dig the east gallery')

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.launch-first-message').text()).toBe('dig the east gallery')
  })

  it('hands the dock to the MessagePanel when the launched dwarf arrives', async () => {
    const { wrapper, api } = await openAddPanel()
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, [launchedDwarf('dig the east gallery')])
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(false)
    expect(wrapper.find('.message-panel').exists()).toBe(true)
    expect(wrapper.find('.panel-agent').text()).toBe('Newcomer')
  })

  /*
   * The reconciliation. The held registry seeds the new session's conversation
   * with the prompt this panel sent, so the MessagePanel already draws it —
   * prepending a second copy here would show the user's own first words twice,
   * and the copy that survives is main's record rather than this panel's
   * optimism about it.
   */
  it('shows the first message exactly once after the transition', async () => {
    const { wrapper, api } = await openAddPanel()
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, [launchedDwarf('dig the east gallery')])
    await flushPromises()

    const said = wrapper
      .findAll('.message .bubble')
      .filter((bubble) => bubble.text() === 'dig the east gallery')
    expect(said).toHaveLength(1)
  })

  it('keeps waiting while only an unrelated session turns up', async () => {
    const { wrapper, api } = await openAddPanel()
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, [OTHER_DWARF])
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it('stays open with main own reason when the launch is refused', async () => {
    const { wrapper } = await openAddPanel({
      launchHeldSession: vi
        .fn()
        .mockResolvedValue({ launched: false, error: 'Claude Code is not installed.' })
    })

    await submitPrompt(wrapper, 'dig the east gallery')

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.launch-alert').text()).toBe('Claude Code is not installed.')
  })
})

/**
 * The third acceptance run's sixth correction (#165).
 *
 * With another program focused, clicking the panel left it BEHIND that program
 * — alive, visible, receiving the click, and never raised. The platform's own
 * click-to-front does not reliably apply to a frameless transparent window, so
 * the shell reports the click and main raises the window itself.
 *
 * The rule is any click, pinned or not: pinning decides whether the panel STAYS
 * above other windows, not whether a click may bring it there.
 */
describe('App raise on click (#165)', () => {
  it('asks main to raise the window when the shell is pressed', async () => {
    const { wrapper, api } = await mountOpenApp()

    await wrapper.find('.shell').trigger('pointerdown')

    expect(api.raisePanel).toHaveBeenCalledOnce()
  })

  it('raises on a press ANYWHERE in the shell, not only on empty ground', async () => {
    // The capture phase is what makes this true of every control on the panel:
    // a button that stops propagation must not also stop the window rising.
    const { wrapper, api } = await mountOpenApp()

    await wrapper.find(NAV_MINES).trigger('pointerdown')

    expect(api.raisePanel).toHaveBeenCalledOnce()
  })

  it('raises while unpinned, which is the state the panel was found behind in', async () => {
    const { wrapper, api } = await mountOpenApp({
      getAlwaysOnTop: vi.fn().mockResolvedValue(false)
    })

    await wrapper.find('.shell').trigger('pointerdown')

    expect(api.raisePanel).toHaveBeenCalledOnce()
  })

  it('raises on the rail too, which is all there is to click when collapsed', async () => {
    const { wrapper, api } = await mountApp()

    await wrapper.find('.shell').trigger('pointerdown')

    expect(api.raisePanel).toHaveBeenCalledOnce()
  })
})

/**
 * The third acceptance run's seventh correction (#165).
 *
 * More than one dwarf could be selected at once, and since a click opens the
 * message panel, that implied more than one panel. These pin the whole rule
 * where the user meets it: exactly one selected sprite, exactly one panel, and
 * selecting B clears A in one move.
 */
describe('App exclusive selection (#165)', () => {
  const ONE = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'One',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'first'
  }
  const TWO = { ...ONE, id: 'claude:s2', sessionId: 's2', name: 'Two', lastMessage: 'second' }

  const MINE = {
    id: 'mine:c:\\x\\anvil',
    path: 'C:\\x\\anvil',
    name: 'anvil',
    tier: 'bronze',
    dwarfs: [ONE, TWO],
    tokensObserved: 0,
    updatedAt: 0
  }

  beforeEach(() => {
    useView().clear()
    useDwarfMessaging().clearAll()
    useDwarfKicking().clearAll()
  })

  async function openCrewedMine() {
    const { wrapper } = await mountOpenApp({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    wrapper.findComponent(MapView).vm.$emit('open', MINE.id)
    await flushPromises()
    return wrapper
  }

  /** Every sprite currently wearing the selection halo. */
  function selectedSprites(wrapper: VueWrapper) {
    return wrapper
      .findAll('.dwarf-sprite')
      .filter((sprite) => sprite.classes().includes('is-selected'))
  }

  /**
   * The hit target of the dwarf with this name, by its accessible name.
   *
   * Never by DOM index: the scene paints its crew back to front, so the order
   * the sprites appear in is a depth ordering and has nothing to do with the
   * order the board listed them.
   */
  function hitFor(wrapper: VueWrapper, name: string) {
    const hit = wrapper
      .findAll('.dwarf-hit')
      .find((candidate) => candidate.attributes('aria-label')?.startsWith(`Select ${name} `))
    if (hit === undefined) throw new Error(`no dwarf named ${name} is on the floor`)
    return hit
  }

  it('selects exactly one dwarf, and opens exactly one panel', async () => {
    const wrapper = await openCrewedMine()

    await hitFor(wrapper, 'One').trigger('click')
    await flushPromises()

    expect(selectedSprites(wrapper)).toHaveLength(1)
    expect(wrapper.findAll('.message-panel')).toHaveLength(1)
  })

  it('clears the first dwarf when the second is selected, in one move', async () => {
    const wrapper = await openCrewedMine()

    await hitFor(wrapper, 'One').trigger('click')
    await flushPromises()
    await hitFor(wrapper, 'Two').trigger('click')
    await flushPromises()

    const selected = selectedSprites(wrapper)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.text()).toContain('Two')
    expect(wrapper.findAll('.message-panel')).toHaveLength(1)
    expect(wrapper.get('.message-panel').text()).toContain('second')
  })

  it('leaves nobody selected and no panel open once the last one is closed', async () => {
    const wrapper = await openCrewedMine()

    await hitFor(wrapper, 'One').trigger('click')
    await flushPromises()
    await hitFor(wrapper, 'Two').trigger('click')
    await flushPromises()
    await wrapper.find('.panel-close').trigger('click')
    await flushPromises()

    expect(selectedSprites(wrapper)).toHaveLength(0)
    expect(wrapper.findAll('.message-panel')).toHaveLength(0)
  })
})
