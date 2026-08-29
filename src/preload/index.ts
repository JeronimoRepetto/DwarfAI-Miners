import { contextBridge, ipcRenderer } from 'electron'

/** API surface exposed to the renderer as `window.api`. */
export interface AgentNameApi {
  /** Hide the floating panel (the app keeps running in the tray). */
  hidePanel: () => void
}

const api: AgentNameApi = {
  hidePanel: () => ipcRenderer.send('panel:hide')
}

contextBridge.exposeInMainWorld('api', api)
