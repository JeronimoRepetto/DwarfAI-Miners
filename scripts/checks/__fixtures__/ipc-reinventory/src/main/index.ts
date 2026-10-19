import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/contracts'

export function registerFixtureChannels(window: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.getThing, () => 'thing')
  ipcMain.on(
    IPC_CHANNELS.setThing,
    (_event, payload: unknown) => typeof payload === 'string' && payload.length > 0
  )
  // A channel that the fixture's IPC_CHANNELS table does not list.
  ipcMain.handle('fixture:unlisted', () => null)
  window.webContents.send(IPC_CHANNELS.thingChanged, 'thing')
}
