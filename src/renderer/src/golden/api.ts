/*
 * The bridge the real App is mounted on in a full-screen golden (#635): main's side of every
 * `window.api` member, answered from the design's sample instead of a machine. Golden-only, like
 * everything under golden/: only the golden page imports it, and the product build never sees it.
 *
 * A full-screen reference starts from a first visit (docs/README.md, Comparing your build): no
 * remembered layout and every preference at its default, so each read answers what main answers
 * on a fresh install, and each preference write answers with the request, as main does when it
 * can store it. The sample decides only what it carries: the board, the projects, the edge, the
 * version, the guild flag, the shortcut's registration and the providers — and, since the PO's
 * ruling on PANEL-QUESTIONS 25, the view the app remembers it last closed on (`DM.data.launch`),
 * which is the one stored thing a reference does not start without: a state with no steps is the
 * sample's remembered launch.
 *
 * Anything a state could only reach by acting on the world (a launch, a send, a kick, a folder
 * picker) is refused with its name, never answered with a guess: a recipe that reaches it is one
 * this fake does not model yet, and the page's error list says so.
 */
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../shared/accelerator'
import {
  DEFAULT_AUDIO_PREFERENCES,
  DEFAULT_JEV_SETTINGS,
  DEFAULT_LAUNCH_VIEW,
  DEFAULT_NOTIFICATIONS_ENABLED,
  DEFAULT_OPENCODE_SETTINGS,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  MATERIALS,
  type MaterialTotals,
  type PanelLayout,
  type ProjectQuery,
  type ProjectSummary
} from '../types'
import type { GoldenSample } from './sample'

type Api = Window['api']

/** main's own default: the panel stays above other windows (pinPreference.ts, DEFAULT_PINNED). */
const PINNED = true

const refuse = (member: string) => (): Promise<never> =>
  Promise.reject(new Error('golden: the full-screen bridge does not answer ' + member))

const none = (): void => {}
const unsubscribe = (): (() => void) => none

// The vault is each material summed over the board on its own: tokens cross mines, never materials.
function vault(sample: GoldenSample): MaterialTotals {
  return Object.fromEntries(
    MATERIALS.map((m) => [
      m,
      sample.mines.reduce((sum, mine) => sum + (mine.materials?.[m] ?? 0), 0)
    ])
  ) as MaterialTotals
}

// The browse's one order (browseQuery.ts): last opened first, and the never opened after them.
function browse(sample: GoldenSample, query: ProjectQuery): ProjectSummary[] {
  if (query.sortBy !== 'lastOpenedAt' || query.direction !== 'desc') {
    throw new Error(
      'golden: the full-screen bridge browses only lastOpenedAt desc, not ' +
        query.sortBy +
        ' ' +
        query.direction
    )
  }
  const fragment = query.nameContains?.toLowerCase()
  const found = sample.projects
    .filter((p) => query.tier === undefined || p.knownTier === query.tier)
    .filter((p) => fragment === undefined || p.name.toLowerCase().includes(fragment))
    .sort((a, b) => (b.lastOpenedAt ?? -Infinity) - (a.lastOpenedAt ?? -Infinity))
  const offset = query.offset ?? 0
  return found.slice(offset, query.limit === undefined ? undefined : offset + query.limit)
}

export function goldenApi(sample: GoldenSample): Api {
  let layout: PanelLayout = { edge: sample.edge, mineOpen: false, dockOpen: false }
  const shortcut = {
    accelerator: DEFAULT_TOGGLE_ACCELERATOR,
    registered: !sample.config.shortcutFailed,
    platform: 'win32' as const
  }
  return {
    hidePanel: none,
    raisePanel: none,
    getAlwaysOnTop: () => Promise.resolve(PINNED),
    setAlwaysOnTop: (pinned) => Promise.resolve(pinned),
    getPanelVisible: () => Promise.resolve(true),
    onPanelVisibility: unsubscribe,
    getAudioPreferences: () => Promise.resolve({ ...DEFAULT_AUDIO_PREFERENCES }),
    setAudioPreferences: (preferences) => Promise.resolve(preferences),
    getPanelLayout: () => Promise.resolve({ ...layout }),
    setPanelLayout: (request) => {
      layout = {
        edge: request.edge ?? layout.edge,
        mineOpen: request.mineOpen,
        dockOpen: request.dockOpen
      }
      return Promise.resolve({ ...layout })
    },
    getToggleShortcut: () => Promise.resolve({ ...shortcut }),
    setToggleShortcut: refuse('setToggleShortcut'),
    getMines: () =>
      Promise.resolve({
        mines: sample.mines,
        tokensObserved: sample.mines.reduce((sum, m) => sum + m.tokensObserved, 0),
        materials: vault(sample)
      }),
    onMinesUpdated: unsubscribe,
    activateDwarf: refuse('activateDwarf'),
    // The open dwarf's conversation (#635, the MessagePanel slice), as the sample carries it.
    getDwarfFeed: (dwarfId) => {
      const feed = sample.feeds[dwarfId]
      return feed === undefined
        ? Promise.reject(new Error('golden: the sample carries no dwarf ' + dwarfId))
        : Promise.resolve(feed)
    },
    getDwarfFeedPage: refuse('getDwarfFeedPage'),
    setWatchedDwarf: none,
    refreshDwarfTelemetry: none,
    setDwarfTuning: refuse('setDwarfTuning'),
    // Dwarf names (#635): the golden stage renames nothing.
    setDwarfName: refuse('setDwarfName'),
    resetDwarfName: refuse('resetDwarfName'),
    // A-19 reads the Host's message log from the cut-1 switch (ISSUE-123), keyed by Host ids the sample does not carry:
    // a full-screen history state is one this fake does not model yet, and the page's error list says so.
    getMineHistory: refuse('getMineHistory'),
    openMinePath: refuse('openMinePath'),
    openExternalLink: refuse('openExternalLink'),
    copyText: refuse('copyText'),
    sendDwarfText: refuse('sendDwarfText'),
    onDwarfSendSettled: unsubscribe,
    pathForDroppedFile: () => '',
    chooseDwarfAttachments: refuse('chooseDwarfAttachments'),
    describeDwarfAttachments: refuse('describeDwarfAttachments'),
    kickDwarf: refuse('kickDwarf'),
    launchAgent: refuse('launchAgent'),
    onLaunchFailed: unsubscribe,
    listAgentProviders: () => Promise.resolve({ providers: sample.providers }),
    listAgentModels: () => Promise.resolve({ catalogs: sample.catalogs }),
    retireDwarf: none,
    getAppBuild: () => Promise.resolve({ version: sample.version ?? '', packaged: true }),
    getFeatureFlags: () => Promise.resolve({ guildAreasEnabled: sample.config.guildEnabled }),
    declareMine: refuse('declareMine'),
    declareMainProject: refuse('declareMainProject'),
    undeclareMine: refuse('undeclareMine'),
    resetMetrics: refuse('resetMetrics'),
    queryProjects: (query) => {
      try {
        return Promise.resolve({ answered: true, projects: browse(sample, query) })
      } catch (error) {
        return Promise.reject(error)
      }
    },
    launchHeldSession: refuse('launchHeldSession'),
    answerDwarfQuestion: refuse('answerDwarfQuestion'),
    answerDwarfPermission: refuse('answerDwarfPermission'),
    launchHostedProcess: refuse('launchHostedProcess'),
    getNotificationsEnabled: () => Promise.resolve(DEFAULT_NOTIFICATIONS_ENABLED),
    setNotificationsEnabled: (enabled) => Promise.resolve(enabled),
    // A-44 under its 14 name from the cut-1 switch (ISSUE-123): a golden reports no mine on screen to anyone.
    reportVisibleMines: none,
    onShowMine: unsubscribe,
    getTypographyPreferences: () => Promise.resolve({ ...DEFAULT_TYPOGRAPHY_PREFERENCES }),
    setTypographyPreferences: (preferences) => Promise.resolve(preferences),
    onTypographyPreferences: unsubscribe,
    getJevSettings: () => Promise.resolve({ ...DEFAULT_JEV_SETTINGS }),
    setJevApiKey: refuse('setJevApiKey'),
    clearJevApiKey: refuse('clearJevApiKey'),
    routeJevLaunch: refuse('routeJevLaunch'),
    setJevPreferences: (preferences) => Promise.resolve({ ...DEFAULT_JEV_SETTINGS, preferences }),
    getOpenCodeSettings: () => Promise.resolve({ ...DEFAULT_OPENCODE_SETTINGS }),
    setOpenCodePluginEnabled: (enabled) =>
      Promise.resolve({ ...DEFAULT_OPENCODE_SETTINGS, pluginEnabled: enabled }),
    setOpenCodeServerPassword: refuse('setOpenCodeServerPassword'),
    clearOpenCodeServerPassword: refuse('clearOpenCodeServerPassword'),
    // The sample's remembered launch (#635, PANEL-QUESTIONS 25): a state with no steps opens where
    // the references open. A reported view is taken and changes nothing: a golden never relaunches.
    getLaunchView: () => Promise.resolve({ ...(sample.launch ?? DEFAULT_LAUNCH_VIEW) }),
    setLaunchView: none,
    // A-N30: a golden renders a fixed sample, so a renderer diagnostic goes nowhere.
    reportRendererDiagnostic: none,
    // A-N25…A-N27: a golden has no tray, so no confirmation is ever asked for and nothing stops.
    onStopEverythingRequested: unsubscribe,
    confirmStopEverything: refuse('confirmStopEverything'),
    cancelStopEverything: none,
    // A-N34: a golden has no Host, so asking for Stop everything goes nowhere.
    requestStopEverything: none,
    // A-N03…A-N05, A-N33: a golden renders a fixed sample, never a Host connection, so these are not answered.
    getHostConnection: refuse('getHostConnection'),
    onHostConnection: unsubscribe,
    retryHostConnection: refuse('retryHostConnection'),
    confirmHostRestart: refuse('confirmHostRestart'),
    // A-N17…A-N19: a golden renders a fixed sample in one window, so its session store is empty and nothing changes it.
    getUiSession: () =>
      Promise.resolve({
        drafts: {},
        chatViews: {},
        askPicks: {},
        openChat: {},
        currentMine: {},
        valle: {}
      }),
    patchUiSession: none,
    onUiSessionChanged: unsubscribe,
    // A-N20, A-N21: a golden stores no UI preference, so none is answered and none is written.
    getUiPreferences: () => Promise.resolve({}),
    setUiPreference: refuse('setUiPreference'),
    // A-N12: a golden runs no Reset metrics, so no reset is ever pushed.
    onUiPreferencesReset: unsubscribe,
    // A-N01, A-N02: the board a golden draws is the sample's, not the Host's; no renderer reads the Host before the
    // cut-1 switch (ISSUE-092, ISSUE-123), so a snapshot request is refused by name and no Host frame ever arrives.
    getHostSnapshot: refuse('getHostSnapshot'),
    onHostEvent: unsubscribe,
    // A-N16: a golden draws a fixed sample and shows no OS notification, so no reveal is ever pushed.
    onRevealDwarfChat: unsubscribe,
    // A-N31: a golden draws a fixed sample and never writes another tool's configuration.
    setClaudeHooksEnabled: refuse('setClaudeHooksEnabled'),
    // A-N07: a golden draws a fixed sample and never moves an ask.
    setAskStep: refuse('setAskStep'),
    // A-N32: a golden draws a fixed sample, never answers the first-run step and never writes another tool's
    // configuration.
    answerWelcome: refuse('answerWelcome')
  }
}
