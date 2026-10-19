// The mode-window registry of the window module (ADR-019 item 8; 05 §2.1 `ui-main/window/`): the `webContents` ids
// of the windows that are mode windows of the app (the Panel today; Veta and Valle later, ADR-034). A window is
// registered when it is created and dropped when it closes; the IPC sender check asks it whether an event comes
// from one of them.

export interface ModeWindowRegistry {
  /** A mode window was created: its `webContents` id is known from now on. */
  register(webContentsId: number): void
  /** A mode window closed: its id is no longer known. */
  drop(webContentsId: number): void
  /** Whether `webContentsId` is the `webContents` of a registered mode window. */
  has(webContentsId: number): boolean
}

export function createModeWindowRegistry(): ModeWindowRegistry {
  const known = new Set<number>()
  return {
    register(webContentsId) {
      known.add(webContentsId)
    },
    drop(webContentsId) {
      known.delete(webContentsId)
    },
    has(webContentsId) {
      return known.has(webContentsId)
    }
  }
}
