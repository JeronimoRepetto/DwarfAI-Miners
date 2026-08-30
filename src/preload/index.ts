import { contextBridge, ipcRenderer } from 'electron'
import type {
  DwarfActivation,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfTextRequest,
  DwarfTextResult,
  MinesSnapshot,
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
  sendDwarfText: (request: DwarfTextRequest) => Promise<DwarfTextResult>
  /** Cancel the dwarf's current work; the panel stays open for the verdict. */
  kickDwarf: (request: DwarfKickRequest) => Promise<DwarfKickResult>
  /**
   * Report that a kicked agent was SEEN stopping, so main retires the dwarf
   * (see #46). One-way by design: there is no verdict to wait for, because the
   * departure arrives on the next minesUpdated like every other change.
   */
  retireDwarf: (dwarfId: string) => void
}

const api: DwarfAiMinersApi = {
  hidePanel: () => ipcRenderer.send(IPC_CHANNELS.hidePanel),
  getAlwaysOnTop: () => ipcRenderer.invoke(IPC_CHANNELS.getAlwaysOnTop),
  // `pinned === true` collapses any non-boolean to false BEFORE it crosses the
  // bridge, so main's boundary validation only ever sees a clean boolean.
  setAlwaysOnTop: (pinned) => ipcRenderer.invoke(IPC_CHANNELS.setAlwaysOnTop, pinned === true),
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
  sendDwarfText: (request) => ipcRenderer.invoke(IPC_CHANNELS.sendDwarfText, request),
  kickDwarf: (request) => ipcRenderer.invoke(IPC_CHANNELS.kickDwarf, request),
  // Same discipline as setToggleShortcut: collapse anything that is not a
  // string BEFORE it crosses, so main's boundary check only reasons about one.
  retireDwarf: (dwarfId) =>
    ipcRenderer.send(IPC_CHANNELS.retireDwarf, typeof dwarfId === 'string' ? dwarfId : '')
}

contextBridge.exposeInMainWorld('api', api)
