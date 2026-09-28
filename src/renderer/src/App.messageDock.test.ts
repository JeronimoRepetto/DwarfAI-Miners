// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import MapPage from './components/map/MapPage.vue'
import MineColumn from './components/scene/MineColumn.vue'
import DwarfMessagePanel from './components/message/DwarfMessagePanel.vue'
import MenuButton from './components/overlay/MenuButton.vue'
import ModalDialog from './components/overlay/ModalDialog.vue'
import { MENU_STOP } from './lib/message/panelChrome'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfPaging } from './composables/useDwarfPaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMines } from './composables/useMines'
import { useView } from './composables/useView'
import {
  BEYOND_REACH_NOTE,
  CONVERSATION_START_NOTE,
  NO_OLDER_PAGES_NOTE
} from './lib/message/feedPages'
import {
  DEFAULT_AUDIO_PREFERENCES,
  DEFAULT_JEV_SETTINGS,
  DEFAULT_TYPOGRAPHY_PREFERENCES
} from './types'

/*
 * The MessagePanel and the Add panel, docked in the shell's window slot (#635).
 *
 * MOVED HERE, whole and by subject, from MessagePanelWindow.test.ts, which the child window took
 * with it: these were App.test.ts's own blocks until #162 made the two panels a second
 * BrowserWindow, and they come back to the shell now that the decision log anchors both panels in
 * the Panel and the PO chose one OS window for it (2026-09-27). In a file of their own rather than
 * back inside App.test.ts because they are one subject — the dock's panels — and App.test.ts is
 * already the longest file in the renderer.
 *
 * What changed in each is the OPENING GESTURE and nothing else, as it was the gesture that changed
 * for #162: the shell no longer asks main for a surface, so `openOn` below mounts the real App,
 * opens the mine and clicks the dwarf, and every assertion about what the panel then shows,
 * reads, sends and refuses is the one that was already there. The blocks that could only be true
 * of a second window went with it, each said where it stood.
 *
 * Five suites went WHOLE with the modules they tested, which served only that window, and are
 * said here because their files are gone: lib/shell/surface.test.ts (which root a page mounts:
 * there is one), composables/useMessagePanel.test.ts (the surface main held for both windows,
 * serialized: the surface is useMessageDock's own, asserted through the dock in this file and in
 * App.test.ts's 'App message dock (#635)'), composables/useDwarfDelivery.test.ts (the verdicts
 * published back to the shell: 'handing the delivery verdicts to the mine' below reads what the
 * mine is handed), lib/message/surfaceMotion.test.ts (the second window's enter, leave or cut:
 * the dock slot's motion, App.test.ts's 'App panel motion (#164)' and dockMotion.test.ts) and
 * lib/shell/windowDrag.test.ts (the header as a window-drag handle: the header does not drag,
 * decision log, MessagePanel and Add panel anchored).
 */

const CLOSED = { surface: 'none' as const, mineId: '', dwarfId: '' }

/**
 * Full window.api stub for the shell, on the rule App.test.ts states at length: anything the app
 * AWAITS resolves the shape its contract declares, and anything fire-and-forget is a plain spy.
 *
 * A bare `vi.fn()` resolves `undefined`, and both delivery stores read their verdict off the result
 * the moment it lands — outside the `catch`, which means "the panel lost contact with the app"
 * rather than "what came back was garbage". Since the send is fired without being awaited, the
 * throw one line later becomes an unhandled rejection that lands after the test has already
 * passed: `Errors 1 error`, exit 1, every test green.
 *
 * AMENDED for #635 (was: the panel window's own members, with `getMessagePanel`,
 * `setMessagePanel`, `onMessagePanel`, `setMessagePanelHeight`, `reportMessagePanelSettled` and
 * `reportDwarfDelivery`, none of which exists any more). The shell's own members join the panel's
 * because it is the shell that is mounted now.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    hidePanel: vi.fn(),
    raisePanel: vi.fn(),
    // The mine the panels open in, crewless: a test about a dwarf names its own crew.
    getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 }),
    onMinesUpdated: vi.fn().mockReturnValue(() => undefined),
    // The launch-failure push (#263), subscribed unconditionally on mount.
    onLaunchFailed: vi.fn().mockReturnValue(() => undefined),
    // Answers "a window was focused", the verdict that leaves the panel alone.
    activateDwarf: vi.fn().mockResolvedValue({ focused: true, openedTerminal: false, feed: [] }),
    // An observed session's transcript, read on selection (#159): readable and empty.
    getDwarfFeed: vi.fn().mockResolvedValue({ readable: true, messages: [] }),
    // One page of scrollback (#364): readable, with nothing older.
    getDwarfFeedPage: vi
      .fn()
      .mockResolvedValue({ readable: true, messages: [], reachedStart: true }),
    setWatchedDwarf: vi.fn(),
    sendDwarfText: vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' }),
    // The verdict of a message main HELD (#457), subscribed unconditionally on mount.
    onDwarfSendSettled: vi.fn().mockReturnValue(() => undefined),
    kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' }),
    retireDwarf: vi.fn(),
    answerDwarfQuestion: vi.fn().mockResolvedValue({ answered: true }),
    answerDwarfPermission: vi.fn().mockResolvedValue({ answered: true }),
    // The launch surface (#86): Claude detected and launchable; a launch answers "started".
    listAgentProviders: vi.fn().mockResolvedValue({
      providers: [{ provider: 'claude', installed: true, launchable: true }]
    }),
    listAgentModels: vi.fn().mockResolvedValue({ catalogs: [] }),
    launchHeldSession: vi.fn().mockResolvedValue({ launched: true }),
    openMinePath: vi.fn().mockResolvedValue({ opened: true }),
    openExternalLink: vi.fn().mockResolvedValue({ opened: true }),
    getTypographyPreferences: vi.fn().mockResolvedValue({ ...DEFAULT_TYPOGRAPHY_PREFERENCES }),
    setTypographyPreferences: vi.fn().mockImplementation((p: unknown) => Promise.resolve(p)),
    onTypographyPreferences: vi.fn().mockReturnValue(() => undefined),
    // The shell's own surfaces, answered as main answers them on a fresh install.
    getMineHistory: vi.fn().mockResolvedValue({ readable: true, speakers: [] }),
    getAlwaysOnTop: vi.fn().mockResolvedValue(true),
    setAlwaysOnTop: vi.fn().mockResolvedValue(true),
    getPanelLayout: vi.fn().mockResolvedValue({ edge: 'right', mineOpen: false, dockOpen: false }),
    setPanelLayout: vi
      .fn()
      .mockImplementation((request: { mineOpen: boolean; dockOpen: boolean }) =>
        Promise.resolve({ edge: 'right', ...request })
      ),
    getToggleShortcut: vi.fn().mockResolvedValue({
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      platform: 'win32'
    }),
    getAppBuild: vi.fn().mockResolvedValue({ version: '1.2.3', packaged: true }),
    getFeatureFlags: vi.fn().mockResolvedValue({ guildAreasEnabled: false }),
    queryProjects: vi.fn().mockResolvedValue({ answered: true, projects: [] }),
    refreshDwarfTelemetry: vi.fn(),
    getAudioPreferences: vi.fn().mockResolvedValue({ ...DEFAULT_AUDIO_PREFERENCES }),
    setAudioPreferences: vi.fn().mockImplementation((p: unknown) => Promise.resolve(p)),
    // Hidden, as main creates the window: nothing opens a media element jsdom cannot play.
    getPanelVisible: vi.fn().mockResolvedValue(false),
    onPanelVisibility: vi.fn().mockReturnValue(() => undefined),
    setOpenMine: vi.fn(),
    onShowMine: vi.fn().mockReturnValue(() => undefined),
    getNotificationsEnabled: vi.fn().mockResolvedValue(true),
    getJevSettings: vi.fn().mockResolvedValue({ ...DEFAULT_JEV_SETTINGS }),
    getOpenCodeSettings: vi
      .fn()
      .mockResolvedValue({ pluginEnabled: false, passwordConfigured: false }),
    setLaunchView: vi.fn(),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

const MINE = {
  id: 'mine:c:/x/anvil',
  path: 'C:/x/anvil',
  name: 'anvil',
  tier: 'bronze',
  dwarfs: [],
  tokensObserved: 0,
  updatedAt: 0
}

/**
 * Every mounted shell, so afterEach can take it down again: the stores are module-scope
 * singletons, so a shell left mounted still answers the next test's snapshot pushes.
 */
const mounted: VueWrapper[] = []

/**
 * The shell, and the surface a person would have asked for: nothing, the Add panel on a mine (its
 * Add action), or the chat on one dwarf of it (a click on the dwarf). The mine is opened as a
 * person opens it, from the map.
 */
async function mountPanel(
  panel: { surface: string; mineId: string; dwarfId: string },
  overrides: Record<string, unknown> = {}
) {
  const api = stubApi(overrides)
  const wrapper = mount(App)
  mounted.push(wrapper)
  await flushPromises()
  if (panel.surface !== 'none') {
    wrapper.findComponent(MapPage).vm.$emit('open', panel.mineId)
    await flushPromises()
    if (panel.surface === 'launch') wrapper.findComponent(MineColumn).vm.$emit('add')
    else await selectOn(wrapper, panel.dwarfId)
    await flushPromises()
  }
  return { wrapper, api }
}

/** A click on a dwarf of the open mine, as the board last drew it. */
async function selectOn(wrapper: VueWrapper, dwarfId: string) {
  const column = wrapper.findComponent(MineColumn)
  const dwarf = (column.props('mine') as { dwarfs: { id: string }[] }).dwarfs.find(
    (candidate) => candidate.id === dwarfId
  )
  if (dwarf === undefined) throw new Error(`no dwarf ${dwarfId} is in the open mine`)
  column.vm.$emit('select', dwarf)
  await flushPromises()
}

/** The shell as it comes up once a dwarf was clicked in its mine. */
async function openOn(dwarfs: unknown[], dwarfId: string, overrides: Record<string, unknown> = {}) {
  return mountPanel(
    { surface: 'message', mineId: MINE.id, dwarfId },
    {
      getMines: vi.fn().mockResolvedValue({ mines: [{ ...MINE, dwarfs }], tokensObserved: 0 }),
      ...overrides
    }
  )
}

/** The poll, as main publishes it to the shell. */
function pushSnapshot(api: Record<string, ReturnType<typeof vi.fn>>, snapshot: unknown) {
  const push = api.onMinesUpdated!.mock.calls[0]![0] as (snapshot: unknown) => void
  push(snapshot)
}

/** Stop dwarf… from the chat's ⋯ menu, confirmed, as a person stops one (#635). */
async function stopDwarf(wrapper: VueWrapper): Promise<void> {
  wrapper.findComponent(MenuButton).vm.$emit('pick', MENU_STOP)
  await flushPromises()
  wrapper.findComponent(DwarfMessagePanel).findComponent(ModalDialog).vm.$emit('action', 1)
  await flushPromises()
}

/** The toasts the shell is showing, where it says what a panel could not do (#635). */
function toastTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.dm-toast').map((toast) => toast.text())
}

const OBSERVED_DWARF = {
  id: 'claude:s1',
  provider: 'claude',
  role: 'foreman',
  name: 'Foreman',
  status: 'working',
  sessionId: 's1',
  lastMessage: 'Halfway down the shaft'
}

/*
 * AMENDED throughout this file for #436. A held session's exchange used to ride
 * the snapshot on `Dwarf.conversation`, so a held dwarf was one that carried
 * that field. It comes back through `getDwarfFeed` now, marked `source: 'held'`,
 * so a held dwarf here is an ordinary dwarf whose feed says so — which is also
 * the shape main actually publishes.
 */
const HELD_DWARF = {
  ...OBSERVED_DWARF,
  id: 'claude:s2',
  sessionId: 's2',
  name: 'Held'
}

/** What `Runtime.dwarfFeed` answers for a session this panel holds (#436). */
function heldFeed(messages: unknown[]): unknown {
  return { readable: true, messages, source: 'held' }
}

/** The bridge stub for a held dwarf's feed, ready to hand to `openOn`. */
function heldFeedStub(messages: unknown[]): Record<string, unknown> {
  return { getDwarfFeed: vi.fn().mockResolvedValue(heldFeed(messages)) }
}

const HELD_EXCHANGE = [{ role: 'user', text: 'dig here', timestamp: 'then' }]

beforeEach(() => {
  // Every store here is a module-scope singleton, and the delivery ones hold a
  // verdict for a minute while they watch for a reaction — so a test that sent,
  // kicked, answered or launched would leave its state in the next one.
  useMines().clear()
  useView().clear()
  // The pages a reader scrolled back to are a singleton too (#364), and one
  // left standing would be drawn under the next test's dwarf.
  useDwarfPaging().clear()
  useDwarfMessaging().clearAll()
  useDwarfKicking().clearAll()
  useDwarfQuestion().clearAll()
  useAgentLaunch().close()
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('the docked message panel', () => {
  // AMENDED for #635 (was: 'draws nothing at all until main says what to show').
  it('draws no panel until a dwarf or the Add action asks for one', async () => {
    const { wrapper } = await mountPanel(CLOSED)
    expect(wrapper.find('.dm-msg').exists()).toBe(false)
    expect(wrapper.find('.add-panel').exists()).toBe(false)
  })

  /*
   * AMENDED for #635 (was: 'opens on the dwarf main named, with no mine anywhere near it'). The
   * mine is beside it again, in the same window: the chat is in the dock's slot and the mine
   * column stands where it stood.
   */
  it('opens on the dwarf that was clicked, the mine still beside it', async () => {
    const { wrapper } = await openOn([OBSERVED_DWARF], 'claude:s1')
    expect(wrapper.find('.dm-msg').exists()).toBe(true)
    expect(wrapper.find('.dm-msg__rename').text()).toBe('Foreman')
    expect(wrapper.find('.dm-minecol').exists()).toBe(true)
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: "adopts a surface main pushes after it is
   * already up". The push was how the second window heard the shell select a dwarf; the selection
   * is this window's own now, and 'blanks back to the reading note when the panel switches to a
   * different dwarf' below still switches an open panel to another dwarf.
   */

  /*
   * AMENDED for #635 (was: 'closes itself through main, so the shell hears about it', asserting the
   * `setMessagePanel` request). The halo is drawn from the same state as the chat now, so a
   * close is heard by the sprite in the same frame.
   */
  it('closes itself, and the sprite lets its halo go', async () => {
    const { wrapper } = await openOn([OBSERVED_DWARF], 'claude:s1')

    await wrapper.find('.dm-msg__close').trigger('click')
    await flushPromises()

    expect(wrapper.find('.dm-msg').exists()).toBe(false)
    expect(wrapper.find('button.dm-dwarf').attributes('aria-pressed')).toBe('false')
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: "raises its OWN window on a press, never
   * the shell". There is one window; a press anywhere on it raises it, which App.test.ts's 'App
   * raise on click (#165)' asserts on the dock that holds this panel.
   */

  it("reads an observed session's transcript, and shows what came back", async () => {
    const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1', {
      getDwarfFeed: vi.fn().mockResolvedValue({
        readable: true,
        messages: [{ role: 'assistant', text: 'Blasting the last metre', timestamp: 'now' }]
      })
    })

    expect(api.getDwarfFeed).toHaveBeenCalledWith('claude:s1')
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Blasting the last metre')
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('Latest activity')
  })

  /*
   * AMENDED for #436 (was: 'never reads a transcript for a session it is
   * holding: it has the words first-hand', asserting `getDwarfFeed` was never
   * called). It is called now, and the answer is still first-hand: main serves
   * a held session's own rows on that channel in front of any transcript read
   * of it, so the panel gets the better evidence by asking rather than by
   * having been handed it on every poll.
   */
  it('asks main for a held session’s exchange, and is told it is first-hand', async () => {
    const { wrapper, api } = await openOn([HELD_DWARF], 'claude:s2', heldFeedStub(HELD_EXCHANGE))

    expect(api.getDwarfFeed).toHaveBeenCalledWith('claude:s2')
    expect(wrapper.find('.dm-bubble__text').text()).toBe('dig here')
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('holding this session')
  })

  it('sends what was typed over the ordinary message channel', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1'
    )

    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
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
    expect(wrapper.find('.dm-composer__hint[role="status"]').text()).toContain(
      'Handed over via terminal'
    )
  })

  it('kicks through the panel, and the verdict lands where it was asked for', async () => {
    // AMENDED for #383 (was: relying on the default kickDwarf stub's
    // `via: 'terminal'`, asserting the status contained 'Kick handed over via
    // terminal' — true before #329/#383 made the terminal tier end the
    // session outright, which now reports "Ended the session…" instead. This
    // test's point is that a click lands its verdict on this exact panel, not
    // the terminal tier's own wording, so a channel that still only asks,
    // claude-relay, keeps that point covered.)
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: {
            sendText: 'terminal',
            cancel: 'terminal',
            adjustEffort: null,
            attach: 'terminal'
          }
        }
      ],
      'claude:s1',
      { kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'claude-relay' }) }
    )

    // AMENDED for #635 (was: one click since #293): Stop dwarf… in the ⋯ menu, confirmed first.
    await stopDwarf(wrapper)

    expect(api.kickDwarf).toHaveBeenCalledWith({ dwarfId: 'claude:s1' })
    // Handed over, never "reacted": only a session SEEN stopping earns that.
    expect(wrapper.find('.dm-composer__hint[role="status"]').text()).toContain(
      'Kick handed over via claude-relay'
    )
    expect(wrapper.find('.dm-composer__hint[role="status"]').text()).not.toContain(
      'the session reacted'
    )
  })

  /*
   * AMENDED (#192, then #162 for the gesture). This used to assert the panel
   * DROPPED when its dwarf left the board, which threw the conversation away —
   * final reply included — at the one moment a person is most likely to be
   * reading it. The panel stays on the dwarf as the board last reported it,
   * says the session has ended, and waits to be closed by hand.
   */
  it('keeps the panel on the last known dwarf when it walks out of the mine, and says so', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1',
      {
        getDwarfFeed: vi.fn().mockResolvedValue({
          readable: true,
          messages: [{ role: 'assistant', text: 'Blasting the last metre', timestamp: 'now' }]
        })
      }
    )
    expect(wrapper.find('.dm-composer textarea').attributes('disabled')).toBeUndefined()

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()

    expect(wrapper.find('.dm-msg').exists()).toBe(true)
    expect(wrapper.find('.dm-msg__rename').text()).toBe('Foreman')
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Blasting the last metre')
    // Ended is said in words, and typing into a session that is gone is
    // refused with the same words rather than handed to main to refuse.
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('ended')
    expect(wrapper.find('.dm-composer textarea').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-composer .dm-field').attributes('title')).toContain('ended')
  })

  it("leaves closing an ended session's panel to the person", async () => {
    const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1')

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()
    expect(wrapper.find('.dm-msg').exists()).toBe(true)

    await wrapper.find('.dm-msg__close').trigger('click')
    await flushPromises()
    expect(wrapper.find('.dm-msg').exists()).toBe(false)
  })

  it('says out loud when the session’s own console could not be brought forward', async () => {
    // The sentence used to be the shell's, beside the mine. The click that
    // raises a console is here now, so the answer to it is too — including the
    // failure, which is the only part of it anybody has to read.
    const { wrapper } = await openOn([OBSERVED_DWARF], 'claude:s1', {
      activateDwarf: vi.fn().mockResolvedValue({ focused: false, openedTerminal: false, feed: [] })
    })

    // AMENDED for #635 (was: the dwarf's name): the header's Console tool.
    await wrapper.find('.dm-msg__console').trigger('click')
    await flushPromises()

    // AMENDED for #635 (was: the `.notice` line above the panel in its own window): said in a
    // toast with the warning icon, where the shell says every other refusal.
    expect(toastTexts(wrapper).join(' ')).toContain('could not be opened')
  })
})

/**
 * A click on an `edit`/`read` activity line's own path (#279). Resolution and
 * verification both happen in main — this window only relays the mine id and
 * the target, and renders whatever main decided on the same `.notice` status
 * line `activate`'s own console-not-opened case already uses.
 */
describe('opening an activity line’s path', () => {
  const WITH_EDIT_ACTIVITY = HELD_DWARF
  // AMENDED for #436: the rows reached the panel on the dwarf, and reach it
  // through the feed now. The line pressed below is the same line.
  const EDIT_FEED = heldFeedStub([
    {
      role: 'assistant' as const,
      text: 'Edited src/main/index.ts',
      timestamp: 't0',
      activity: { kind: 'edit' as const, target: 'src/main/index.ts' }
    }
  ])

  /**
   * #294 folded the run this line belongs to into one collapsed disclosure row,
   * so reaching the line is a press first. The three tests below are AMENDED
   * with that press and nothing else — what each claims about the relay is what
   * it claimed before.
   */
  async function openLine(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('.dm-activity__toggle').trigger('click')
    // AMENDED for #635: the step's own path button inside its list item.
    await wrapper.find('.dm-activity__path').trigger('click')
  }

  it('asks main with the current mine id and the exact target, not the display text', async () => {
    const { wrapper, api } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id, EDIT_FEED)

    await openLine(wrapper)
    await flushPromises()

    // The dwarf travels with it as of #348, so main can resolve the path
    // against THIS dwarf's worktree when the mine is folded from several. Still
    // no folder: an id the board can check, exactly like the mine's.
    expect(api.openMinePath).toHaveBeenCalledWith({
      mineId: MINE.id,
      target: 'src/main/index.ts',
      dwarfId: WITH_EDIT_ACTIVITY.id
    })
  })

  it("says out loud main's fixed refusal when the path could not be opened", async () => {
    const { wrapper } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id, {
      ...EDIT_FEED,
      openMinePath: vi.fn().mockResolvedValue({
        opened: false,
        reason: "That path is outside this mine's folder."
      })
    })

    await openLine(wrapper)
    await flushPromises()

    // AMENDED for #635 (was: the `.notice` line): a toast, as above.
    expect(toastTexts(wrapper)).toContain("That path is outside this mine's folder.")
  })

  it('says nothing when the file opened successfully', async () => {
    const { wrapper } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id, EDIT_FEED)

    const before = toastTexts(wrapper).length
    await openLine(wrapper)
    await flushPromises()

    // No toast of its own: the queue is the window's, so what counts is what this press added.
    expect(toastTexts(wrapper)).toHaveLength(before)
  })
})

/**
 * The verdicts this window is the only writer of, published to the shell so the
 * mine can draw each one on the sprite it belongs to (#162).
 *
 * The stores used to be fed by MineScene, from the crew of the one mine it drew.
 * They live here now because this window is the one that sends and kicks, and a
 * watch for a reaction can only be resolved where it was opened.
 */
/*
 * AMENDED for #635 (was: 'publishing the delivery verdicts', each case reading the report the
 * panel window sent across the bridge). The mine and the stores are one page now, so each case
 * reads what the mine column is handed — the one thing the report was for.
 */
describe('handing the delivery verdicts to the mine', () => {
  it('hands the mine a send the moment its verdict lands', async () => {
    const { wrapper } = await openOn([{ ...OBSERVED_DWARF, textDelivery: 'terminal' }], 'claude:s1')

    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const send = wrapper.findComponent(MineColumn).props('sendStates') as Record<
      string,
      { phase: string }
    >
    expect(send['claude:s1']?.phase).toBe('delivered')
  })

  // ADDED for #635 (PANEL-QUESTIONS 16): the history draws a message that never arrived from the
  // app's own record of the send. AMENDED for the MessagePanel slice (was: read off the report):
  // the record is the messaging store the history is handed from, in this window.
  it('records a message that failed, with its words and send time', async () => {
    const { wrapper } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1',
      { sendDwarfText: vi.fn().mockResolvedValue({ delivered: false, via: 'none', error: 'gone' }) }
    )
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const failed = useDwarfMessaging().failedSends()
    expect(failed['claude:s1']?.map((f) => f.text)).toEqual(['dig deeper'])
    expect(typeof failed['claude:s1']?.[0]?.sentAt).toBe('number')
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: "reports plain objects, because a Vue
   * proxy cannot cross the bridge". Nothing about a verdict crosses a bridge any more: the mine is
   * handed the store's own state in the same page.
   */

  /*
   * MOVED from MineScene.test.ts's 'MineScene reaction feed' block (#162),
   * whole: the two stores are fed here now, and a scene that folded the poll
   * in from the other window could never resolve a watch this one opened.
   */
  it('promotes a delivered kick when the next poll shows the session stopped', async () => {
    // AMENDED for #383 (was: relying on the default kickDwarf stub's
    // `via: 'terminal'` to promote to 'reacted' on the next poll — true
    // before #329/#383 made the terminal tier end the session outright,
    // which now stays 'delivered' forever with nothing watched. This test's
    // point is the promotion mechanism itself, so it keeps that covered
    // through a channel that still only asks, claude-relay.)
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: {
            sendText: 'terminal',
            cancel: 'terminal',
            adjustEffort: null,
            attach: 'terminal'
          }
        }
      ],
      'claude:s1',
      { kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'claude-relay' }) }
    )
    // AMENDED for #635: the kick is Stop dwarf… in the ⋯ menu, confirmed first.
    await stopDwarf(wrapper)
    expect(useDwarfKicking().stateFor('claude:s1')?.phase).toBe('delivered')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...OBSERVED_DWARF, status: 'waiting' }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(useDwarfKicking().stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('promotes a delivered message when the next poll shows new output', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1'
    )
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(useDwarfMessaging().stateFor('claude:s1')?.phase).toBe('delivered')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...OBSERVED_DWARF, lastMessage: 'On it' }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(useDwarfMessaging().stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('leaves a delivery alone while nothing about the session changed', async () => {
    // AMENDED for #383 (was: relying on the default kickDwarf stub's
    // `via: 'terminal'`. Since the terminal tier now ends the session
    // outright it opens no reaction watch at all, so this assertion would
    // hold trivially — nothing was ever being watched — rather than
    // exercising the "watched, but nothing changed" path this test is
    // actually about. A channel that still only asks, claude-relay, keeps
    // that path genuinely covered.)
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: {
            sendText: 'terminal',
            cancel: 'terminal',
            adjustEffort: null,
            attach: 'terminal'
          }
        }
      ],
      'claude:s1',
      { kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'claude-relay' }) }
    )
    // AMENDED for #635: the kick is Stop dwarf… in the ⋯ menu, confirmed first.
    await stopDwarf(wrapper)

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [OBSERVED_DWARF] }], tokensObserved: 0 })
    await flushPromises()

    // Delivered is what happened; 'reacted' would be a claim nothing supports.
    expect(useDwarfKicking().stateFor('claude:s1')?.phase).toBe('delivered')
  })
})

/*
 * REMOVED for #635, stated rather than passing unseen: the whole 'reporting its own height' block
 * (six cases: the measured surface reported in design pixels, the observer, a report on every
 * change of surface and of content, none before layout, one per dwarf). They sized the panel's
 * own window, which is gone: the panel fills the dock's slot, whose height is the dock's
 * (decision log, MessagePanel and Add panel anchored), and whose width main reserves with the
 * slot (panelBounds.test.ts, and App.test.ts's 'App dock (#635)').
 */

/**
 * The whole answer loop through the real components (#125): a question reaches
 * the panel on a snapshot, an option is chosen, and Enter releases the agent's
 * own blocked tool call over the answer channel.
 */
describe('answering an agent question', () => {
  // AMENDED for #443 (was: the question's fields flat on the ask): the wire
  // shape carries the call's questions as a list.
  const PENDING_QUESTION = {
    toolUseId: 'toolu_01',
    questions: [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }]
      }
    ]
  }

  const ASKING_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'waiting',
    sessionId: 's1',
    pendingQuestion: PENDING_QUESTION
  }

  async function openAskingDwarf(overrides: Record<string, unknown> = {}) {
    return openOn([ASKING_DWARF], 'claude:s1', overrides)
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

  /* --- Answering in the person's own words (#481) — one block, appended ---- */

  /** The same dwarf, with its ask drawn at its OWN terminal rather than held. */
  async function openWatchedAsk(overrides: Record<string, unknown> = {}) {
    return openOn(
      [
        {
          ...ASKING_DWARF,
          // AMENDED for #443 (was: `questionCount: 1` beside the channel): the
          // fixture's one-entry `questions` list already says one question.
          pendingQuestion: { ...PENDING_QUESTION, channel: 'terminal' }
        }
      ],
      'claude:s1',
      overrides
    )
  }

  it('carries the typed answer to main over the ANSWER channel, not the message one', async () => {
    // The whole loop #481 reopened: the box is offered again on a watched
    // single-select ask, and what leaves it is an answer for the picker's own
    // "Other" row — never a message, which on that channel writes into the
    // console the picker is drawn in.
    const { wrapper, api } = await openWatchedAsk()
    await wrapper.find('.freeform-input').setValue('put it in Redis')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.answerDwarfQuestion).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      text: 'put it in Redis'
    })
    expect(api.sendDwarfText).not.toHaveBeenCalled()
  })

  it('shows main’s reason when the typed answer was refused', async () => {
    const { wrapper } = await openWatchedAsk({
      answerDwarfQuestion: vi.fn().mockResolvedValue({
        answered: false,
        error: 'There was nothing written to send, so nothing was typed.'
      })
    })
    await wrapper.find('.freeform-input').setValue('put it in Redis')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.find('.answer-error').text()).toContain('nothing was typed')
  })
})

/**
 * The whole decision loop through the real components (#203): a permission
 * prompt reaches the panel on a snapshot, Allow is chosen, and Enter releases
 * the blocked tool call over the permission channel — a sibling loop to the
 * question one above, over a sibling channel.
 */
describe('deciding a permission prompt', () => {
  const BLOCKED_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'waiting',
    sessionId: 's1',
    pendingPermission: {
      toolUseId: 'toolu_09',
      toolName: 'Bash',
      input: 'rm -rf /tmp/scratch',
      askedAt: '2026-09-05T09:00:00.000Z'
    }
  }

  it('shows the permission card, sends the decision over its own channel, and leaves it standing', async () => {
    const { wrapper, api } = await openOn([BLOCKED_DWARF], 'claude:s1')
    expect(wrapper.find('.permission-card').exists()).toBe(true)

    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.permission-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.answerDwarfPermission).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_09',
      decision: 'allow'
    })
    // Only main's next snapshot may drop a pendingPermission — the panel's
    // part ends at handing the decision over.
    expect(wrapper.find('.permission-card').exists()).toBe(true)
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
describe('feed refresh (#183)', () => {
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

  // AMENDED for #436: a held dwarf carried its own `conversation` field, which
  // is why the two cases below used to assert this panel never touched
  // `getDwarfFeed` for one. That field is gone — what says a dwarf is held now
  // is its FEED, not itself — so this is an ordinary dwarf again and the two
  // cases it feeds are named for what actually happens today.
  const HELD_REFRESH_DWARF = {
    ...REFRESH_DWARF,
    id: 'claude:s2',
    sessionId: 's2'
  }

  async function openRefreshDwarf(overrides: Record<string, unknown> = {}) {
    return openOn([REFRESH_DWARF], 'claude:s1', overrides)
  }

  async function sendFromPanel(wrapper: VueWrapper, text: string) {
    await wrapper.find('.dm-composer textarea').setValue(text)
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
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

  /*
   * AMENDED for #436. This was "never reads a transcript for a session it is
   * holding, even from its own send", pinning that a held dwarf's
   * `conversation` field made a read unnecessary. A held session's words are
   * served by `getDwarfFeed` now, marked `source: 'held'`, exactly like an
   * observed one — and a delivered send is read back sooner for a held
   * session than for an observed one (#428): main records the panel's own
   * message on the exchange the moment the stream takes it, so the row is
   * there to be fetched before the agent has said anything at all.
   */
  it("reads a held session's feed like any other, including after its own send", async () => {
    const { wrapper, api } = await openOn(
      [HELD_REFRESH_DWARF],
      'claude:s2',
      heldFeedStub(HELD_EXCHANGE)
    )
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
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

    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    await wrapper.find('.dm-msg__close').trigger('click')
    await flushPromises()
    resolveSend({ delivered: true, via: 'terminal' })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the transcript-movement signal changes, even when lastMessage does not', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
  })

  it('stays put on an ordinary poll where neither signal moved', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [REFRESH_DWARF] }], tokensObserved: 0 })
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

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, status: 'leaving' }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Seam exhausted, packing up.')

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Seam exhausted, packing up.')
  })

  /*
   * The maintainer's follow-up on #195: `readSelectedFeed` used to blank
   * `selectedFeed` to `undefined` before every await, not only the first one
   * for a dwarf — so a re-read for the SAME dwarf rebuilt the row list from
   * nothing while its answer was still in flight. That is what made a busy
   * session's panel look frozen: rows arrive below the fold and the list
   * snaps back to empty (and, via DwarfMessagePanel's own scroll, to the top)
   * before the same words reappear a moment later. The READING note is for
   * the first read of a dwarf only — a re-read keeps the previous result on
   * screen until the new one lands.
   */
  it('keeps the previous feed on screen while a re-read for the same dwarf is in flight', async () => {
    let resolveSecond: (value: { readable: boolean; messages: unknown[] }) => void = () => {}
    const getDwarfFeed = vi
      .fn()
      .mockResolvedValueOnce({
        readable: true,
        messages: [{ role: 'assistant', text: 'Halfway down the shaft', timestamp: 't1' }]
      })
      .mockImplementationOnce(
        () =>
          new Promise<{ readable: boolean; messages: unknown[] }>((resolve) => {
            resolveSecond = resolve
          })
      )
    const { wrapper, api } = await openRefreshDwarf({ getDwarfFeed })
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Halfway down the shaft')

    pushSnapshot(api, {
      // lastMessage cleared: conversationOf falls back to it while feed is
      // undefined, and that fallback would otherwise show the very same words
      // and mask a wrongful blank — this way a regression here has nothing
      // else to fall back to.
      mines: [
        { ...MINE, dwarfs: [{ ...REFRESH_DWARF, lastMessage: '', transcriptUpdatedAt: 1_000 }] }
      ],
      tokensObserved: 0
    })
    await flushPromises()

    // The second read is in flight and unresolved: the previous message must
    // stay on screen, and the note must not flash back to "reading" — a
    // re-read for the SAME dwarf is not a first read.
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Halfway down the shaft')
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('Latest activity')

    resolveSecond({
      readable: true,
      messages: [{ role: 'assistant', text: 'Seam exhausted, packing up.', timestamp: 't2' }]
    })
    await flushPromises()

    expect(wrapper.find('.dm-bubble__text').text()).toBe('Seam exhausted, packing up.')
  })

  it('blanks back to the reading note when the panel switches to a different dwarf', async () => {
    // A change of dwarf IS a first read again — unlike the re-read above, the
    // previous dwarf's words must not linger under a different dwarf's name.
    // lastMessage cleared on both: conversationOf otherwise falls back to it
    // while feed is undefined, which would show a bubble either way and mask
    // a wrongful non-blank on the switch.
    const FIRST_DWARF = { ...REFRESH_DWARF, lastMessage: '' }
    const SECOND_DWARF = {
      ...REFRESH_DWARF,
      id: 'claude:s3',
      sessionId: 's3',
      name: 'Digger',
      lastMessage: ''
    }
    let resolveSecondDwarfFeed: (value: {
      readable: boolean
      messages: unknown[]
    }) => void = () => {}
    const getDwarfFeed = vi.fn((dwarfId: string) => {
      if (dwarfId === FIRST_DWARF.id) {
        return Promise.resolve({
          readable: true,
          messages: [{ role: 'assistant', text: 'Halfway down the shaft', timestamp: 't1' }]
        })
      }
      return new Promise<{ readable: boolean; messages: unknown[] }>((resolve) => {
        resolveSecondDwarfFeed = resolve
      })
    })
    const { wrapper } = await openOn([FIRST_DWARF, SECOND_DWARF], 'claude:s1', {
      getDwarfFeed
    })
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Halfway down the shaft')

    // The switch is the person selecting somebody else in the mine. AMENDED for
    // #635 (was: a state pushed from the shell to the panel's own window).
    await selectOn(wrapper, 'claude:s3')

    expect(wrapper.find('.dm-bubble__text').exists()).toBe(false)
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('Reading')

    resolveSecondDwarfFeed({
      readable: true,
      messages: [{ role: 'assistant', text: 'Just arrived at the seam.', timestamp: 't2' }]
    })
    await flushPromises()
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Just arrived at the seam.')
  })

  /**
   * The push riding the SAME snapshot as the board (#196): main reads the
   * watched dwarf's feed on its own pass and carries it with the poll,
   * instead of this panel noticing the moved signal and pulling a second
   * time over its own round trip.
   */
  describe('adopting a pushed feed (#196)', () => {
    it('adopts a pushed feed for the open dwarf without an extra getDwarfFeed call', async () => {
      const { wrapper, api } = await openRefreshDwarf()
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0,
        watchedFeed: {
          dwarfId: 'claude:s1',
          feed: {
            readable: true,
            messages: [
              { role: 'assistant', text: 'Pushed straight from the poll', timestamp: 't2' }
            ]
          }
        }
      })
      await flushPromises()

      // The very signal that would ordinarily trigger a pull already arrived
      // WITH its feed, so the watch must not pull a second time for it.
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
      expect(wrapper.find('.dm-bubble__text').text()).toBe('Pushed straight from the poll')
    })

    it('still pulls once on the first selection, before any push has arrived', async () => {
      const { api } = await openRefreshDwarf()

      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
      expect(api.getDwarfFeed).toHaveBeenCalledWith('claude:s1')
    })

    it('ignores a pushed feed for a dwarf this panel is no longer open on', async () => {
      const { wrapper, api } = await openRefreshDwarf()
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

      await wrapper.find('.dm-msg__close').trigger('click')
      await flushPromises()

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0,
        watchedFeed: {
          dwarfId: 'claude:s1',
          feed: {
            readable: true,
            messages: [{ role: 'assistant', text: 'late arrival', timestamp: 't2' }]
          }
        }
      })
      await flushPromises()

      expect(wrapper.find('.dm-msg').exists()).toBe(false)
    })

    it('still falls back to a pull when the snapshot carries no watched feed', async () => {
      const { api } = await openRefreshDwarf()
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0
      })
      await flushPromises()

      expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    })
  })

  it('tells main which observed dwarf it has open, so the poll can carry its feed', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.setWatchedDwarf).toHaveBeenLastCalledWith('claude:s1')
  })

  /*
   * AMENDED for #436 (was: "watches nothing for a held session, which already
   * carries its own words" — asserting `null`, on the reading that a held
   * dwarf's `conversation` field made this push unnecessary). That field is
   * gone: a held session's words are served on demand now, and this push is
   * the ONLY thing that keeps such a session live, since a hosted process
   * writes no transcript and none of the signals the other watch keys on ever
   * move for it.
   */
  it('watches a held session exactly like an observed one', async () => {
    const { api } = await openOn([HELD_REFRESH_DWARF], 'claude:s2')
    expect(api.setWatchedDwarf).toHaveBeenLastCalledWith('claude:s2')
  })
})

/**
 * The Add Panel, wired end to end (#86): the mine's Add action asks main for
 * the launch surface, submitting starts a held session in that mine's folder,
 * and the panel hands over to the MessagePanel when the dwarf it started turns
 * up on an ordinary poll.
 */
describe('the add panel', () => {
  /*
   * AMENDED for #635 throughout this block: the redesigned Add panel (organisms/add-panel) is
   * `.dm-add`, its suppliers ChoiceChip radios, its prompt the design's four-row field, which
   * takes line breaks and launches on Ctrl+Enter (Cmd+Enter on a Mac), and its Jev pair two
   * switches. What the panel says — main's refusal among it — is the line beside Send the dwarf
   * in. Each case whose meaning changed says so where it stands.
   */
  const ADD = '.dm-add'
  const CHIPS = '.dm-add__chips .dm-chip'
  const PROMPT = '.dm-add__prompt textarea'

  const OTHER_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'Halfway down the shaft'
  }

  /**
   * The dwarf a launch of `prompt` leaves behind: held, and seeded with it.
   *
   * AMENDED for #436 (was: `conversation: [{ role: 'user', text: prompt, ... }]`
   * — the whole retained exchange, of which the launch receipt was the first
   * row). The receipt is `openingPrompt` now, one row rather than the front of
   * an exchange that rode every snapshot; `launchedDwarfIn` reads that field.
   */
  function launchedDwarf(prompt: string) {
    return {
      id: 'claude:s9',
      provider: 'claude',
      role: 'foreman',
      name: 'Newcomer',
      status: 'working',
      sessionId: 's9',
      openingPrompt: { role: 'user', text: prompt, timestamp: 'then' }
    }
  }

  async function openAddPanel(overrides: Record<string, unknown> = {}) {
    return mountPanel({ surface: 'launch', mineId: MINE.id, dwarfId: '' }, overrides)
  }

  async function submitPrompt(wrapper: VueWrapper, prompt: string) {
    await wrapper.findAll(CHIPS)[0]!.trigger('click')
    await wrapper.find(PROMPT).setValue(prompt)
    await wrapper.find(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
  }

  // AMENDED for #635 (was: 'opens on the launch surface main was asked for').
  it('opens on the mine its Add action was pressed in', async () => {
    const { wrapper } = await openAddPanel()
    expect(wrapper.find(ADD).exists()).toBe(true)
  })

  it('asks main which providers this machine has when it opens', async () => {
    const { api, wrapper } = await openAddPanel()

    expect(api.listAgentProviders).toHaveBeenCalled()
    // AMENDED for #635 (was: ['claude', 'Other']): the tool's own name, and Other….
    expect(wrapper.findAll(CHIPS).map((chip) => chip.text())).toEqual(['Claude', 'Other…'])
  })

  /*
   * The design gives both panels the same place — the transition is one
   * replacing the other — so they cannot both be there. Which of them is drawn
   * follows the surface main holds, and this window is the only place that
   * decision is made.
   *
   * AMENDED for #635: the surface is the dock's own, asked for by the mine's
   * Add action and by a click on a dwarf (was: states pushed from main).
   */
  it('takes the place of an open MessagePanel', async () => {
    const { wrapper } = await openOn([OTHER_DWARF], 'claude:s1')
    expect(wrapper.find('.dm-msg').exists()).toBe(true)

    wrapper.findComponent(MineColumn).vm.$emit('add')
    await flushPromises()

    expect(wrapper.find(ADD).exists()).toBe(true)
    expect(wrapper.find('.dm-msg').exists()).toBe(false)
  })

  it('gives it back when a dwarf is selected instead', async () => {
    const { wrapper } = await mountPanel(
      { surface: 'launch', mineId: MINE.id, dwarfId: '' },
      {
        getMines: vi
          .fn()
          .mockResolvedValue({ mines: [{ ...MINE, dwarfs: [OTHER_DWARF] }], tokensObserved: 0 })
      }
    )
    expect(wrapper.find(ADD).exists()).toBe(true)

    await selectOn(wrapper, 'claude:s1')

    expect(wrapper.find(ADD).exists()).toBe(false)
    expect(wrapper.find('.dm-msg').exists()).toBe(true)
  })

  // AMENDED for #635 (was: 'closes from its own close control, through main', with the
  // `setMessagePanel` request): the dock lets the launch go in this window.
  it('closes from its own close control', async () => {
    const { wrapper } = await openAddPanel()

    await wrapper.find('.dm-add__close').trigger('click')
    await flushPromises()

    expect(wrapper.find(ADD).exists()).toBe(false)
    expect(useAgentLaunch().phase.value).toBe('closed')
  })

  it('does not start a fresh panel when the same surface arrives twice', async () => {
    // `open()` starts a FRESH panel, so a repeated request — AMENDED for #635
    // (was: the shell re-publishing, a push landing after the pull): the Add
    // action pressed again — would silently discard a prompt somebody was
    // half-way through typing.
    const { wrapper } = await openAddPanel()
    await wrapper.findAll(CHIPS)[0]!.trigger('click')
    await wrapper.find(PROMPT).setValue('dig the east gallery')
    await flushPromises()

    wrapper.findComponent(MineColumn).vm.$emit('add')
    await flushPromises()

    expect(wrapper.find<HTMLTextAreaElement>(PROMPT).element.value).toBe('dig the east gallery')
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

    // AMENDED for #635 (was: the spawning view's `.launch-first-message`). The redesign keeps
    // the panel as it is while the dwarf is sent in: the prompt in its field, and the line.
    expect(wrapper.find(ADD).exists()).toBe(true)
    expect(wrapper.find<HTMLTextAreaElement>(PROMPT).element.value).toBe('dig the east gallery')
    expect(wrapper.find('.dm-add__why').text()).toBe('Sending the dwarf in…')
  })

  it('hands over to the MessagePanel when the launched dwarf arrives', async () => {
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [launchedDwarf('dig the east gallery')] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(wrapper.find(ADD).exists()).toBe(false)
    expect(wrapper.find('.dm-msg').exists()).toBe(true)
    expect(wrapper.find('.dm-msg__rename').text()).toBe('Newcomer')
  })

  /*
   * AMENDED for #635 (was: 'tells main which dwarf the launch produced, so the mine can halo it',
   * asserting the `setMessagePanel` request). The halo is drawn in this window from the dwarf the
   * dock adopted, so the case asserts the halo itself.
   */
  it('halos the dwarf the launch produced', async () => {
    // The handover is decided by the launch's own arrival rules, from the
    // board: a handover the halo missed is a dwarf that starts work with no
    // mark on it.
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [launchedDwarf('dig the east gallery')] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(wrapper.find('button.dm-dwarf').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('button.dm-dwarf').attributes('aria-label')).toContain('Newcomer')
  })

  /*
   * The reconciliation. The held registry seeds the new session's exchange
   * with the prompt this panel sent, and `Runtime.dwarfFeed` answers it on
   * demand (#436) — so the MessagePanel draws it once it has asked, and
   * prepending a second copy here would show the user's own first words
   * twice, from a source that is not main's record of them.
   */
  it('shows the first message exactly once after the transition', async () => {
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 }),
      ...heldFeedStub([{ role: 'user', text: 'dig the east gallery', timestamp: 'then' }])
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [launchedDwarf('dig the east gallery')] }],
      tokensObserved: 0
    })
    await flushPromises()

    const said = wrapper
      .findAll('.dm-bubble .dm-bubble__text')
      .filter((bubble) => bubble.text() === 'dig the east gallery')
    expect(said).toHaveLength(1)
  })

  it('keeps waiting while only an unrelated session turns up', async () => {
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [OTHER_DWARF] }], tokensObserved: 0 })
    await flushPromises()

    expect(wrapper.find(ADD).exists()).toBe(true)
    expect(wrapper.find('.dm-msg').exists()).toBe(false)
  })

  it('stays open with main own reason when the launch is refused', async () => {
    const { wrapper } = await openAddPanel({
      launchHeldSession: vi
        .fn()
        .mockResolvedValue({ launched: false, error: 'Claude Code is not installed.' })
    })

    await submitPrompt(wrapper, 'dig the east gallery')

    expect(wrapper.find(ADD).exists()).toBe(true)
    expect(wrapper.find('.dm-add__why.is-alert').text()).toBe('Claude Code is not installed.')
  })

  /*
   * The failure channel (#263), end to end: main pushes what it learned
   * AFTER `agent:launch` already answered `launched: true`, and the panel
   * returns to the composer with the CLI's own words rather than staying
   * parked on "the session started" forever.
   */
  it('returns to the composer with the CLI’s own words when the launch fails after it started', async () => {
    const { wrapper, api } = await openAddPanel({
      listAgentProviders: vi.fn().mockResolvedValue({
        providers: [{ provider: 'codex', installed: true, launchable: true }]
      }),
      launchAgent: vi
        .fn()
        .mockResolvedValue({ launched: true, provider: 'codex', launchId: 'receipt:1' })
    })

    await submitPrompt(wrapper, 'dig the east gallery')
    // The detached wait, before anything failed. AMENDED for #635 (was: `.launch-note` present
    // and `.launch-alert` absent): the line says it, and is not an alert yet.
    expect(wrapper.find('.dm-add__why').text()).toContain('The session started.')
    expect(wrapper.find('.dm-add__why.is-alert').exists()).toBe(false)

    const fail = api.onLaunchFailed.mock.calls[0]![0] as (push: unknown) => void
    fail({
      launchId: 'receipt:1',
      provider: 'codex',
      mineId: MINE.id,
      exitCode: 1,
      stderrTail: 'codex: another instance is already running'
    })
    await flushPromises()

    expect(wrapper.find('.dm-add__why.is-alert').text()).toBe(
      'codex: another instance is already running'
    )
    // The composer is back, prompt intact, so a retry costs one click.
    expect(wrapper.find<HTMLTextAreaElement>(PROMPT).element.value).toBe('dig the east gallery')
  })

  /*
   * Issue #523's wiring, end to end: the toggle opens this panel's composer
   * with no chip pressed, and the checkbox beside it collapses #509's two
   * Enters into one. Nothing above this line could tell a missing listener
   * from a dead rule — the Add Panel emits, this window decides where the
   * press goes, and the decision is exactly what this pins.
   */
  it('launches an auto-accepted Jev decision in one Enter, with no chip chosen', async () => {
    // Local spies for the two members this file's stub does not carry by
    // default — asked is exactly what the no-chip Enter must now do, and the
    // assertion has to reach it even though the base stub answers "hidden".
    // AMENDED for #635 (MESSAGE-QUESTIONS Q1; was: no `tier` or `parts`): the decision card now
    // stays on screen while the launch it confirmed is in flight, so it reads the whole answer
    // the wire carries since jev-routing-profiles T3, and this answer gives it one.
    const askJev = vi.fn().mockResolvedValue({
      kind: 'decision',
      provider: 'claude',
      confidence: 0.9,
      truncated: false,
      tier: 'balanced',
      parts: {
        provider: { value: 'claude', confidence: 0.9, applied: 'answered' },
        tier: { value: 'balanced', confidence: 0.9, applied: 'answered' },
        trivial: { value: false, probability: 0.1 },
        largeContext: { value: false, probability: 0.1 },
        model: { applied: 'safe-default', reason: 'no-live-model' }
      }
    })
    const { api, wrapper } = await openAddPanel({
      getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
      routeJevLaunch: askJev
    })

    await wrapper.get('button[aria-label="Let Jev choose"]').trigger('click')
    await wrapper.get('button[aria-label="Auto-accept Jev"]').trigger('click')
    await wrapper.find(PROMPT).setValue('dig the east gallery')
    await wrapper.find(PROMPT).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()

    expect(askJev).toHaveBeenCalledWith({ prompt: 'dig the east gallery' })
    // The decision's own provider, applied to the pickers and launched on the
    // same Enter — the second press the card used to demand is gone.
    expect(api.launchHeldSession).toHaveBeenCalledWith({
      mineId: MINE.id,
      provider: 'claude',
      prompt: 'dig the east gallery',
      routedByJev: true
    })
  })
})

/**
 * The sent message on screen at once, with its own verdict (#309).
 *
 * This is where the two halves meet: the store mints the echo before it asks
 * any channel anything, and the panel draws it. The block above pins that the
 * SHELL still hears one verdict per dwarf, and the last test here pins that
 * nothing about an echo has joined that report — the sprite marker's semantics
 * are deliberately untouched.
 */
describe('the sent message, drawn at once (#309)', () => {
  const ECHO_DWARF = { ...OBSERVED_DWARF, lastMessage: '', textDelivery: 'terminal' }

  async function sendFrom(wrapper: VueWrapper, text: string) {
    await wrapper.find('.dm-composer textarea').setValue(text)
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
  }

  it('draws the message before any channel has answered, and clears the composer with it', async () => {
    // The delivery never resolves, which is the case the issue is about: a
    // relay that takes seconds, or a terminal that cannot be focused.
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', {
      sendDwarfText: vi.fn(() => new Promise(() => {}))
    })

    await sendFrom(wrapper, 'dig deeper')

    expect(wrapper.find('.dm-bubble--user .dm-bubble__text').text()).toBe('dig deeper')
    expect(wrapper.find('.dm-bubble__mark').text()).toBe('…')
    expect((wrapper.find('.dm-composer textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it("turns the bubble's own marker into one tick when the delivery lands", async () => {
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1')

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    const marker = wrapper.find('.dm-bubble__mark')
    expect(marker.text()).toBe('✓')
    expect(marker.attributes('title')).toContain('Handed to the session')
  })

  it('marks the bubble with a ✕ and its reason, keeping the words on screen', async () => {
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', {
      sendDwarfText: vi.fn().mockResolvedValue({
        delivered: false,
        via: 'terminal',
        error: 'The terminal would not come forward.'
      })
    })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    // AMENDED for #635 (was: '✕'): spelled as the design writes it.
    expect(wrapper.find('.dm-bubble__mark').text()).toBe('✕ not delivered')
    expect(wrapper.find('.dm-bubble__mark').attributes('title')).toBe(
      'The terminal would not come forward.'
    )
    expect(wrapper.find('.dm-bubble--user .dm-bubble__text').text()).toBe('dig deeper')
  })

  it('sends a failed message again from its own bubble, and keeps the failed one marked', async () => {
    const sendDwarfText = vi
      .fn()
      .mockResolvedValueOnce({ delivered: false, via: 'terminal', error: 'nope' })
      .mockResolvedValue({ delivered: true, via: 'claude-relay' })
    const { wrapper, api } = await openOn([ECHO_DWARF], 'claude:s1', { sendDwarfText })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    await wrapper.find('.dm-bubble__actions .dm-btn').trigger('click')
    await flushPromises()

    expect(api.sendDwarfText).toHaveBeenCalledTimes(2)
    expect(api.sendDwarfText).toHaveBeenLastCalledWith({
      dwarfId: 'claude:s1',
      text: 'dig deeper',
      pressEnter: true
    })
    const markers = wrapper.findAll('.dm-bubble__mark')
    // AMENDED for #635 (was: '✕'): the failure spelled as the design writes it.
    expect(markers.map((marker) => marker.text())).toEqual(['✕ not delivered', '✓'])
  })

  it('shows the words once, not twice, when the transcript catches up', async () => {
    // The reconciliation (#309): a `user` turn with the same words, stamped
    // after the send, IS this message — so the feed's row replaces the echo
    // rather than standing beside it.
    let reads = 0
    const getDwarfFeed = vi.fn(() => {
      reads++
      return Promise.resolve(
        reads === 1
          ? { readable: true, messages: [] }
          : {
              readable: true,
              messages: [
                {
                  role: 'user',
                  text: 'dig deeper',
                  timestamp: new Date(Date.now() + 1_000).toISOString()
                }
              ]
            }
      )
    })
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', { getDwarfFeed })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    const bubbles = wrapper.findAll('.dm-bubble--user .dm-bubble__text')
    expect(bubbles.map((bubble) => bubble.text())).toEqual(['dig deeper'])
    // The row that survived is the transcript's, which carries no verdict of
    // its own: the session HAS the message now. AMENDED for #635 (was: no mark
    // at all): it wears the record's mark, handed over and nothing seen yet.
    expect(wrapper.find('.dm-bubble__mark').attributes('data-mark')).toBe('delivered')
  })

  it('keeps the echo when the transcript carries an older turn with the same words', async () => {
    // The near miss: the person said this before, the transcript already had
    // it, and saying it again is exactly why there is an echo.
    const getDwarfFeed = vi.fn().mockResolvedValue({
      readable: true,
      messages: [
        { role: 'user', text: 'dig deeper', timestamp: new Date(Date.now() - 60_000).toISOString() }
      ]
    })
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', { getDwarfFeed })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    expect(wrapper.findAll('.dm-bubble--user .dm-bubble__text')).toHaveLength(2)
    expect(wrapper.find('.dm-bubble__mark').text()).toBe('✓')
  })

  it('forgets the echoes when the panel moves to another dwarf, and coming back does not revive them', async () => {
    // The panel is keyed by dwarf, so ANOTHER dwarf's surface draws none of
    // these anyway — going away and coming back is what proves the store let
    // go of them rather than the component merely not asking.
    const SECOND = { ...ECHO_DWARF, id: 'claude:s3', sessionId: 's3', name: 'Digger' }
    const { wrapper } = await openOn([ECHO_DWARF, SECOND], 'claude:s1', {
      sendDwarfText: vi.fn(() => new Promise(() => {}))
    })

    await sendFrom(wrapper, 'dig deeper')
    expect(wrapper.find('.dm-bubble--user .dm-bubble__text').exists()).toBe(true)

    // AMENDED for #635 (was: states pushed to the panel's own window): clicks in the mine.
    await selectOn(wrapper, 'claude:s3')
    expect(wrapper.find('.dm-bubble--user .dm-bubble__text').exists()).toBe(false)

    await selectOn(wrapper, 'claude:s1')
    expect(wrapper.find('.dm-bubble--user .dm-bubble__text').exists()).toBe(false)
  })

  // AMENDED for #635 (was: 'reports nothing about an echo to the shell', reading the report the
  // panel window published): the mine is handed the same one verdict per dwarf, in this window.
  it('hands the mine nothing about an echo: a dwarf still has one verdict', async () => {
    // #309 adds no shape to the sprite. The marker reads the same two maps it
    // always did, and an echo is the chat's own state.
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1')

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    const column = wrapper.findComponent(MineColumn)
    expect(column.props('sendStates')).toEqual({
      'claude:s1': { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
    expect(column.props('kickStates')).toEqual({})
  })
})

/**
 * A press on a link inside a bubble (#347).
 *
 * The same division #279 drew one describe above: this window relays the
 * address and renders whatever main decided, on the same `.notice` line. It
 * validates nothing itself and it opens nothing itself — the browser is main's,
 * and a renderer's word is never a permission.
 */
describe('opening a link inside a bubble', () => {
  const WITH_LINK = HELD_DWARF
  // AMENDED for #436: same rows, now through the feed rather than the dwarf.
  const LINK_FEED = heldFeedStub([
    {
      role: 'assistant' as const,
      text: 'see [the issue](https://example.test/347)',
      timestamp: 't0'
    }
  ])

  it('asks main with the exact address, not the words that carried it', async () => {
    const { wrapper, api } = await openOn([WITH_LINK], HELD_DWARF.id, {
      ...LINK_FEED,
      openExternalLink: vi.fn().mockResolvedValue({ opened: true })
    })

    await wrapper.find('.dm-bubble__text .markdown-link').trigger('click')
    await flushPromises()

    expect(api.openExternalLink).toHaveBeenCalledWith('https://example.test/347')
  })

  it("says out loud main's fixed refusal when the link could not be opened", async () => {
    const { wrapper } = await openOn([WITH_LINK], HELD_DWARF.id, {
      ...LINK_FEED,
      openExternalLink: vi
        .fn()
        .mockResolvedValue({ opened: false, reason: 'That link could not be opened.' })
    })

    await wrapper.find('.dm-bubble__text .markdown-link').trigger('click')
    await flushPromises()

    // AMENDED for #635 (was: the `.notice` line): a toast, as above.
    expect(toastTexts(wrapper)).toContain('That link could not be opened.')
  })

  it('says nothing when the browser took it', async () => {
    const { wrapper } = await openOn([WITH_LINK], HELD_DWARF.id, {
      ...LINK_FEED,
      openExternalLink: vi.fn().mockResolvedValue({ opened: true })
    })

    const before = toastTexts(wrapper).length
    await wrapper.find('.dm-bubble__text .markdown-link').trigger('click')
    await flushPromises()

    // No toast of its own: the queue is the window's, so what counts is what this press added.
    expect(toastTexts(wrapper)).toHaveLength(before)
  })
})

/**
 * Paging back through a conversation (#364), wired end to end: the panel
 * reports that the reader reached the top of what it holds, this window asks
 * main for the page before it, and the answer is drawn in front of the newest
 * page without the poll's own pushes ever erasing it.
 *
 * The two facts this block exists for are the ones the issue calls the hard
 * part: the accumulated pages are what the panel renders, and a push after
 * paging back is an ordinary push rather than a feed that lost forty rows.
 */
describe('paging back through the conversation (#364)', () => {
  const PAGED_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: '',
    textDelivery: 'terminal'
  }

  const NEWEST = [
    { role: 'assistant' as const, text: 'Halfway down the shaft', timestamp: 't2' },
    { role: 'assistant' as const, text: 'Seam exhausted', timestamp: 't3' }
  ]

  const OLDER = [
    { role: 'assistant' as const, text: 'Starting the shaft', timestamp: 't0' },
    { role: 'assistant' as const, text: 'Through the topsoil', timestamp: 't1' }
  ]

  /** The panel, open on an observed dwarf whose newest page has come back. */
  async function openPaged(overrides: Record<string, unknown> = {}) {
    return openOn([PAGED_DWARF], 'claude:s1', {
      getDwarfFeed: vi.fn().mockResolvedValue({ readable: true, messages: NEWEST }),
      ...overrides
    })
  }

  /** The reader running out of conversation at the top of the list. */
  async function scrollToTop(wrapper: VueWrapper) {
    const list = wrapper.find('.dm-msg__log')
    list.element.scrollTop = 0
    await list.trigger('scroll')
    await flushPromises()
  }

  function textsOf(wrapper: VueWrapper): string[] {
    return wrapper.findAll('.dm-bubble__text').map((bubble) => bubble.text())
  }

  it('asks main for the page before the oldest row it holds', async () => {
    const { wrapper, api } = await openPaged()

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      before: { timestamp: 't2', text: 'Halfway down the shaft' }
    })
  })

  it('draws the page in front of the newest one, oldest at the top', async () => {
    const { wrapper } = await openPaged({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })

    await scrollToTop(wrapper)

    expect(textsOf(wrapper)).toEqual([
      'Starting the shaft',
      'Through the topsoil',
      'Halfway down the shaft',
      'Seam exhausted'
    ])
  })

  it('asks for the page before the page it just drew, walking back one at a time', async () => {
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValueOnce({ readable: true, messages: OLDER, reachedStart: false })
      .mockResolvedValueOnce({
        readable: true,
        messages: [{ role: 'assistant', text: 'Arrived at the mine', timestamp: 't-1' }],
        reachedStart: true
      })
    const { wrapper } = await openPaged({ getDwarfFeedPage })

    await scrollToTop(wrapper)
    await scrollToTop(wrapper)

    expect(getDwarfFeedPage).toHaveBeenLastCalledWith({
      dwarfId: 'claude:s1',
      before: { timestamp: 't0', text: 'Starting the shaft' }
    })
    expect(textsOf(wrapper)[0]).toBe('Arrived at the mine')
  })

  it('says where the conversation begins, and asks for nothing more', async () => {
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: true })
    const { wrapper } = await openPaged({ getDwarfFeedPage })

    await scrollToTop(wrapper)
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain(CONVERSATION_START_NOTE)

    await scrollToTop(wrapper)
    expect(getDwarfFeedPage).toHaveBeenCalledTimes(1)
  })

  it('says a conversation cannot be paged in its own words, never as a beginning', async () => {
    const { wrapper } = await openPaged({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: false, messages: [], reachedStart: false })
    })

    await scrollToTop(wrapper)

    const note = wrapper.find('.dm-msg__log').attributes('title')
    expect(note).toContain(NO_OLDER_PAGES_NOTE)
    expect(note).not.toContain(CONVERSATION_START_NOTE)
  })

  it('says the transcript outran the read when the page comes back beyond reach', async () => {
    // The reader is not at the beginning and the panel must not say they are:
    // the file goes on past the window walk's own ceiling, and the rest of it
    // is only reachable in the session's own terminal.
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValue({ readable: true, messages: [], reachedStart: false })
    const { wrapper } = await openPaged({ getDwarfFeedPage })

    await scrollToTop(wrapper)

    const note = wrapper.find('.dm-msg__log').attributes('title')
    expect(note).toContain(BEYOND_REACH_NOTE)
    expect(note).not.toContain(CONVERSATION_START_NOTE)

    await scrollToTop(wrapper)
    expect(getDwarfFeedPage).toHaveBeenCalledTimes(1)
  })

  it('keeps every page the reader loaded when the poll pushes a fresh newest one', async () => {
    const { wrapper, api } = await openPaged({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(4)

    // The push the issue names as the hard part (#196): main re-read the
    // watched dwarf's feed on its own pass and carries the newest twelve with
    // the snapshot. Four pages of scrollback must not be the price of it.
    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...PAGED_DWARF, transcriptUpdatedAt: 1_000 }] }],
      tokensObserved: 0,
      watchedFeed: {
        dwarfId: 'claude:s1',
        feed: {
          readable: true,
          messages: [...NEWEST, { role: 'assistant', text: 'Packing up', timestamp: 't4' }]
        }
      }
    })
    await flushPromises()

    expect(textsOf(wrapper)).toEqual([
      'Starting the shaft',
      'Through the topsoil',
      'Halfway down the shaft',
      'Seam exhausted',
      'Packing up'
    ])
  })

  it('does not cry wolf about a shrinking feed on that push (#249)', async () => {
    // The warning is about the NEWEST page losing rows. Measured against the
    // drawn conversation it would fire on every push once somebody had paged
    // back — twelve pushed rows against forty-eight held ones — and a warning
    // that fires twice a second says nothing at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { wrapper, api } = await openPaged({
        getDwarfFeedPage: vi
          .fn()
          .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
      })
      await scrollToTop(wrapper)

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...PAGED_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0,
        watchedFeed: { dwarfId: 'claude:s1', feed: { readable: true, messages: NEWEST } }
      })
      await flushPromises()

      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('throws the pages away when the panel opens on another dwarf', async () => {
    const SECOND = { ...PAGED_DWARF, id: 'claude:s3', sessionId: 's3', name: 'Digger' }
    const getDwarfFeed = vi.fn((dwarfId: string) =>
      Promise.resolve({
        readable: true,
        messages:
          dwarfId === 'claude:s1'
            ? NEWEST
            : [{ role: 'assistant', text: 'Just arrived at the seam', timestamp: 'u0' }]
      })
    )
    const { wrapper } = await openOn([PAGED_DWARF, SECOND], 'claude:s1', {
      getDwarfFeed,
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(4)

    // AMENDED for #635 (was: a state pushed to the panel's own window): a click in the mine.
    await selectOn(wrapper, 'claude:s3')

    expect(textsOf(wrapper)).toEqual(['Just arrived at the seam'])
  })

  /*
   * AMENDED for #430 (was: 'never pages a held session, which carries its own
   * exchange first-hand', asserting the same call was never made). The claim
   * was reversed by the issue: a held Claude session is a Claude Code process
   * with the same transcript on disk, and it pages back through it like any
   * other. What survives is the ROW-level refusal, which is all HELD_DWARF can
   * exercise — its whole conversation is one turn of the person's, and the
   * transcript may not spell that turn the way this app holds it (see
   * `heldFeedPageCursorOf`). Nothing else in this test changed.
   */
  it('asks for nothing while a held conversation holds only the person’s own words', async () => {
    const { wrapper, api } = await openOn([HELD_DWARF], 'claude:s2')

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).not.toHaveBeenCalled()
  })
})

/**
 * ADDED for #430. A session this panel LAUNCHED pages back through its own
 * transcript, exactly as an observed one does since #364.
 *
 * The held exchange is the newest page — twelve things said, replaced whole by
 * every poll — and the pages read stand in front of it rather than being folded
 * into it, which is the same split the block above pins for an observed
 * session and the same reason: a reader four pages back must not lose them to
 * the session saying one more word.
 */
describe('paging back through a held conversation (#430)', () => {
  const HELD = [
    { role: 'user' as const, text: 'dig here', timestamp: 'h0' },
    { role: 'assistant' as const, text: 'Down the shaft', timestamp: 'h1' },
    { role: 'assistant' as const, text: 'Seam found', timestamp: 'h2' }
  ]

  /*
   * AMENDED for #436: this dwarf carried its own `conversation` field, which
   * is what named it "held" throughout this block. That field is gone — a
   * held session's rows come from `getDwarfFeed` now, marked `source: 'held'`
   * — so `openHeld` below stubs that feed by default, and the test that used
   * to update `conversation` on a push instead pushes a fresh WATCHED FEED,
   * which is how main actually keeps a held session live post-#436 (it writes
   * no transcript signal for the ordinary re-read watch to key on).
   */
  const HELD_PAGED_DWARF = {
    id: 'claude:s4',
    provider: 'claude',
    role: 'foreman',
    name: 'Launched',
    status: 'working',
    sessionId: 's4',
    lastMessage: '',
    textDelivery: 'held'
  }

  const OLDER = [
    { role: 'user' as const, text: 'start here', timestamp: 't0' },
    { role: 'assistant' as const, text: 'Arrived at the mine', timestamp: 't1' }
  ]

  async function openHeld(overrides: Record<string, unknown> = {}) {
    return openOn([HELD_PAGED_DWARF], 'claude:s4', { ...heldFeedStub(HELD), ...overrides })
  }

  async function scrollToTop(wrapper: VueWrapper) {
    const list = wrapper.find('.dm-msg__log')
    list.element.scrollTop = 0
    await list.trigger('scroll')
    await flushPromises()
  }

  function textsOf(wrapper: VueWrapper): string[] {
    return wrapper.findAll('.dm-bubble__text').map((bubble) => bubble.text())
  }

  it('asks main for the page before the oldest turn its agent took', async () => {
    const { wrapper, api } = await openHeld()

    await scrollToTop(wrapper)

    // Never the person's own row above it: the transcript's `user` record for a
    // send is not always this app's spelling of it, and a cursor the file does
    // not hold would come back as a conversation that had reached its start.
    expect(api.getDwarfFeedPage).toHaveBeenCalledWith({
      dwarfId: 'claude:s4',
      before: { timestamp: 'h1', text: 'Down the shaft' }
    })
  })

  it('draws the page in front of the held exchange, oldest at the top', async () => {
    const { wrapper } = await openHeld({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })

    await scrollToTop(wrapper)

    expect(textsOf(wrapper)).toEqual([
      'start here',
      'Arrived at the mine',
      'dig here',
      'Down the shaft',
      'Seam found'
    ])
  })

  it('asks for the page before the page it just drew, walking back one at a time', async () => {
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValueOnce({ readable: true, messages: OLDER, reachedStart: false })
      .mockResolvedValueOnce({ readable: true, messages: [], reachedStart: true })
    const { wrapper } = await openHeld({ getDwarfFeedPage })

    await scrollToTop(wrapper)
    await scrollToTop(wrapper)

    // Off the PAGE's own oldest row now, whichever half of the exchange it is:
    // every row of it came out of the transcript, so the ordinary rule applies.
    expect(getDwarfFeedPage).toHaveBeenLastCalledWith({
      dwarfId: 'claude:s4',
      before: { timestamp: 't0', text: 'start here' }
    })
  })

  it('keeps every page the reader loaded when the poll pushes a fresh exchange', async () => {
    const { wrapper, api } = await openHeld({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(5)

    // A held session's newest words arrive on the WATCHED FEED push now
    // (#436): main reads `Runtime.dwarfFeed` on its own pass because this
    // panel reported it as the watched dwarf, and replaces `selectedFeed`
    // whole with it — this is the push the issue names as the hard part for a
    // launched session, and the pages in front of it belong to the reader's
    // own scroll rather than to whatever the push carried.
    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...HELD_PAGED_DWARF, lastMessage: 'Packing up' }] }],
      tokensObserved: 0,
      watchedFeed: {
        dwarfId: 'claude:s4',
        feed: heldFeed([...HELD, { role: 'assistant', text: 'Packing up', timestamp: 'h3' }])
      }
    })
    await flushPromises()

    expect(textsOf(wrapper)).toEqual([
      'start here',
      'Arrived at the mine',
      'dig here',
      'Down the shaft',
      'Seam found',
      'Packing up'
    ])
  })

  it('says a held session cannot be paged in its own words when its provider says so', async () => {
    // The Antigravity case, decided where it belongs: the provider has no
    // transcript filed for this dwarf and answers null, main turns that into
    // `readable: false`, and the panel says the one sentence that is true. Not
    // the held/observed distinction, which is what refused it before.
    const { wrapper, api } = await openHeld({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: false, messages: [], reachedStart: false })
    })

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).toHaveBeenCalled()
    const note = wrapper.find('.dm-msg__log').attributes('title')
    expect(note).toContain(NO_OLDER_PAGES_NOTE)
    expect(note).not.toContain(CONVERSATION_START_NOTE)
  })
})

/*
 * REMOVED for #635, stated rather than passing unseen: the whole 'rising into place and settling
 * before the window goes' block (#389, #566: the surface held hidden until its window was shown,
 * the rise and the settle through the bounded runner, the settled report main's hide waited on,
 * reduced motion, a cut between two dwarfs, a reopen inside a leave, the withdrawn re-applies).
 * Every one of them was the second window's motion. The panel now moves as the dock's window slot
 * does, through the same runner: App.test.ts's 'App panel motion (#164)' asserts the slot opening
 * from its far side and closing toward the shell, what it holds replaced with a fade, a leave the
 * shrink waits on and a leave that never reports (#266); dockMotion.test.ts pins the timings.
 */

/**
 * Typography preferences (#370) — APPENDED, nothing above changed.
 *
 * REMOVED for #635, stated rather than passing unseen: 'adopts the stored faces on mount,
 * painting its own document root' and 'follows a change made in the shell, which is the only
 * window with Settings'. They held for a SECOND document; the panels are drawn in the shell's own
 * now, whose faces App.test.ts's typography cases assert.
 */
describe('typography preferences (#370)', () => {
  it('draws the Add Panel in the messaging face, the same one the bubbles use', async () => {
    // #370's own complaint: the launch panel was the one conversation surface
    // still on the Pixel UI face. Asserted through the class the stylesheet
    // hangs `var(--font-conversation)` on, because a `<style scoped>` block has
    // no import a test could read (see designTokens.test.ts, which pins the
    // declaration itself).
    //
    // AMENDED for #635 (was: `.add-panel` present, the class that stylesheet hung the face on).
    // The redesigned panel's prompt is the design's field area, drawn in the Messages role, which
    // designTokens.test.ts pins on the field and on the panel's Jev card.
    const { wrapper } = await mountPanel({ surface: 'launch', mineId: MINE.id, dwarfId: '' })
    expect(wrapper.find('.dm-add .dm-field--area textarea').exists()).toBe(true)
  })
})

/*
 * REMOVED for #635, stated rather than passing unseen: 'MessagePanelWindow MotionConfig root
 * (#566 T3)', the second root's own `<MotionConfig>`. The panels are under the shell's root now,
 * whose MotionConfig cases in App.test.ts hold the same two answers.
 */

/*
 * APPENDED for #635, from a live run of the rebuilt Add panel: the three things it got wrong, read
 * through the whole shell and the real launch model rather than through the panel's props.
 */
describe('the rebuilt Add panel, as a person drives it (#635)', () => {
  const DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'Halfway down the shaft',
    // A dwarf the chat can write to, so its composer is what takes the keyboard on open.
    textDelivery: 'terminal'
  }

  /** The shell attached to the document, so focus is real, with the mine open from the map. */
  async function mountAttached(overrides: Record<string, unknown> = {}) {
    const host = document.createElement('div')
    document.body.append(host)
    const api = stubApi({
      getMines: vi
        .fn()
        .mockResolvedValue({ mines: [{ ...MINE, dwarfs: [DWARF] }], tokensObserved: 0 }),
      ...overrides
    })
    const wrapper = mount(App, { attachTo: host })
    mounted.push(wrapper)
    await flushPromises()
    wrapper.findComponent(MapPage).vm.$emit('open', MINE.id)
    await flushPromises()
    return { wrapper, api }
  }

  /** The mine column's "+ Dwarf", focused and pressed as a person presses it. */
  async function pressAddDwarf(wrapper: VueWrapper) {
    const add = wrapper.findComponent(MineColumn).get('.dm-minecol__foot button')
    ;(add.element as HTMLButtonElement).focus()
    await add.trigger('click')
    await flushPromises()
    return add.element
  }

  it('launches a custom command typed under Other…, with no Enter in its box', async () => {
    const launchHostedProcess = vi.fn().mockResolvedValue({ launched: true })
    const { wrapper } = await mountAttached({ launchHostedProcess })
    await pressAddDwarf(wrapper)

    await wrapper.findAll('.dm-add__chips .dm-chip')[1]!.trigger('click')
    await wrapper.get('.dm-add__command input').setValue('my-agent --yes')
    await wrapper.get('.dm-add__prompt textarea').setValue('dig the east gallery')
    expect(wrapper.get('.dm-add__why').text()).toBe(`Ready. The dwarf walks into ${MINE.name}.`)

    await wrapper
      .get('.dm-add__prompt textarea')
      .trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()

    expect(launchHostedProcess).toHaveBeenCalledWith({
      mineId: MINE.id,
      command: 'my-agent --yes',
      prompt: 'dig the east gallery'
    })
  })

  it('opens on its first control, and Esc gives the keyboard back to + Dwarf', async () => {
    const { wrapper } = await mountAttached()
    const opener = await pressAddDwarf(wrapper)

    expect(document.activeElement).toBe(wrapper.findAll('.dm-add__chips .dm-chip')[0]!.element)

    await wrapper.get('.dm-add').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('.dm-add').exists()).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('gives the keyboard back to the dwarf that opened its chat when the chat closes', async () => {
    const { wrapper } = await mountAttached()
    const dwarf = wrapper.get('button.dm-dwarf')
    ;(dwarf.element as HTMLButtonElement).focus()
    await dwarf.trigger('click')
    await flushPromises()
    expect(wrapper.find('.dm-msg').exists()).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('.dm-msg .dm-composer textarea').element)

    await wrapper.get('.dm-msg').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('.dm-msg').exists()).toBe(false)
    expect(document.activeElement).toBe(dwarf.element)
  })

  /*
   * From the live re-check: a dwarf takes no focus from a mouse press (`@mousedown.prevent`, so
   * the ring shows only for the keyboard), so the focused element at the press is not the opener.
   * The pressed dwarf is, and it takes the keyboard back without the keyboard's ring.
   */
  it('gives the keyboard back to a dwarf pressed with the mouse when its chat closes on ×', async () => {
    const { wrapper } = await mountAttached()
    const dwarf = wrapper.get('button.dm-dwarf')
    const focus = vi.spyOn(dwarf.element as HTMLButtonElement, 'focus')
    await dwarf.trigger('pointerdown')
    await dwarf.trigger('mousedown')
    await dwarf.trigger('click')
    await flushPromises()
    expect(wrapper.find('.dm-msg').exists()).toBe(true)

    const close = wrapper.get('.dm-msg__close')
    await close.trigger('pointerdown')
    await close.trigger('click')
    await flushPromises()

    expect(wrapper.find('.dm-msg').exists()).toBe(false)
    expect(document.activeElement).toBe(dwarf.element)
    expect(focus).toHaveBeenLastCalledWith({ focusVisible: false })
  })
})
