import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentLaunchRequest,
  AgentLaunchResult,
  AppBuild,
  DwarfActivation,
  DwarfFeedResult,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfQuestionAnswerRequest,
  DwarfQuestionAnswerResult,
  DwarfTextRequest,
  DwarfTextResult,
  HeldSessionLaunchRequest,
  HeldSessionLaunchResult,
  MetricsResetResult,
  MineDeclareResult,
  MinesSnapshot,
  MineUndeclareResult,
  PanelLayout,
  PanelLayoutRequest,
  ProjectQuery,
  ProjectQueryResult,
  ShortcutState
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'

/** API surface exposed to the renderer as `window.api`. */
export interface DwarfAiMinersApi {
  /** Hide the floating panel (the app keeps running in the tray). */
  hidePanel: () => void
  /** The window's REAL always-on-top state, read back from the BrowserWindow. */
  getAlwaysOnTop: () => Promise<boolean>
  /**
   * Request pin/unpin (see #35). Resolves with the resulting REAL state, which
   * can differ from the request when the platform declines the change — the
   * renderer must render this verdict, never the wish.
   */
  setAlwaysOnTop: (pinned: boolean) => Promise<boolean>
  /** What the docked shell IS: its edge, and whether it is open (see #90). */
  getPanelLayout: () => Promise<PanelLayout>
  /**
   * Open, collapse, or make room for a mine beside the secondary panel (#90).
   * Resolves with the REAL layout after main moved the window, which is what the
   * rail's arrow and the shell's columns are drawn from — a display too narrow
   * for the whole composition answers with what it could actually give.
   */
  setPanelLayout: (request: PanelLayoutRequest) => Promise<PanelLayout>
  /** The panel toggle's REAL state, including a startup registration failure (see #17). */
  getToggleShortcut: () => Promise<ShortcutState>
  /**
   * Re-bind the global panel toggle live. Resolves with the REAL resulting
   * state: when the combination is owned by another application this is the
   * PREVIOUS accelerator plus the reason, never the one that was requested.
   */
  setToggleShortcut: (accelerator: string) => Promise<ShortcutState>
  /** Snapshot used by the renderer when it initializes after a poll update. */
  getMines: () => Promise<MinesSnapshot>
  /** Subscribe to push updates. Returns an unsubscribe function. */
  onMinesUpdated: (listener: (snapshot: MinesSnapshot) => void) => () => void
  /** Focus the dwarf's terminal, or return recent transcript text as fallback. */
  activateDwarf: (dwarfId: string) => Promise<DwarfActivation>
  /** Deliver a typed message to the dwarf's live session; the panel stays open. */
  /**
   * The last few messages of one dwarf's own transcript (#159), for a session
   * this panel only OBSERVES.
   *
   * Deliberately not `activateDwarf`: that one reads a feed only after failing
   * to focus a window and failing to open a terminal, so asking it for words
   * means asking it to try raising a console first. `readable: false` says
   * this session keeps nothing this app can read, which is a different answer
   * from an empty list.
   */
  getDwarfFeed: (dwarfId: string) => Promise<DwarfFeedResult>
  sendDwarfText: (request: DwarfTextRequest) => Promise<DwarfTextResult>
  /** Cancel the dwarf's current work; the panel stays open for the verdict. */
  kickDwarf: (request: DwarfKickRequest) => Promise<DwarfKickResult>
  /**
   * Start a new agent session in a mine (see #86). Resolves with the verdict of
   * the START — the dwarf itself arrives on a later minesUpdated, up to one
   * poll interval away, so the panel must acknowledge from this and not wait.
   */
  launchAgent: (request: AgentLaunchRequest) => Promise<AgentLaunchResult>
  /**
   * Report that a kicked agent was SEEN stopping, so main retires the dwarf
   * (see #46). One-way by design: there is no verdict to wait for, because the
   * departure arrives on the next minesUpdated like every other change.
   */
  retireDwarf: (dwarfId: string) => void
  /**
   * Which build is running (see #79) — the version and whether it was
   * installed or started from a checkout. This bridge is the ONLY route: with
   * context isolation on and node integration off the renderer has no
   * package.json to read and no environment to inspect, which is what keeps
   * the panel's version the one Electron reports for the running process.
   */
  getAppBuild: () => Promise<AppBuild>
  /**
   * Ask main to open the OS folder picker and adopt the chosen folder as a
   * mine (#85).
   *
   * No argument, by design: the picker runs in main, so the renderer asks for a
   * mine and never names a directory. Resolves with main's verdict, including
   * the reason when nothing was added — the panel must be able to say why.
   */
  declareMine: () => Promise<MineDeclareResult>
  /**
   * Undo a declaration, by MINE ID and never by path — the id is what both
   * processes already agree on, and a path would be a second key to keep in
   * step. A mine a session is still working reverts to a discovered one rather
   * than disappearing, which is what the resolved outcome distinguishes.
   */
  undeclareMine: (mineId: string) => Promise<MineUndeclareResult>
  /**
   * Settings' "Reset metrics" action (#138). No argument: the typed
   * confirmation is validated entirely in the renderer, so this asks main to
   * carry out an already-confirmed intent. See MetricsResetResult for exactly
   * what this does and does not wipe.
   */
  resetMetrics: () => Promise<MetricsResetResult>
  /**
   * Browse every project the app remembers — filtered by tier, ordered by
   * either stored date, searched by a substring of the name (#92).
   *
   * Answered from the database in main, NOT from the mines the panel already
   * holds: the point is the projects nobody is working right now, and those are
   * on no board. Each result says whether it is live, which is the one field
   * that comes from the poll rather than from disk.
   */
  queryProjects: (query: ProjectQuery) => Promise<ProjectQueryResult>
  /**
   * Start a session the panel HOLDS in a mine, over the Agent SDK (#86, #94).
   *
   * Resolves with the verdict of the START — the dwarf itself arrives on a
   * later minesUpdated, up to one poll interval away, so the panel must
   * acknowledge from this and not wait for the crew to change.
   *
   * Held is what makes a question answerable from the panel: the session's asks
   * reach main live while the stream is open. The price is that its child dies
   * with the panel; the session on disk survives and resumes by id.
   */
  launchHeldSession: (request: HeldSessionLaunchRequest) => Promise<HeldSessionLaunchResult>
  /**
   * Answer a question a held session asked (see Dwarf.pendingQuestion).
   *
   * Addressed by DWARF, like every other action: a question can only be
   * answered from where it was shown. `answers` is keyed by the question's text
   * and valued by the chosen option's label — both are checked in main against
   * the ask the agent actually made, so an answer can only repeat the agent's
   * own words back to it.
   */
  answerDwarfQuestion: (request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>
}

const api: DwarfAiMinersApi = {
  hidePanel: () => ipcRenderer.send(IPC_CHANNELS.hidePanel),
  getAlwaysOnTop: () => ipcRenderer.invoke(IPC_CHANNELS.getAlwaysOnTop),
  // `pinned === true` collapses any non-boolean to false BEFORE it crosses the
  // bridge, so main's boundary validation only ever sees a clean boolean.
  setAlwaysOnTop: (pinned) => ipcRenderer.invoke(IPC_CHANNELS.setAlwaysOnTop, pinned === true),
  getPanelLayout: () => ipcRenderer.invoke(IPC_CHANNELS.getPanelLayout),
  // Same discipline as setAlwaysOnTop: both flags are collapsed to real
  // booleans BEFORE they cross, so main's boundary check reasons about a clean
  // shape and never about what a renderer happened to put in the object.
  // `edge` (#138) is forwarded only when it is exactly 'left' or 'right';
  // anything else — including absent, which is every non-Settings caller — is
  // dropped rather than coerced to a guess, so main's boundary check reasons
  // about a real edge or none at all.
  setPanelLayout: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPanelLayout, {
      expanded: request?.expanded === true,
      mineOpen: request?.mineOpen === true,
      ...(request?.edge === 'left' || request?.edge === 'right' ? { edge: request.edge } : {})
    }),
  getToggleShortcut: () => ipcRenderer.invoke(IPC_CHANNELS.getToggleShortcut),
  // Same discipline as setAlwaysOnTop: collapse anything that is not a string
  // BEFORE it crosses, so main's boundary check only reasons about a string.
  // An empty one is refused there with a reason the panel can show.
  setToggleShortcut: (accelerator) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.setToggleShortcut,
      typeof accelerator === 'string' ? accelerator : ''
    ),
  getMines: () => ipcRenderer.invoke(IPC_CHANNELS.getMines),
  onMinesUpdated: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: MinesSnapshot) =>
      listener(snapshot)
    ipcRenderer.on(IPC_CHANNELS.minesUpdated, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.minesUpdated, wrapped)
  },
  activateDwarf: (dwarfId) => ipcRenderer.invoke(IPC_CHANNELS.activateDwarf, dwarfId),
  // Same string coercion as every other id crossing here: main's boundary
  // check only ever sees a real string.
  getDwarfFeed: (dwarfId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getDwarfFeed, typeof dwarfId === 'string' ? dwarfId : ''),
  sendDwarfText: (request) => ipcRenderer.invoke(IPC_CHANNELS.sendDwarfText, request),
  kickDwarf: (request) => ipcRenderer.invoke(IPC_CHANNELS.kickDwarf, request),
  // Same discipline as setToggleShortcut, applied field by field: a launch
  // starts a real process, so what crosses is rebuilt here as two strings
  // rather than forwarded whole. Anything else the caller attached — a
  // directory, above all — is dropped before main ever sees it.
  launchAgent: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.launchAgent, {
      mineId: typeof request?.mineId === 'string' ? request.mineId : '',
      prompt: typeof request?.prompt === 'string' ? request.prompt : ''
    }),
  // Same discipline as setToggleShortcut: collapse anything that is not a
  // string BEFORE it crosses, so main's boundary check only reasons about one.
  retireDwarf: (dwarfId) =>
    ipcRenderer.send(IPC_CHANNELS.retireDwarf, typeof dwarfId === 'string' ? dwarfId : ''),
  getAppBuild: () => ipcRenderer.invoke(IPC_CHANNELS.getAppBuild),
  declareMine: () => ipcRenderer.invoke(IPC_CHANNELS.declareMine),
  // Same discipline as retireDwarf: collapse anything that is not a string
  // BEFORE it crosses, so main's boundary check only reasons about one.
  undeclareMine: (mineId) =>
    ipcRenderer.invoke(IPC_CHANNELS.undeclareMine, typeof mineId === 'string' ? mineId : ''),
  // No payload to coerce: the typed confirmation lives entirely on the
  // renderer side (see the reset modal), so this simply asks.
  resetMetrics: () => ipcRenderer.invoke(IPC_CHANNELS.resetMetrics),
  // Forwarded uncoerced, exactly as sendDwarfText's payload is: an object with
  // a closed set of sort keys cannot be collapsed to a safe default the way a
  // stray boolean or string can, so main validates it and refuses what it
  // cannot run. Folding the search term and clamping the page both happen
  // there too — each has to agree with the database, and a copy here would be a
  // second place for that agreement to break.
  queryProjects: (query) => ipcRenderer.invoke(IPC_CHANNELS.queryProjects, query),
  // Same discipline as setToggleShortcut, applied field by field: a launch
  // starts a real process, so what crosses is rebuilt here as two strings
  // rather than forwarded whole. Anything else the caller attached — a
  // directory, above all — is dropped before main ever sees it.
  launchHeldSession: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.launchHeldSession, {
      mineId: typeof request?.mineId === 'string' ? request.mineId : '',
      prompt: typeof request?.prompt === 'string' ? request.prompt : ''
    }),
  // Field by field again, and the record entry by entry: an answer releases a
  // tool call a live agent is blocked inside, so what crosses is rebuilt from
  // string pairs only. A non-string value is dropped rather than coerced —
  // main then sees an answer that names no option and refuses it, which is the
  // right end for a payload nobody could have chosen.
  answerDwarfQuestion: (request) => {
    const answers: Record<string, string> = {}
    for (const [question, label] of Object.entries(request?.answers ?? {})) {
      if (typeof label === 'string') answers[question] = label
    }
    return ipcRenderer.invoke(IPC_CHANNELS.answerDwarfQuestion, {
      dwarfId: typeof request?.dwarfId === 'string' ? request.dwarfId : '',
      toolUseId: typeof request?.toolUseId === 'string' ? request.toolUseId : '',
      answers
    })
  }
}

contextBridge.exposeInMainWorld('api', api)
