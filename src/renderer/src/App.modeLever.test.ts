// @vitest-environment jsdom
import type {
  MoveToModeParams,
  ModeTransition,
  UiPreferencesMap,
  UiPreferenceWrite
} from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../contracts/ipc/testing/fakeWindowApi'
import { publishBoard, type TestBoard } from './testing/board'
import { defaultDwarf } from './testing/factories'
import App from './App.vue'
import ValleApp from './components/valle/ValleApp.vue'
import { valleBridgeOf } from './components/valle/valleEntry'
import { VALLE_STORE_DEFAULTS } from './composables/useValleStores'
import { createFakeAudioPlayer } from './lib/audio/fakeAudioPlayer'
import { BORIN, MORIA, dwarfWire, mineWire, snapshotPage } from './lib/veta/testing/vetaFixtures'
import DwarfMessagePanel from './components/message/DwarfMessagePanel.vue'
import MapPage from './components/map/MapPage.vue'
import MineColumn from './components/scene/MineColumn.vue'
import {
  MODE_AT_LAUNCH_LABELS,
  modeAtLaunchOptions,
  SHIPPED_MODES
} from './lib/shell/builtDestinations'
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
 * ISSUE-294 (07 S10.04, S9.01; US-SHELL-001.AC02; US-SET-002.AC09; ADR-034 item 2; BR-19): the Panel's mode lever and
 * Settings › General "Mode at launch" in a build that ships the Panel and Veta. The shell is mounted over the generated
 * fake `window.api` with the members App.handoff.test.ts's stub answers, copied whole; UI main's `ModeCoordinator` is
 * played by the test (`moveToMode` tells the Panel it is a run's source and settles once the Panel answers), and UI
 * main's preference store by `getUiPreferences` / `setUiPreference`.
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

const WORKER = defaultDwarf({ id: 'dwarf-lever-1', name: 'Borin', textDelivery: 'terminal' })

/** UI main as these cases need it: the coordinator's runs and the stored UI preferences. */
interface UiMain {
  moves: MoveToModeParams[]
  writes: UiPreferenceWrite[]
  stored: Pick<UiPreferencesMap, 'lastMode' | 'modeAtLaunch'>
  patches: unknown[]
}

let listener: ((t: ModeTransition) => void) | null = null
const mounted: VueWrapper[] = []

/** The shell over a UI main that runs each move with the Panel as its source, writing lastMode once it lands. */
async function mountShell(
  board: { mines: unknown[]; tokensObserved: number } = {
    mines: [{ ...MINE, dwarfs: [WORKER] }],
    tokensObserved: 0
  }
): Promise<{ wrapper: VueWrapper; main: UiMain }> {
  const main: UiMain = {
    moves: [],
    writes: [],
    stored: { lastMode: 'panel', modeAtLaunch: 'last-used' },
    patches: []
  }
  const settling = new Map<string, () => void>()
  let runs = 0
  stubApi({
    board,
    onModeTransition: (h: (t: ModeTransition) => void) => {
      listener = h
      return () => (listener = null)
    },
    moveToMode: (p: MoveToModeParams) => {
      main.moves.push(p)
      runs += 1
      const transitionId = `run-${runs}`
      return new Promise((resolve) => {
        // S27.03: the run lands once the source answered, and only then is `lastMode` the target.
        settling.set(transitionId, () => {
          if (p.mode !== 'hidden') main.stored.lastMode = p.mode
          resolve({ ok: true, value: undefined })
        })
        listener!({
          transitionId,
          from: 'panel',
          to: p.mode,
          t0: Date.now(),
          role: 'source',
          ...(p.dwarfId !== undefined && p.mineId !== undefined
            ? { chat: { dwarfId: p.dwarfId, mineId: p.mineId } }
            : {})
        })
      })
    },
    modeTransitionDone: (p: { transitionId: string }) => settling.get(p.transitionId)?.(),
    patchUiSession: (patch: unknown) => void main.patches.push(patch),
    getUiPreferences: (request: { keys: string[] }) =>
      Promise.resolve(
        request.keys.includes('modeAtLaunch') ? { modeAtLaunch: main.stored.modeAtLaunch } : {}
      ),
    setUiPreference: (write: UiPreferenceWrite) => {
      main.writes.push(write)
      if (write.key === 'modeAtLaunch') main.stored.modeAtLaunch = write.value
      return Promise.resolve(write)
    },
    onUiPreferencesReset: () => () => undefined
  })
  // The window's part of every run starts before the shell mounts, as main.ts starts it.
  modeTransitionPart()
  const wrapper = mount(App, { attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, main }
}

/** The person opens the worker's chat: the mine on the map, then the dwarf in its column. */
async function openChat(wrapper: VueWrapper, mineId = MINE.id, dwarf = WORKER): Promise<void> {
  wrapper.findComponent(MapPage).vm.$emit('open', mineId)
  await flushPromises()
  wrapper.findComponent(MineColumn).vm.$emit('select', dwarf)
  await flushPromises()
}

/** Settings › General, as the nav and the tabs open it. */
async function openGeneral(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('.dm-nav .dm-slot[data-label="Settings"]').trigger('click')
  await flushPromises()
  await wrapper.get('[role="tab"][data-s="General"]').trigger('click')
  await flushPromises()
}

const realMatchMedia = window.matchMedia

beforeEach(() => {
  useMines().clear()
  useView().clear()
  useDwarfPaging().clear()
  useDwarfMessaging().clearAll()
  useDwarfStopping().clearAll()
  useDwarfQuestion().clearAll()
  useAgentLaunch().close()
  // Reduced motion: each half of a run lasts 0 ms, so the Panel answers at t0 (S27.06).
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {}
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  modeTransitionPart().dispose()
  listener = null
  window.matchMedia = realMatchMedia
  Reflect.deleteProperty(window, 'api')
  document.body.innerHTML = ''
})

describe('the Panel mode lever and Mode at launch (ISSUE-294)', () => {
  it('[US-SHELL-001.AC02, S10.04] ▼ Veta moves the app into Veta, an open chat rises once landed, and Veta becomes the last used mode', async () => {
    const { wrapper, main } = await mountShell()
    await openChat(wrapper)
    expect(wrapper.findComponent(DwarfMessagePanel).props('dwarf')).toMatchObject({ id: WORKER.id })
    await wrapper.get('.dm-composer textarea').setValue('half a thought')

    await wrapper.get('.dm-nav [aria-label="Mode"] .dm-slot[data-label="▼ Veta"]').trigger('click')
    await flushPromises()
    // The move is A-N13 to Veta carrying the open chat (S9.01), so Veta's strip raises it once landed (S24.18).
    expect(main.moves).toEqual([{ mode: 'veta', mineId: MINE.id, dwarfId: WORKER.id }])
    // As the run's source the Panel hands the chat over: its draft goes to the session store before t0.
    expect(main.patches).toContainEqual({
      kind: 'draft',
      dwarfId: WORKER.id,
      text: 'half a thought'
    })
    // The Panel answers its half; the run lands, and Veta is the mode last used.
    await vi.waitFor(() => expect(main.stored.lastMode).toBe('veta'))
    // lastMode is the ModeCoordinator's to write (14 §3.9): the Panel never writes it.
    expect(main.writes.filter((write) => write.key === 'lastMode')).toEqual([])
  })

  // AMENDED for ISSUE-311 (was: with Veta built the lever shows ▼ Veta alone and Mode at launch lists Last used, Panel and
  // Veta): once Valle ships every mode is shown (ADR-034 item 2; BR-19), "▲ Valle" above "▼ Veta" as the design draws it.
  it('[BR-19, ADR-034] with Valle built the lever shows ▲ Valle and ▼ Veta and Mode at launch lists Last used, Panel, Veta and Valle', async () => {
    const { wrapper } = await mountShell()
    const lever = wrapper.get('.dm-nav [aria-label="Mode"]')
    expect(lever.findAll('.dm-slot').map((slot) => slot.attributes('data-label'))).toEqual([
      '▲ Valle',
      '▼ Veta'
    ])
    // Never drawn disabled: a side of the lever is there and pressable, or absent (21 §1 item 8).
    expect(lever.findAll('[disabled], [aria-disabled="true"]')).toEqual([])

    await openGeneral(wrapper)
    const select = wrapper.get('.dm-settings__panel select[aria-label="Mode at launch"]')
    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'Last used',
      'Panel',
      'Veta',
      'Valle'
    ])
    expect((select.element as HTMLSelectElement).value).toBe('last-used')
  })

  it('[US-SET-002.AC09] picking a Mode at launch option stores that launch preference', async () => {
    const { wrapper, main } = await mountShell()
    await openGeneral(wrapper)
    const select = wrapper.get('.dm-settings__panel select[aria-label="Mode at launch"]')
    // A table over the modes this build ships, each pick stored and then shown as stored; "Last used" last, so the
    // stored value changes on every row.
    const picks = [
      ...modeAtLaunchOptions(SHIPPED_MODES).filter((option) => option !== 'last-used'),
      'last-used' as const
    ]
    for (const pick of picks) {
      await select.setValue(pick)
      await flushPromises()
      expect(main.writes.at(-1), MODE_AT_LAUNCH_LABELS[pick]).toEqual({
        key: 'modeAtLaunch',
        value: pick
      })
      expect(main.stored.modeAtLaunch).toBe(pick)
      expect((select.element as HTMLSelectElement).value).toBe(pick)
    }
    expect(main.writes).toHaveLength(picks.length)
  })
})

/*
 * ISSUE-311 (07 S10.04, S29.23, machine 9; US-SHELL-001.AC01; ADR-034 item 2): "▲ Valle" in a build that ships every
 * mode. The Panel is the run's source; the Valle window, its own renderer, is the target: it is mounted after the Panel
 * window went away, over a UI main whose session store holds what the Panel handed over.
 */

/** The climber, in Moria: the Host's ids, since the Valle window reads its mines and dwarfs from the Host's snapshot. */
const VALLE_MINE = { ...MINE, id: MORIA }
const CLIMBER = defaultDwarf({ id: BORIN, name: 'Borin', textDelivery: 'terminal' })

/** The Valle window as UI main loads it, over a session store holding `session`; answers its run listener. */
async function mountValleWindow(session: { drafts: Record<string, string> }): Promise<{
  valle: VueWrapper
  run(t: ModeTransition): void
  done: string[]
  writes: UiPreferenceWrite[]
}> {
  let heard: ((t: ModeTransition) => void) | null = null
  const done: string[] = []
  const writes: UiPreferenceWrite[] = []
  const api = createFakeWindowApi({
    onHostEvent: () => () => {},
    getHostSnapshot: () =>
      Promise.resolve(
        snapshotPage(10, {
          minesEverKnown: true,
          mines: [mineWire(MORIA)],
          dwarfs: [dwarfWire(BORIN, MORIA)]
        })
      ) as never,
    getUiSession: () =>
      Promise.resolve({
        drafts: session.drafts,
        chatViews: {},
        askPicks: {},
        openChat: {},
        currentMine: {},
        valle: {}
      }) as never,
    onModeTransition: (h) => {
      heard = h as (t: ModeTransition) => void
      return () => (heard = null)
    },
    modeTransitionDone: (p) => void done.push((p as { transitionId: string }).transitionId),
    setUiPreference: (write) => {
      writes.push(write as UiPreferenceWrite)
      return Promise.resolve(write) as never
    }
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  // The Valle window's part of every run starts before its root mounts, as main.ts starts it.
  modeTransitionPart()
  const valle = mount(ValleApp, {
    attachTo: document.body,
    props: {
      bridge: valleBridgeOf(api),
      stores: { ...VALLE_STORE_DEFAULTS, preset: 'control' },
      observer: () => ({ observe() {}, unobserve() {}, disconnect() {} }),
      bodyObserver: () => () => {},
      audioPlayer: createFakeAudioPlayer()
    }
  })
  mounted.push(valle)
  await flushPromises()
  return { valle, run: (t) => heard?.(t), done, writes }
}

describe('▲ Valle on the Panel lever (ISSUE-311)', () => {
  it("[US-SHELL-001.AC01, S10.04, S29.23] ▲ Valle moves into Valle, the chat in focus is pinned and focused in Valle's chat zone, and Valle becomes the last used mode", async () => {
    const { wrapper, main } = await mountShell({
      mines: [{ ...VALLE_MINE, dwarfs: [CLIMBER] }],
      tokensObserved: 0
    })
    await openChat(wrapper, VALLE_MINE.id, CLIMBER)
    await wrapper.get('.dm-composer textarea').setValue('half a thought')

    await wrapper.get('.dm-nav [aria-label="Mode"] .dm-slot[data-label="▲ Valle"]').trigger('click')
    await flushPromises()
    // The move is A-N13 to Valle carrying the chat in focus (S10.04, machine 9).
    expect(main.moves).toEqual([{ mode: 'valle', mineId: MORIA, dwarfId: BORIN }])
    // As the run's source the Panel hands the chat over: its draft goes to the session store before t0.
    expect(main.patches).toContainEqual({ kind: 'draft', dwarfId: BORIN, text: 'half a thought' })
    // The Panel answers its half; the run lands, and Valle is the mode last used, written by the ModeCoordinator alone.
    await vi.waitFor(() => expect(main.stored.lastMode).toBe('valle'))
    expect(main.writes.filter((write) => write.key === 'lastMode')).toEqual([])

    // The Valle window, the run's target: the carried chat lands in its chat zone, pinned and focused (S29.23), with the
    // draft the Panel handed over (machine 9).
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    modeTransitionPart().dispose()
    const drafts: Record<string, string> = {}
    for (const patch of main.patches as { kind: string; dwarfId?: string; text?: string }[]) {
      if (patch.kind === 'draft') drafts[patch.dwarfId!] = patch.text!
    }
    const { valle, run, done, writes } = await mountValleWindow({ drafts })
    run({
      transitionId: 'run-valle',
      from: 'panel',
      to: 'valle',
      t0: Date.now(),
      role: 'target',
      chat: { dwarfId: BORIN as never, mineId: MORIA as never }
    })
    await vi.waitFor(() => expect(done).toEqual(['run-valle']))
    await flushPromises()
    const open = valle.get('.dm-cstack__open')
    expect(open.attributes('data-pin')).toBe(BORIN)
    expect(
      (
        valle.get(`[data-valle-chat="${BORIN}"] .dm-composer textarea`)
          .element as HTMLTextAreaElement
      ).value
    ).toBe('half a thought')
    // Pinned, so persisted (S29.23); and Valle writes no lastMode either.
    expect(writes).toContainEqual({
      key: 'pins',
      value: [{ dwarfId: BORIN, mineId: MORIA, order: 0 }]
    })
    expect(writes.filter((write) => write.key === 'lastMode')).toEqual([])
  })
})
