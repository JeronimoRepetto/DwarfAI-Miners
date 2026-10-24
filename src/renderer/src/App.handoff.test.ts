// @vitest-environment jsdom
import type { DwarfId, MineId, ModeTransition } from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../contracts/ipc/testing/fakeWindowApi'
import { publishBoard, type TestBoard } from './testing/board'
import { defaultDwarf } from './testing/factories'
import App from './App.vue'
import HistoryPanel from './components/history/HistoryPanel.vue'
import DwarfMessagePanel from './components/message/DwarfMessagePanel.vue'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { modeTransitionPart } from './composables/useModeTransition'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfPaging } from './composables/useDwarfPaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useDwarfStopping } from './composables/useDwarfStopping'
import { useMines } from './composables/useMines'
import { useView } from './composables/useView'
import {
  DEFAULT_AUDIO_PREFERENCES,
  DEFAULT_JEV_SETTINGS,
  DEFAULT_TYPOGRAPHY_PREFERENCES
} from './types'

/*
 * ISSUE-293 (07 S27.01, machine 9; UC-051; US-MSG-010.AC01, US-DLG-006.AC01, AC03): the Panel as the target of a run
 * that carries a chat from Veta. It lands on the dwarf's mine column with the chat open, the chat's draft, scroll
 * anchor and caret given back from the UI-main session store before its content shows. The shell is mounted over the
 * generated fake `window.api` with the members App.messageDock.test.ts's stub answers, copied whole.
 */

/** How the router answers a row with no route yet (ui-main/ipc/router.ts): a typed refusal, never a guess. */
const HOST_CONNECTION_UNROUTED = {
  ok: false,
  error: { code: 'METHOD_NOT_FOUND', message: 'no route', retryable: false }
}

/** The `LaunchId` A-35 answers in these cases (ADDED for ISSUE-001; 14 §1.6: a UUIDv7). */
const LAUNCH_ID = '01890a5d-ac96-774b-bcce-b302099a0c01'

/** A-23's 14 answer: accepted under a fresh `MessageId` (ADDED for ISSUE-001). */
let messages = 0
function accepted() {
  messages += 1
  return {
    ok: true,
    value: {
      ok: true,
      value: { messageId: `01890a5d-ac96-774b-bcce-${String(messages).padStart(12, '0')}` }
    }
  }
}

/** One A-36 entry (ADDED for ISSUE-001; 14 §3.6 `SupplierEntryView`): installed, launchable, no models. */
function supplier(providerId: string) {
  return {
    providerId,
    label: providerId,
    models: [],
    permissionModes: [],
    offeredModes: [],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available'
  }
}

/** A Host snapshot of the `tails` section with nothing said in it (ADDED for ISSUE-123). */
const EMPTY_HOST_TAILS = {
  ok: true,
  value: { snapshotId: 'snap-1', seq: 1, epoch: 'epoch-1', chunks: [] }
}

function stubApi(overrides: Record<string, unknown> = {}) {
  // AMENDED for ISSUE-242 (was: A-12 `getMines` and A-P2 `onMinesUpdated` among the members, deleted at cut 5): the
  // board is what the Host read model publishes (testing/board.ts), so a test's `board` is published, not installed.
  const { board = { mines: [MINE], tokensObserved: 0 }, ...memberOverrides } = overrides
  publishBoard(board as TestBoard, true)
  const api = {
    hidePanel: vi.fn(),
    raisePanel: vi.fn(),
    // The mine the panels open in, crewless: a test about a dwarf names its own crew.
    // The launch-failure push (#263), subscribed unconditionally on mount.
    // Answers "a window was focused", the verdict that leaves the panel alone. AMENDED for ISSUE-001 (was: today's
    // `DwarfActivation`): A-13's 14 answer, `IpcResult<ConsoleOpenResult>`.
    activateDwarf: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { outcome: 'raised', mode: 'focus-terminal' } }),
    // An observed session's transcript, read on selection (#159): readable and empty.
    // AMENDED for ISSUE-249 (was: also mocks of the RETIRE rows' members): A-14, A-16, A-17, A-18, A-P5, A-37 and
    // A-38 left the facade at cut 5 (`MEMBER_REMOVED`), and the fake refuses a member the registry does not have.
    // One page of scrollback (#364): readable, with nothing older.
    getDwarfFeedPage: vi
      .fn()
      .mockResolvedValue({ readable: true, messages: [], reachedStart: true }),
    // AMENDED for ISSUE-001 (was: today's `{ delivered, via }`): A-23's 14 answer.
    sendDwarfText: vi.fn(() => Promise.resolve(accepted())),
    // The verdict of a message main HELD (#457), subscribed unconditionally on mount.
    // AMENDED for ISSUE-183 (was: A-26 `kickDwarf`, which left the facade in 3a): "Stop dwarf…" is A-N29.
    stopDwarf: vi.fn().mockResolvedValue({ ok: true, value: { ok: true, value: {} } }),
    // AMENDED for ISSUE-141 (was: today's `{ answered: true }`): A-40/A-41 answer the 14 `IpcResult<AnswerOutcome>`.
    answerDwarfQuestion: vi.fn().mockResolvedValue({ ok: true, value: { kind: 'accepted' } }),
    answerDwarfPermission: vi.fn().mockResolvedValue({ ok: true, value: { kind: 'accepted' } }),
    // The launch surface (#86): Claude detected and launchable; a launch answers "started". AMENDED for ISSUE-001
    // (was: today's A-36 and A-38): A-36's 14 entries, and A-35 accepted under its `LaunchId`.
    listAgentProviders: vi.fn().mockResolvedValue({ ok: true, value: [supplier('claude')] }),
    launchAgent: vi.fn().mockResolvedValue({ ok: true, value: { launchId: LAUNCH_ID } }),
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
    getAudioPreferences: vi.fn().mockResolvedValue({ ...DEFAULT_AUDIO_PREFERENCES }),
    setAudioPreferences: vi.fn().mockImplementation((p: unknown) => Promise.resolve(p)),
    // Hidden, as main creates the window: nothing opens a media element jsdom cannot play.
    getPanelVisible: vi.fn().mockResolvedValue(false),
    onPanelVisibility: vi.fn().mockReturnValue(() => undefined),
    // AMENDED for ISSUE-123 (was: `setOpenMine`): A-44 under its 14 name.
    reportVisibleMines: vi.fn(),
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
    // AMENDED for ISSUE-001: from 3a the dock also follows the Host's `marks` and `launches`, empty here.
    getHostSnapshot: vi.fn((params: { sections?: string[] } | undefined) =>
      Promise.resolve(
        ['tails', 'marks', 'launches'].some(
          (section) => params?.sections?.includes(section) === true
        )
          ? EMPTY_HOST_TAILS
          : HOST_CONNECTION_UNROUTED
      )
    ),
    /*
     * AMENDED for ISSUE-138 (was: absent). The question read model follows the UI main session store's picks from
     * mount (A-N17…A-N19): an empty store, a patch spy and a subscription that releases. Its `asks` snapshot is refused
     * above, so the cards stay the board's in these tests. No existing assertion changed.
     */
    getUiSession: vi.fn().mockResolvedValue({
      drafts: {},
      chatViews: {},
      askPicks: {},
      openChat: {},
      currentMine: {},
      valle: {}
    }),
    patchUiSession: vi.fn(),
    onUiSessionChanged: vi.fn().mockReturnValue(() => undefined),
    ...memberOverrides
  }
  // AMENDED for ISSUE-250 (was: this hand-built object as `window.api`): installed through the generated fake (ADR-033
  // item 7), which refuses any member the channel registry lacks. Cast: the test data is typed looser than the contract.
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi(api as unknown as Partial<Window['api']>)
  })
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

const WORKER = defaultDwarf({ id: 'dwarf-handoff-1', name: 'Borin', textDelivery: 'terminal' })
const OTHER = defaultDwarf({ id: 'dwarf-handoff-2', name: 'Dain', textDelivery: 'terminal' })

let listener: ((t: ModeTransition) => void) | null = null

const mounted: VueWrapper[] = []

/** The shell, with UI main's session store holding what Veta flushed for the worker. */
async function mountShell(carried: string = WORKER.id): Promise<VueWrapper> {
  stubApi({
    board: { mines: [{ ...MINE, dwarfs: [WORKER, OTHER] }], tokensObserved: 0 },
    onModeTransition: (h: (t: ModeTransition) => void) => {
      listener = h
      return () => (listener = null)
    },
    modeTransitionDone: vi.fn(),
    getUiSession: vi.fn().mockResolvedValue({
      drafts: { [carried]: 'typed in Veta' },
      chatViews: {
        [carried]: {
          scrollAnchor: 'bottom',
          selection: { start: 2, end: 7, direction: 'backward' }
        }
      },
      askPicks: {},
      openChat: {},
      currentMine: {},
      valle: {}
    })
  })
  // The window's part of every run starts before the shell mounts, as main.ts starts it.
  modeTransitionPart()
  const wrapper = mount(App, { attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

/** UI main tells the Panel it is the target of a run from Veta carrying `dwarfId`'s chat. */
async function arriveWith(dwarfId: string, slot?: ModeTransition['slot']): Promise<void> {
  listener!({
    ...(slot === undefined ? {} : { slot }),
    transitionId: `run-${dwarfId}`,
    from: 'veta',
    to: 'panel',
    t0: Date.now() + 16,
    role: 'target',
    chat: { dwarfId: dwarfId as DwarfId, mineId: MINE.id as MineId }
  })
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
}

beforeEach(() => {
  useMines().clear()
  useView().clear()
  useDwarfPaging().clear()
  useDwarfMessaging().clearAll()
  useDwarfStopping().clearAll()
  useDwarfQuestion().clearAll()
  useAgentLaunch().close()
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  modeTransitionPart().dispose()
  listener = null
  Reflect.deleteProperty(window, 'api')
  document.body.innerHTML = ''
})

describe('the Panel landing a chat handed off from Veta (ISSUE-293)', () => {
  it("[US-MSG-010.AC01, US-DLG-006.AC01, US-DLG-006.AC03, S27.01] a run from Veta carrying a chat lands the Panel on that dwarf's mine column with the chat open, its draft and caret restored", async () => {
    const wrapper = await mountShell()
    expect(wrapper.findComponent(DwarfMessagePanel).exists()).toBe(false)

    await arriveWith(WORKER.id)
    // The mine is open and its chat is the carried dwarf's.
    expect(useView().state.mineId).toBe(MINE.id)
    const panel = wrapper.findComponent(DwarfMessagePanel)
    expect(panel.exists()).toBe(true)
    expect(panel.props('dwarf')).toMatchObject({ id: WORKER.id })
    // The draft and the caret Veta flushed show again.
    const field = panel.get('.dm-composer textarea').element as HTMLTextAreaElement
    expect(field.value).toBe('typed in Veta')
    expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([
      2,
      7,
      'backward'
    ])
    // A chat opened in the Panel has no hand-off tool (US-MSG-010.AC02).
    expect(panel.find('[data-open-in-panel]').exists()).toBe(false)
  })

  it('[S9.08, S27.11] a carried dwarf no longer on the board lands the Panel on its mine with no chat', async () => {
    const wrapper = await mountShell()
    await arriveWith('dwarf-handoff-gone')
    expect(useView().state.mineId).toBe(MINE.id)
    expect(wrapper.findComponent(DwarfMessagePanel).exists()).toBe(false)
  })

  // APPENDED for AMENDMENT-27 (owner, 2026-10-24): the run's slot.
  it("[US-DLG-006.AC02, S24.13, S27.01] a run from Veta carrying the history slot lands the Panel on that mine's history on the carried dwarf's tab, and that dwarf's chat opened afterwards shows the draft", async () => {
    // The carried dwarf is the second of the crew, so its tab is not the one the history opens on by default.
    const wrapper = await mountShell(OTHER.id)
    await arriveWith(OTHER.id, 'history')
    expect(useView().state.mineId).toBe(MINE.id)
    // The window slot holds the history, not the chat.
    expect(wrapper.findComponent(DwarfMessagePanel).exists()).toBe(false)
    const history = wrapper.findComponent(HistoryPanel)
    expect(history.exists()).toBe(true)
    // On this dwarf's tab (HistoryPanel.test.ts proves the tab an `openOn` names is the one open).
    expect(history.props('openOn')).toBe(OTHER.id)

    // The draft was kept for when that chat opens in the Panel.
    await wrapper.get(`button.dm-dwarf[data-dwarf="${OTHER.id}"]`).trigger('click')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushPromises()
    const panel = wrapper.findComponent(DwarfMessagePanel)
    expect(panel.props('dwarf')).toMatchObject({ id: OTHER.id })
    expect((panel.get('.dm-composer textarea').element as HTMLTextAreaElement).value).toBe(
      'typed in Veta'
    )
  })
})
