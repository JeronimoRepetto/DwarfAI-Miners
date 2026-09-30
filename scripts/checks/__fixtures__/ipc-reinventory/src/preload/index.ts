import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/contracts'

const api = {
  getThing: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.getThing)
}

contextBridge.exposeInMainWorld('api', api)
