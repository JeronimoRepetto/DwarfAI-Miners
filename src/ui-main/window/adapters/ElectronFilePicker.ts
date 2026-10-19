import type { BaseWindow, Dialog, OpenDialogOptions } from 'electron'
import type { FilePicker, WindowRef } from '../ports/nativeActions'

export interface ElectronFilePickerDeps {
  dialog: Pick<Dialog, 'showOpenDialog'>
  /** The live window a `WindowRef` names, or `null` once it is gone. */
  windowOf(ref: WindowRef): BaseWindow | null
}

/** Today's attachment picker (`index.ts:578`): files only, several at once. */
const ATTACHMENT_DIALOG: OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }

/**
 * `FilePicker` over Electron's native open dialog (05 §3.14 ← `index.ts:578`; 16 §4.14). The dialog is attached to
 * the window the control was pressed in, so it is modal to it; a parent that closed meanwhile opens it on its own. A
 * cancelled dialog answers `[]`. It answers paths only: the Host re-validates each one it later receives (ADR-019
 * item 9; 14 §1.10).
 */
export class ElectronFilePicker implements FilePicker {
  constructor(private readonly deps: ElectronFilePickerDeps) {}

  async pickMany(parent: WindowRef): Promise<string[]> {
    const { dialog, windowOf } = this.deps
    const window = windowOf(parent)
    const result =
      window === null
        ? await dialog.showOpenDialog(ATTACHMENT_DIALOG)
        : await dialog.showOpenDialog(window, ATTACHMENT_DIALOG)
    return result.canceled ? [] : result.filePaths
  }
}
