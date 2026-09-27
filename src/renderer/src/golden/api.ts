/*
 * The bridge the real App is mounted on in a full-screen golden (#635): main's side of every
 * `window.api` member, answered from the design's sample instead of a machine. Golden-only, like
 * everything under golden/: only the golden page imports it, and the product build never sees it.
 *
 * A full-screen reference starts from a first visit (docs/README.md, Comparing your build): no
 * remembered layout and every preference at its default, so each read answers what main answers
 * on a fresh install, and each preference write answers with the request, as main does when it
 * can store it. The sample decides only what it carries: the board, the projects, the edge, the
 * version, the guild flag, the shortcut's registration and the providers.
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
    getMessagePanel: () => Promise.resolve({ surface: 'none', mineId: '', dwarfId: '' }),
    setMessagePanel: (state) => Promise.resolve(state),
    onMessagePanel: unsubscribe,
    setMessagePanelHeight: none,
    dragMessagePanel: none,
    dockMessagePanel: none,
    reportMessagePanelSettled: none,
    reportDwarfDelivery: none,
    onDwarfDeliveryReport: unsubscribe,
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
    getDwarfFeed: refuse('getDwarfFeed'),
    getDwarfFeedPage: refuse('getDwarfFeedPage'),
    setWatchedDwarf: none,
    refreshDwarfTelemetry: none,
    setDwarfTuning: refuse('setDwarfTuning'),
    getMineHistory: (mineId) =>
      Promise.resolve(sample.histories[mineId] ?? { readable: true, speakers: [] }),
    openMinePath: refuse('openMinePath'),
    openExternalLink: refuse('openExternalLink'),
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
    setOpenMine: none,
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
    getLaunchView: () => Promise.resolve({ ...DEFAULT_LAUNCH_VIEW }),
    setLaunchView: none
  }
}
