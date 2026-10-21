import type { BaseWindow, Dialog, OpenDialogOptions } from 'electron'
import type { WindowRef } from '../ports/nativeActions'

// verbatim: 16 §4.14 `FolderPicker` (declared beside its one adapter, window/ports/nativeActions.ts; the added line
// is the prettier-ignore directive that keeps it byte-identical)
// prettier-ignore
export interface FolderPicker { pick(parent: WindowRef): Promise<string | null> }
// end verbatim

export interface ElectronFolderPickerDeps {
  dialog: Pick<Dialog, 'showOpenDialog'>
  /** The live window a `WindowRef` names, or `null` once it is gone. */
  windowOf(ref: WindowRef): BaseWindow | null
}

/** Today's `declareMine` picker: one folder. */
const FOLDER_DIALOG: OpenDialogOptions = { properties: ['openDirectory'] }

/**
 * `FolderPicker` over Electron's native open dialog (05 §3.14; 16 §4.14), A-30's picker (14 §2.1: main picks the
 * folder, the renderer sends no path, 14 §1.10). The dialog is attached to the window the control was pressed in, so it
 * is modal to it; a parent that closed meanwhile opens it on its own, and so does a parent that is hidden (the Panel
 * while Veta is the shown mode window, 07 S22.10; ISSUE-288): a dialog attached to a hidden window may never show (a
 * macOS sheet), and the person would be left waiting on it. A cancelled dialog, or one that answers no folder, answers
 * `null`. It answers a path only: the Host re-validates it (`not-a-folder` / `invalid-path`, ADR-019 item 9).
 */
export class ElectronFolderPicker implements FolderPicker {
  constructor(private readonly deps: ElectronFolderPickerDeps) {}

  async pick(parent: WindowRef): Promise<string | null> {
    const { dialog, windowOf } = this.deps
    const window = windowOf(parent)
    const result =
      window === null || !window.isVisible()
        ? await dialog.showOpenDialog(FOLDER_DIALOG)
        : await dialog.showOpenDialog(window, FOLDER_DIALOG)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
}
