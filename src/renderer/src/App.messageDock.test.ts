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
import { useToasts } from './composables/useToasts'
import { TOAST_MS } from './lib/overlay/toast'
import { CONVERSATION_START_NOTE } from './lib/message/feedPages'
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
/** How the router answers a row with no route yet (ui-main/ipc/router.ts): a typed refusal, never a guess. */
const HOST_CONNECTION_UNROUTED = {
  ok: false,
  error: { code: 'METHOD_NOT_FOUND', message: 'no route', retryable: false }
}

/** A Host snapshot of the `tails` section with nothing said in it (ADDED for ISSUE-123). */
const EMPTY_HOST_TAILS = {
  ok: true,
  value: { snapshotId: 'snap-1', seq: 1, epoch: 'epoch-1', chunks: [] }
}

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
    onStopEverythingRequested: vi.fn().mockReturnValue(() => undefined),
    // The shell's own surfaces, answered as main answers them on a fresh install.
    // AMENDED for ISSUE-123 (was: today's `{ readable, speakers }`): A-19's target answer.
    getMineHistory: vi.fn().mockResolvedValue({
      ok: true,
      value: { mineId: '01890a5d-ac96-774b-bcce-b302099a0001', speakers: [] }
    }),
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
    // AMENDED for ISSUE-123 (was: `setOpenMine`): A-44 under its 14 name.
    reportVisibleMines: vi.fn(),
    onShowMine: vi.fn().mockReturnValue(() => undefined),
    // AMENDED for ISSUE-114 (was: absent): the shell also hears A-N16.
    onRevealDwarfChat: vi.fn().mockReturnValue(() => undefined),
    getNotificationsEnabled: vi.fn().mockResolvedValue(true),
    getJevSettings: vi.fn().mockResolvedValue({ ...DEFAULT_JEV_SETTINGS }),
    getOpenCodeSettings: vi
      .fn()
      .mockResolvedValue({ pluginEnabled: false, passwordConfigured: false }),
    setLaunchView: vi.fn(),
    // AMENDED for ISSUE-316 (was: absent): the Host connection rows, refused as an unrouted row is today.
    getHostConnection: vi.fn().mockResolvedValue(HOST_CONNECTION_UNROUTED),
    onHostConnection: vi.fn().mockReturnValue(() => undefined),
    retryHostConnection: vi.fn().mockResolvedValue(HOST_CONNECTION_UNROUTED),
    /*
     * AMENDED for ISSUE-123 (was: absent). The dock follows the Host's chats from mount (A-N02, then A-N01): the
     * snapshot answers a Host with nothing said for the `tails` section, so every chat is an empty conversation until a
     * test says otherwise, and refuses any other section, so the board stays on A-12/A-P2 in these tests.
     */
    onHostEvent: vi.fn().mockReturnValue(() => undefined),
    getHostSnapshot: vi.fn((params: { sections?: string[] } | undefined) =>
      Promise.resolve(
        params?.sections?.includes('tails') === true ? EMPTY_HOST_TAILS : HOST_CONNECTION_UNROUTED
      )
    ),
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

/**
 * The toasts a press raised, and only those. The queue is the window's one singleton, so another
 * toast (an earlier test's included) can be up when the press starts and can leave while it runs:
 * counting the queue would read that leaving as the press's doing. Each toast is drawn keyed by its
 * own id, so a toast the press raised is a card that was not on the page before it.
 */
async function toastsRaisedBy(wrapper: VueWrapper, press: () => Promise<void>): Promise<string[]> {
  const cards = () => wrapper.findAll('.dm-toast')
  const before = new Set(cards().map((toast) => toast.element))
  await press()
  return cards()
    .filter((toast) => !before.has(toast.element))
    .map((toast) => toast.text())
}

const LEAVING_TOAST = 'Raised by something else'

/**
 * A toast raised by something else, as an earlier test's can still be up in the window's one
 * queue, one millisecond from leaving: the returned function lets that millisecond pass, so the
 * toast leaves mid-press while any toast the press raised keeps nearly all of its 2.6s. The toast
 * clock is faked from here on; afterEach puts the real one back.
 */
async function raiseLeavingToast(wrapper: VueWrapper): Promise<() => void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  useToasts().showToast(LEAVING_TOAST)
  vi.advanceTimersByTime(TOAST_MS - 1)
  await flushPromises()
  expect(toastTexts(wrapper)).toContain(LEAVING_TOAST)
  return () => vi.advanceTimersByTime(1)
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

// AMENDED for ISSUE-123 (was: `heldFeed`, `heldFeedStub` and `HELD_EXCHANGE`, a held session's feed through A-14
// `getDwarfFeed`): the chat is the Host's, built with `hostChats` below.

/*
 * THE CHAT FROM THE HOST (ADDED for ISSUE-123). From the cut-1 switch the dock draws a dwarf's chat from the Host's
 * message log only: the snapshot `tails` section over A-N01 and the `conversation.appended` frames over A-N02 (14 §6.4
 * row `useDwarfMessaging`); A-14 `getDwarfFeed` and A-16 `setWatchedDwarf` are retired. A Host chat is keyed by a Host
 * `DwarfId` (a UUIDv7, which the snapshot schema checks), and from cut 1 the board names its dwarfs by the same ids
 * (`BoardFacadeAdapter`), so a case about the conversation opens a dwarf with one of the ids below.
 */
const HOST_DWARF_ID = '01890a5d-ac96-774b-bcce-b302099ad0b1'
const HOST_SECOND_ID = '01890a5d-ac96-774b-bcce-b302099ad0b2'
/** An observed dwarf the Host names (the board's facade carries Host ids from cut 1). */
const HOST_DWARF = { ...OBSERVED_DWARF, id: HOST_DWARF_ID, sessionId: HOST_DWARF_ID }
/** 2026-10-06T09:00:00.000Z, in epoch ms: the Host's own clock for rows a case does not date. */
const NINE = 1_791_277_200_000

let hostRowNo = 0
/** One Host row (14 §3.6 `MessageView`): the person's (`user`) or the dwarf's (`assistant`), dated `at`. */
function hostRow(
  dwarfId: string,
  role: 'user' | 'assistant',
  text: string,
  at: number = NINE + (hostRowNo + 1) * 60_000
) {
  hostRowNo += 1
  return {
    id: `01890a5d-ac96-774b-a000-${String(hostRowNo).padStart(12, '0')}`,
    dwarfId,
    role: role === 'user' ? 'person' : 'dwarf',
    text,
    attachments: [],
    providerTime: null,
    createdAt: at
  }
}

/**
 * The Host's chats as the dock reads them: A-N01 answers the `tails` section with `rows` per dwarf (and refuses any other
 * section, so the board stays on A-12/A-P2), and A-N02 is captured so `append` pushes `conversation.appended` frames,
 * each newer than the last.
 */
function hostChats(rows: Record<string, ReturnType<typeof hostRow>[]>) {
  const listeners = new Set<(frames: unknown[]) => void>()
  let seq = 1
  const overrides = {
    getHostSnapshot: vi.fn((params: { sections?: string[] } | undefined) =>
      Promise.resolve(
        params?.sections?.includes('tails') === true
          ? {
              ok: true,
              value: {
                snapshotId: 'snap-1',
                seq: 1,
                epoch: 'epoch-1',
                chunks: [
                  {
                    section: 'tails',
                    data: Object.entries(rows).map(([dwarfId, messages]) => ({
                      dwarfId,
                      messages,
                      reachedStart: false
                    }))
                  }
                ]
              }
            }
          : HOST_CONNECTION_UNROUTED
      )
    ),
    onHostEvent: vi.fn((listener: (frames: unknown[]) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
  }
  async function append(dwarfId: string, ...messages: ReturnType<typeof hostRow>[]) {
    seq += 1
    const frame = {
      type: 'evt',
      seq,
      epoch: 'epoch-1',
      name: 'conversation.appended',
      data: { dwarfId, messages }
    }
    for (const listener of listeners) listener([frame])
    await flushPromises()
  }
  return { overrides, append }
}

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
  vi.useRealTimers()
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

  // AMENDED for ISSUE-123 (was: read through A-14 `getDwarfFeed`, asserting that call): the chat is the Host's.
  it("reads an observed session's transcript, and shows what came back", async () => {
    const chats = hostChats({
      [HOST_DWARF_ID]: [hostRow(HOST_DWARF_ID, 'assistant', 'Blasting the last metre')]
    })
    const { wrapper, api } = await openOn([HOST_DWARF], HOST_DWARF_ID, chats.overrides)

    expect(api.getHostSnapshot).toHaveBeenCalledWith({ sections: ['tails'] })
    expect(api.getDwarfFeed).not.toHaveBeenCalled()
    expect(wrapper.find('.dm-bubble__text').text()).toBe('Blasting the last metre')
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('Latest activity')
  })

  /*
   * REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "asks main for a held session’s
   * exchange, and is told it is first-hand" (#436). The chat is the Host's from the cut-1 switch, and the Host's rows
   * carry no claim of having been held first-hand (14 §3.6 `MessageView`): a held session's chat reads as any other's.
   * Coverage of the read now lives in "reads an observed session's transcript, and shows what came back" above.
   */

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
  // AMENDED for ISSUE-123 (was: the words through A-14 `getDwarfFeed`): the chat is the Host's.
  it('keeps the panel on the last known dwarf when it walks out of the mine, and says so', async () => {
    const chats = hostChats({
      [HOST_DWARF_ID]: [hostRow(HOST_DWARF_ID, 'assistant', 'Blasting the last metre')]
    })
    const { wrapper, api } = await openOn(
      [{ ...HOST_DWARF, textDelivery: 'terminal' }],
      HOST_DWARF_ID,
      chats.overrides
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

  /*
   * #635, decision log, Copy alone on a closed session — APPENDED. A dwarf the board showed with a
   * channel for text that a later poll shows without one is a session whose delivery route went
   * away, not a session type with no channel yet: the store remembers who had one, and the panel
   * says the closed sentence in the well.
   */
  it('tells a delivery route that went away apart from a session type with no channel', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1'
    )
    const box = () => wrapper.find('.dm-composer textarea')
    expect(box().attributes('disabled')).toBeUndefined()

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [OBSERVED_DWARF] }], tokensObserved: 0 })
    await flushPromises()

    expect(box().attributes('disabled')).toBeDefined()
    expect(box().attributes('placeholder')).toBe('This session can no longer receive messages.')
    expect(wrapper.find('.dm-composer__hint').text()).not.toContain("can't receive messages yet")
  })

  it('keeps the no-channel refusal for a dwarf the board never showed with a channel', async () => {
    const { wrapper } = await openOn([OBSERVED_DWARF], 'claude:s1')
    const box = wrapper.find('.dm-composer textarea')
    expect(box.attributes('disabled')).toBeDefined()
    expect(box.attributes('placeholder')).not.toBe('This session can no longer receive messages.')
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

/*
 * REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): the whole 'opening an activity
 * line’s path' block (#279): "asks main with the current mine id and the exact target, not the display text", "says
 * out loud main's fixed refusal when the path could not be opened" and "says nothing when the file opened
 * successfully". The chat is the Host's from the cut-1 switch, and a Host row carries no activity step to press (14
 * §3.6 `MessageView`): an activity line is not clickable from cut 1 (owner answer 2026-10-07, recorded in
 * docs/strangler/parity-cut-1.md). A-20 itself is still pinned by `ipc-routing.contract.test.ts` ("[ADR-001] in cut 1
 * A-20 and A-30 are split between host and ui-local, and A-32 composes LegacyEndFirstAdapter") and the history's own
 * path press by App.test.ts.
 */

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
    // AMENDED for #635 (was: Enter on `.question-card`): the design card's Submit is its one send.
    await wrapper.findAll('.dm-qopt')[1]!.trigger('click')
    await wrapper.find('.dm-qcard__submit').trigger('click')
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
    // AMENDED for #635 (was: Enter, `.question-text` and `.answer-ok`): the design card's parts.
    await wrapper.findAll('.dm-qopt')[0]!.trigger('click')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    await flushPromises()

    expect(wrapper.find('.dm-qcard .dm-qcard__q').text()).toBe(
      'Which database should the importer write to?'
    )
    expect(wrapper.find('.dm-qcard__ok').exists()).toBe(true)
  })

  it('shows main’s reason when the answer was refused', async () => {
    const { wrapper } = await openAskingDwarf({
      answerDwarfQuestion: vi.fn().mockResolvedValue({
        answered: false,
        error: 'That session is not one this panel is holding.'
      })
    })
    // AMENDED for #635 (was: Enter and `.answer-error`): Submit, and the card's alert row.
    await wrapper.findAll('.dm-qopt')[0]!.trigger('click')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    await flushPromises()

    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: the reason in the card's alert row): the reason
    // is the ✕ mark's title on the "Answers:" record, and the card draws no alert.
    const record = wrapper.findAll('.dm-bubble').at(-1)!
    expect(record.find('.dm-bubble__text p').text()).toBe('Answers:')
    const mark = record.find('.dm-bubble__mark')
    const reason = wrapper.element.querySelector('#' + mark.attributes('aria-describedby'))
    expect(reason?.textContent).toBe('That session is not one this panel is holding.')
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
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
    // AMENDED for #635 (was: Enter in the always-open box): "Other thing…", then Submit.
    await wrapper.find('.dm-qopt--other').trigger('click')
    await wrapper.find('.dm-qopt-other-field input').setValue('put it in Redis')
    await wrapper.find('.dm-qcard__submit').trigger('click')
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
    // AMENDED for #635 (was: Enter in the box, and `.answer-error`): the design card's parts.
    await wrapper.find('.dm-qopt--other').trigger('click')
    await wrapper.find('.dm-qopt-other-field input').setValue('put it in Redis')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    await flushPromises()

    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: the reason in the card's alert row): the reason
    // is the ✕ mark's title on the "Answers:" record, and the card draws no alert.
    const record = wrapper.findAll('.dm-bubble').at(-1)!
    const mark = record.find('.dm-bubble__mark')
    const reason = wrapper.element.querySelector('#' + mark.attributes('aria-describedby'))
    expect(reason?.textContent).toContain('nothing was typed')
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
  })

  // ADDED for #635 (PO decision 2026-09-28, held free-text answers).
  it('answers a held ask in the person’s own words over the answer channel, marked as such', async () => {
    const { wrapper, api } = await openOn(
      [{ ...ASKING_DWARF, pendingQuestion: { ...PENDING_QUESTION, channel: 'held' } }],
      'claude:s1'
    )
    await wrapper.find('.dm-qopt--other').trigger('click')
    await wrapper.find('.dm-qopt-other-field input').setValue('keep the file store')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    await flushPromises()

    expect(api.answerDwarfQuestion).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: {},
      ownWords: { 'Which database should the importer write to?': 'keep the file store' }
    })
    expect(api.sendDwarfText).not.toHaveBeenCalled()
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
    // AMENDED for #635 (was: `.permission-card`, confirmed with Enter): the design card, its
    // request block, confirmed with Submit.
    expect(wrapper.find('.dm-qcard__req').exists()).toBe(true)

    await wrapper.findAll('.dm-qopt')[0]!.trigger('click')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    await flushPromises()

    expect(api.answerDwarfPermission).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_09',
      decision: 'allow'
    })
    // Only main's next snapshot may drop a pendingPermission — the panel's
    // part ends at handing the decision over.
    expect(wrapper.find('.dm-qcard__req').exists()).toBe(true)
  })
})

/*
 * REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): the whole 'feed refresh (#183)'
 * block with its 'adopting a pushed feed (#196)' half, fifteen cases: the re-read after the panel's own send, none
 * after a failed one, a held session's re-read, a dropped refresh once the panel moved, the re-reads on the
 * transcript-movement signal, on an ordinary poll, on a dwarf turning leaving, the previous feed kept while a re-read
 * is in flight, the blank on a switch, the pushed feed adopted, the first pull, a push for another dwarf, the pull with
 * no push, and A-16 telling main which dwarf is watched (observed and held). A-14 `getDwarfFeed` and A-16
 * `setWatchedDwarf` are retired by the cut-1 switch (21 §2 cut 1; 14 §6.4 row `useDwarfMessaging`: no watched feed, no
 * manual refresh): the chat is a read model of the Host's frames, with nothing to ask for. Coverage now lives in 'the
 * chat from the Host (ISSUE-123)' below and in `useDwarfMessaging.test.ts` 'useDwarfMessaging chat from the Host read
 * model'.
 */
describe('the chat from the Host (ISSUE-123)', () => {
  it('[ADR-033] the chat draws the Host’s rows for the open dwarf and follows each conversation.appended frame, with no feed read', async () => {
    const chats = hostChats({
      [HOST_DWARF_ID]: [hostRow(HOST_DWARF_ID, 'assistant', 'Halfway down the shaft')]
    })
    const { wrapper, api } = await openOn([HOST_DWARF], HOST_DWARF_ID, chats.overrides)
    const texts = () => wrapper.findAll('.dm-bubble__text').map((bubble) => bubble.text())
    expect(texts()).toEqual(['Halfway down the shaft'])

    await chats.append(HOST_DWARF_ID, hostRow(HOST_DWARF_ID, 'assistant', 'Seam exhausted'))
    expect(texts()).toEqual(['Halfway down the shaft', 'Seam exhausted'])
    expect(api.getDwarfFeed).not.toHaveBeenCalled()
    expect(api.setWatchedDwarf).not.toHaveBeenCalled()
    expect(api.refreshDwarfTelemetry).not.toHaveBeenCalled()
  })

  it('[ADR-033] a delivered send asks main for nothing more: the words the session took arrive as Host frames', async () => {
    const chats = hostChats({ [HOST_DWARF_ID]: [] })
    const { wrapper, api } = await openOn(
      [{ ...HOST_DWARF, textDelivery: 'terminal' }],
      HOST_DWARF_ID,
      chats.overrides
    )
    const snapshotReads = api.getHostSnapshot.mock.calls.length
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.sendDwarfText).toHaveBeenCalledOnce()
    expect(api.getHostSnapshot.mock.calls.length).toBe(snapshotReads)
    expect(api.getDwarfFeed).not.toHaveBeenCalled()
  })

  it('[ADR-033] a switch to another dwarf draws that dwarf’s chat at once, from the same read model', async () => {
    const SECOND = { ...HOST_DWARF, id: HOST_SECOND_ID, sessionId: HOST_SECOND_ID, name: 'Digger' }
    const chats = hostChats({
      [HOST_DWARF_ID]: [hostRow(HOST_DWARF_ID, 'assistant', 'Halfway down the shaft')],
      [HOST_SECOND_ID]: [hostRow(HOST_SECOND_ID, 'assistant', 'Just arrived at the seam')]
    })
    const { wrapper } = await openOn([HOST_DWARF, SECOND], HOST_DWARF_ID, chats.overrides)

    await selectOn(wrapper, HOST_SECOND_ID)

    expect(wrapper.findAll('.dm-bubble__text').map((bubble) => bubble.text())).toEqual([
      'Just arrived at the seam'
    ])
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
  // AMENDED for ISSUE-123 (was: the launched session's exchange through A-14 `getDwarfFeed`): the chat is the Host's,
  // so the launched dwarf carries a Host id and its first words are the Host's row of them.
  it('shows the first message exactly once after the transition', async () => {
    const chats = hostChats({
      [HOST_DWARF_ID]: [hostRow(HOST_DWARF_ID, 'user', 'dig the east gallery')]
    })
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 }),
      ...chats.overrides
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, {
      mines: [
        {
          ...MINE,
          dwarfs: [
            {
              ...launchedDwarf('dig the east gallery'),
              id: HOST_DWARF_ID,
              sessionId: HOST_DWARF_ID
            }
          ]
        }
      ],
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
   *
   * AMENDED for #635 (MESSAGE-QUESTIONS 14/16/17; was: a push with no
   * `cause`, and the CLI's stderr on the line as an alert). The push always
   * names its cause now, and the panel says it as the launch-failure notice.
   */
  it('returns to the composer with the notice naming the cause when the launch fails after it started', async () => {
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
      stderrTail: 'codex: another instance is already running',
      cause: 'exited-at-once'
    })
    await flushPromises()

    expect(wrapper.get('.dm-add__fail[role="alert"] .dm-add__fail-title').text()).toBe(
      'Codex stopped as soon as it started'
    )
    expect(wrapper.find('.dm-add__why').text()).toBe('The dwarf did not go in.')
    // The composer is back, prompt intact, so a retry costs one click.
    expect(wrapper.find<HTMLTextAreaElement>(PROMPT).element.value).toBe('dig the east gallery')
  })

  /*
   * #635: the notice's Retry reaches the launch again through this window, once per press — the
   * panel emits, and App is what hands the press to the launch composable.
   */
  it('sends the same launch again when the notice’s Retry is pressed', async () => {
    const { wrapper, api } = await openAddPanel({
      launchHeldSession: vi.fn().mockResolvedValue({ launched: false, cause: 'not-installed' })
    })

    await submitPrompt(wrapper, 'dig the east gallery')
    expect(wrapper.get('.dm-add__fail-title').text()).toBe('Claude is not installed')

    await wrapper.get('.dm-add__fail-retry').trigger('click')
    await flushPromises()

    expect(api.launchHeldSession).toHaveBeenCalledTimes(2)
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

  /*
   * AMENDED for #635 (decision log, Failed delivery; was: 'sends a failed message again from its
   * own bubble, and keeps the failed one marked', whose markers read ['✕', '✓'] across two
   * bubbles, #309). Retry re-sends the same text in place: one bubble, now ✓, and its buttons gone.
   */
  it('sends a failed message again from its own bubble, in place, with no second bubble', async () => {
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
    expect(markers.map((marker) => marker.text())).toEqual(['✓'])
    expect(wrapper.findAll('.dm-bubble--user')).toHaveLength(1)
    expect(wrapper.find('.dm-bubble__actions').exists()).toBe(false)
  })

  /* #635, decision log, Failed delivery — APPENDED: a second failure brings ✕ and both back. */
  it('brings the ✕ and its two buttons back on the same bubble when the retry fails too', async () => {
    const sendDwarfText = vi
      .fn()
      .mockResolvedValue({ delivered: false, via: 'terminal', error: 'nope' })
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', { sendDwarfText })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()
    await wrapper.find('.dm-bubble__actions .dm-btn').trigger('click')
    await flushPromises()

    expect(sendDwarfText).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.dm-bubble__mark').map((marker) => marker.text())).toEqual([
      '✕ not delivered'
    ])
    expect(wrapper.findAll('.dm-bubble__actions .dm-btn').map((b) => b.text())).toEqual([
      'Retry',
      'Copy'
    ])
  })

  /*
   * #635, decision log, Failed delivery — APPENDED. Copy asks main to put the words on the
   * clipboard, exactly as written, and says "Message copied" only once main says it did.
   */
  it('copies a failed message through main and says so in a toast', async () => {
    const copyText = vi.fn().mockResolvedValue({ copied: true })
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', {
      sendDwarfText: vi
        .fn()
        .mockResolvedValue({ delivered: false, via: 'terminal', error: 'nope' }),
      copyText
    })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()
    await wrapper.findAll('.dm-bubble__actions .dm-btn')[1]!.trigger('click')
    await flushPromises()

    expect(copyText).toHaveBeenCalledWith('dig deeper')
    expect(toastTexts(wrapper)).toContain('Message copied')
  })

  it('claims no copy main did not make', async () => {
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', {
      sendDwarfText: vi
        .fn()
        .mockResolvedValue({ delivered: false, via: 'terminal', error: 'nope' }),
      copyText: vi.fn().mockResolvedValue({ copied: false })
    })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()
    // The toast queue is the window's one singleton, so an earlier test's toast can still be up:
    // what is asserted is that this press added none.
    const leaving = await raiseLeavingToast(wrapper)
    const raised = await toastsRaisedBy(wrapper, async () => {
      await wrapper.findAll('.dm-bubble__actions .dm-btn')[1]!.trigger('click')
      await flushPromises()
      leaving()
      await flushPromises()
    })

    expect(raised).toEqual([])
    expect(toastTexts(wrapper)).not.toContain(LEAVING_TOAST)
  })

  // AMENDED for ISSUE-123 (was: the transcript's row through a second A-14 `getDwarfFeed` read after the send): the
  // Host's row arrives as a `conversation.appended` frame. At cut 1 the send is today's (A-23 `legacy`), so the Host
  // knows the words only once it observes them, and the echo stands until then (docs/strangler/parity-cut-1.md).
  it('shows the words once, not twice, when the transcript catches up', async () => {
    // The reconciliation (#309): a `user` turn with the same words, stamped
    // after the send, IS this message — so the feed's row replaces the echo
    // rather than standing beside it.
    const chats = hostChats({ [HOST_DWARF_ID]: [] })
    const { wrapper } = await openOn(
      [{ ...ECHO_DWARF, id: HOST_DWARF_ID, sessionId: HOST_DWARF_ID }],
      HOST_DWARF_ID,
      chats.overrides
    )

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()
    await chats.append(
      HOST_DWARF_ID,
      hostRow(HOST_DWARF_ID, 'user', 'dig deeper', Date.now() + 1_000)
    )

    const bubbles = wrapper.findAll('.dm-bubble--user .dm-bubble__text')
    expect(bubbles.map((bubble) => bubble.text())).toEqual(['dig deeper'])
    // The row that survived is the transcript's, which carries no verdict of
    // its own: the session HAS the message now. AMENDED for #635 (was: no mark
    // at all): it wears the record's mark, handed over and nothing seen yet.
    expect(wrapper.find('.dm-bubble__mark').attributes('data-mark')).toBe('delivered')
  })

  // AMENDED for ISSUE-123 (was: the older turn through A-14 `getDwarfFeed`): it is the Host's row.
  it('keeps the echo when the transcript carries an older turn with the same words', async () => {
    // The near miss: the person said this before, the transcript already had
    // it, and saying it again is exactly why there is an echo.
    const chats = hostChats({
      [HOST_DWARF_ID]: [hostRow(HOST_DWARF_ID, 'user', 'dig deeper', Date.now() - 60_000)]
    })
    const { wrapper } = await openOn(
      [{ ...ECHO_DWARF, id: HOST_DWARF_ID, sessionId: HOST_DWARF_ID }],
      HOST_DWARF_ID,
      chats.overrides
    )

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
  // AMENDED for ISSUE-123 (was: a held dwarf, its row through A-14 `getDwarfFeed`): the same row, from the Host.
  const WITH_LINK = HOST_DWARF
  const HELD_DWARF = HOST_DWARF
  const LINK_FEED = hostChats({
    [HOST_DWARF_ID]: [
      hostRow(HOST_DWARF_ID, 'assistant', 'see [the issue](https://example.test/347)')
    ]
  }).overrides

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

    const leaving = await raiseLeavingToast(wrapper)
    const raised = await toastsRaisedBy(wrapper, async () => {
      await wrapper.find('.dm-bubble__text .markdown-link').trigger('click')
      await flushPromises()
      leaving()
      await flushPromises()
    })

    // No toast of its own: the queue is the window's, so what counts is what this press added.
    expect(raised).toEqual([])
    expect(toastTexts(wrapper)).not.toContain(LEAVING_TOAST)
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
  /*
   * AMENDED for ISSUE-123 throughout this block (was: the newest page through A-14 `getDwarfFeed`, the older ones
   * through A-15 in today's shape, cursored by a row's time and words, and the poll's watched-feed push): the chat is the
   * Host's, and A-15 pages the Host's message log in its target shape, `{ dwarfId, page: { before, limit } }`, cursored
   * by the oldest Host row held. Three cases went, stated in docs/test-removals.md: "says a conversation cannot be
   * paged in its own words, never as a beginning" and "says the transcript outran the read when the page comes back
   * beyond reach" (the Host's log holds at most 50 rows per dwarf, PO #87, so no page is unreadable or beyond reach),
   * and "does not cry wolf about a shrinking feed on that push (#249)" (the shrink warning went with the replaced
   * feed it measured).
   */
  const PAGED_DWARF = HOST_DWARF

  /** The Host's rows for the open dwarf (the newest) and one page older than them, oldest first. */
  function rows() {
    const newest = [
      hostRow(HOST_DWARF_ID, 'assistant', 'Halfway down the shaft', NINE + 2 * 60_000),
      hostRow(HOST_DWARF_ID, 'assistant', 'Seam exhausted', NINE + 3 * 60_000)
    ]
    const older = [
      hostRow(HOST_DWARF_ID, 'assistant', 'Starting the shaft', NINE),
      hostRow(HOST_DWARF_ID, 'assistant', 'Through the topsoil', NINE + 60_000)
    ]
    return { newest, older }
  }

  /** A-15's answer: one page of the Host's log. */
  function page(messages: unknown[], reachedStart: boolean) {
    return { ok: true, value: { dwarfId: HOST_DWARF_ID, messages, reachedStart } }
  }

  /** The panel, open on an observed dwarf whose newest rows the Host fed. */
  async function openPaged(newest: unknown[], overrides: Record<string, unknown> = {}) {
    const chats = hostChats({ [HOST_DWARF_ID]: newest as ReturnType<typeof hostRow>[] })
    const opened = await openOn([PAGED_DWARF], HOST_DWARF_ID, { ...chats.overrides, ...overrides })
    return { ...opened, chats }
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
    const { newest } = rows()
    const { wrapper, api } = await openPaged(newest)

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).toHaveBeenCalledWith({
      dwarfId: HOST_DWARF_ID,
      page: { before: newest[0]!.id, limit: 50 }
    })
  })

  it('draws the page in front of the newest one, oldest at the top', async () => {
    const { newest, older } = rows()
    const { wrapper } = await openPaged(newest, {
      getDwarfFeedPage: vi.fn().mockResolvedValue(page(older, false))
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
    const { newest, older } = rows()
    const first = hostRow(HOST_DWARF_ID, 'assistant', 'Arrived at the mine', NINE - 60_000)
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValueOnce(page(older, false))
      .mockResolvedValueOnce(page([first], true))
    const { wrapper } = await openPaged(newest, { getDwarfFeedPage })

    await scrollToTop(wrapper)
    await scrollToTop(wrapper)

    expect(getDwarfFeedPage).toHaveBeenLastCalledWith({
      dwarfId: HOST_DWARF_ID,
      page: { before: older[0]!.id, limit: 50 }
    })
    expect(textsOf(wrapper)[0]).toBe('Arrived at the mine')
  })

  it('says where the conversation begins, and asks for nothing more', async () => {
    const { newest, older } = rows()
    const getDwarfFeedPage = vi.fn().mockResolvedValue(page(older, true))
    const { wrapper } = await openPaged(newest, { getDwarfFeedPage })

    await scrollToTop(wrapper)
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain(CONVERSATION_START_NOTE)

    await scrollToTop(wrapper)
    expect(getDwarfFeedPage).toHaveBeenCalledTimes(1)
  })

  it('keeps every page the reader loaded when the poll pushes a fresh newest one', async () => {
    const { newest, older } = rows()
    const { wrapper, chats } = await openPaged(newest, {
      getDwarfFeedPage: vi.fn().mockResolvedValue(page(older, false))
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(4)

    // The session says one more thing: a Host frame. Four pages of scrollback must not be the price of it.
    await chats.append(HOST_DWARF_ID, hostRow(HOST_DWARF_ID, 'assistant', 'Packing up'))

    expect(textsOf(wrapper)).toEqual([
      'Starting the shaft',
      'Through the topsoil',
      'Halfway down the shaft',
      'Seam exhausted',
      'Packing up'
    ])
  })

  it('throws the pages away when the panel opens on another dwarf', async () => {
    const { newest, older } = rows()
    const SECOND = { ...PAGED_DWARF, id: HOST_SECOND_ID, sessionId: HOST_SECOND_ID, name: 'Digger' }
    const chats = hostChats({
      [HOST_DWARF_ID]: newest,
      [HOST_SECOND_ID]: [hostRow(HOST_SECOND_ID, 'assistant', 'Just arrived at the seam')]
    })
    const { wrapper } = await openOn([PAGED_DWARF, SECOND], HOST_DWARF_ID, {
      ...chats.overrides,
      getDwarfFeedPage: vi.fn().mockResolvedValue(page(older, false))
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(4)

    // AMENDED for #635 (was: a state pushed to the panel's own window): a click in the mine.
    await selectOn(wrapper, HOST_SECOND_ID)

    expect(textsOf(wrapper)).toEqual(['Just arrived at the seam'])
  })

  /*
   * AMENDED for #430 (was: 'never pages a held session, which carries its own
   * exchange first-hand', asserting the same call was never made). AMENDED for ISSUE-123: a chat the Host holds no row
   * for has nothing to page before, whatever kind of session it is.
   */
  it('asks for nothing while a held conversation holds only the person’s own words', async () => {
    const { wrapper, api } = await openOn([HELD_DWARF], 'claude:s2')

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).not.toHaveBeenCalled()
  })
})

/*
 * REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): the whole 'paging back through a
 * held conversation (#430)' block, five cases: "asks main for the page before the oldest turn its agent took", "draws
 * the page in front of the held exchange, oldest at the top", "asks for the page before the page it just drew, walking
 * back one at a time", "keeps every page the reader loaded when the poll pushes a fresh exchange" and "says a held
 * session cannot be paged in its own words when its provider says so". They pinned which of a held exchange's rows a
 * transcript cursor may hang off (`heldFeedPageCursorOf`) and the held feed's push; from the cut-1 switch every chat
 * is the Host's log, paged by the Host's own row ids, so a held conversation pages as 'paging back through the
 * conversation (#364)' above pins.
 */

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

/*
 * ISSUE-316: the Host connection in the shell (ADR-002 D9; 07 §12B; 13 FM-146). The rows are scripted here as the
 * cut-0 switch will route them: A-N03 answers connected, and the test pushes A-N04.
 */
describe('the Host connection in the shell', () => {
  const connected = { state: 'connected', hostVersion: '1.0.0', compat: false, capabilities: [] }

  function hostRows(): {
    overrides: Record<string, unknown>
    push: (view: unknown) => Promise<void>
  } {
    let listener: ((view: unknown) => void) | null = null
    return {
      overrides: {
        getHostConnection: vi.fn().mockResolvedValue(connected),
        onHostConnection: vi.fn((next: (view: unknown) => void) => {
          listener = next
          return () => undefined
        }),
        retryHostConnection: vi.fn().mockResolvedValue({ state: 'connecting' })
      },
      async push(view) {
        expect(listener, 'the shell follows onHostConnection').toBeTypeOf('function')
        listener!(view)
        await flushPromises()
      }
    }
  }

  it('[ADR-002, S12.B06] shows the crash-loop message over the Panel and its Retry asks main once', async () => {
    const rows = hostRows()
    const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1', rows.overrides)
    expect(wrapper.find('.dm-host-state').exists()).toBe(false)

    // No toast says anything about the Host, whatever an earlier test left in the window's queue.
    const raised = await toastsRaisedBy(wrapper, () =>
      rows.push({ state: 'unavailable', reason: 'crash-loop' })
    )
    expect(raised).toEqual([])
    // AMENDED for the owner's design ruling of 2026-10-02 (was: `.dm-host-state` and its button inside the App's own
    // element): the message with its Retry is the design's dialog in <body>, so it is read from the document; the
    // expectations are unchanged.
    const message = document.body.querySelector<HTMLElement>('[role="dialog"] .dm-host-state')!
    expect(message.getAttribute('role')).toBe('alert')
    expect(message.textContent).toContain('⟦COPY NEEDED: O-15 crash-loop variant⟧')
    document.body.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click()
    await flushPromises()
    expect(api.retryHostConnection).toHaveBeenCalledOnce()
    // The dwarf of the last snapshot stays.
    expect(wrapper.find('.dm-msg').exists()).toBe(true)

    await rows.push(connected)
    expect(document.body.querySelector('.dm-host-state')).toBeNull()
  })

  // Owner's ruling (2026-10-02): a Host-state notice without an action is one toast, never a banner over the Panel.
  it('[ADR-002, FM-012] a connected Host in a job raises one toast and draws nothing over the Panel', async () => {
    const rows = hostRows()
    const { wrapper } = await openOn([OBSERVED_DWARF], 'claude:s1', rows.overrides)
    const inJob = { ...connected, jobStatus: 'in-job' }

    const raised = await toastsRaisedBy(wrapper, async () => {
      await rows.push(inJob)
      await rows.push(inJob)
    })
    expect(raised).toEqual(['⟦COPY NEEDED: O-4 in-job message⟧'])
    // No Host-state element anywhere, so none sits over the Panel's header or its controls.
    expect(document.body.querySelector('.dm-host-state')).toBeNull()
    expect(wrapper.find('.dm-host-state').exists()).toBe(false)
  })

  it('[FM-146, ADR-002] while reconnecting the composer keeps its draft and sends nothing', async () => {
    const rows = hostRows()
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1',
      rows.overrides
    )
    // A draft typed while connected; then the connection drops.
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await rows.push({ state: 'reconnecting', since: 1_000 })

    const box = wrapper.find('.dm-composer textarea')
    expect(box.attributes('disabled')).toBeDefined()
    await box.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.sendDwarfText).not.toHaveBeenCalled()
    expect((box.element as HTMLTextAreaElement).value).toBe('dig deeper')

    // Back on line, the same draft goes out.
    await rows.push(connected)
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.sendDwarfText).toHaveBeenCalledOnce()
  })

  // ADDED for the cut-0 conformance audit (06 INV-113 had no test): ISSUE-052 and ISSUE-316 keep drafts while the Host
  // is away; this is the lowest layer that holds them, the window's one store per dwarf (useMessageDock).
  it('[INV-113, FM-146] each dwarf keeps its own draft through reconnecting and a crash-loop, and no call to main carries it', async () => {
    const rows = hostRows()
    const second = {
      ...OBSERVED_DWARF,
      id: 'claude:s3',
      sessionId: 's3',
      name: 'Second',
      textDelivery: 'terminal'
    }
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }, second],
      'claude:s1',
      rows.overrides
    )
    const box = (): HTMLTextAreaElement =>
      wrapper.find('.dm-composer textarea').element as HTMLTextAreaElement
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')

    await rows.push({ state: 'reconnecting', since: 1_000 })
    await rows.push({ state: 'unavailable', reason: 'crash-loop' })
    // Another dwarf's chat while the Host is away, then back: each dwarf has its own draft.
    await selectOn(wrapper, 'claude:s3')
    expect(box().value).toBe('')
    await selectOn(wrapper, 'claude:s1')
    expect(box().value).toBe('dig deeper')

    await rows.push(connected)
    expect(box().value).toBe('dig deeper')
    // Never sent to the Host nor written anywhere through main: no window.api call carried the draft.
    const carried = Object.entries(api as Record<string, unknown>)
      .filter(
        ([, member]) =>
          vi.isMockFunction(member) && JSON.stringify(member.mock.calls).includes('dig deeper')
      )
      .map(([name]) => name)
    expect(carried).toEqual([])
  })

  it('[ADR-002] the incompatible message offers only Stop everything and quit, which sends A-N34 and never an upgrade request', async () => {
    const rows = hostRows()
    // UI main as A-N34 runs it: the tray's flow, which pushes A-N25 to the window (ui-main/ipc/handlers/stopEverything).
    let askConfirmation: ((payload: { confirmationId: string }) => void) | undefined
    const requestStopEverything = vi.fn(() =>
      askConfirmation?.({ confirmationId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' })
    )
    const confirmHostRestart = vi.fn().mockResolvedValue(connected)
    const { api } = await openOn([OBSERVED_DWARF], 'claude:s1', {
      ...rows.overrides,
      requestStopEverything,
      confirmHostRestart,
      onStopEverythingRequested: vi.fn((listener: typeof askConfirmation) => {
        askConfirmation = listener
        return () => undefined
      })
    })

    await rows.push({ state: 'unavailable', reason: 'incompatible' })
    // AMENDED for the owner's design ruling of 2026-10-02 (was: the action inside `.dm-host-state`, and no dialog
    // before it was pressed): the message is itself the design's dialog now, the only one on screen, and it steps
    // aside for ISSUE-317's confirmation, so one dialog is shown at a time.
    const dialogs = (): HTMLElement[] => [
      ...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')
    ]
    expect(dialogs()).toHaveLength(1)
    expect(dialogs()[0]!.querySelector('.dm-host-state')?.getAttribute('data-variant')).toBe(
      'incompatible'
    )
    const buttons = [...dialogs()[0]!.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      '⟦COPY NEEDED: O-3 Stop everything and quit action⟧'
    ])
    buttons[0]!.click()
    await flushPromises()

    expect(requestStopEverything).toHaveBeenCalledOnce()
    expect(confirmHostRestart).not.toHaveBeenCalled()
    expect(api.retryHostConnection).not.toHaveBeenCalled()
    // The confirmation that follows is ISSUE-317's, the same one the tray item shows, alone on screen.
    expect(dialogs()).toHaveLength(1)
    expect(dialogs()[0]!.querySelector('.dm-host-state')).toBeNull()
  })
})
