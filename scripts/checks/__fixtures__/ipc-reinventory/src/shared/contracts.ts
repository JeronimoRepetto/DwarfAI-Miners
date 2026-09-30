// A synthetic channel table for the ipc re-inventory scanner's own tests (ISSUE-006).
// A comment that mentions ipcMain.handle('comment:ignored') is not a registration.
export const IPC_CHANNELS = {
  getThing: 'thing:get',
  /* A block comment between two entries is skipped. */
  setThing: 'thing:set',
  thingChanged: 'thing:changed'
} as const
