// layer: L2
import type { BaseWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { describe, expect, it } from 'vitest'
import type { WindowRef } from '../ports/nativeActions'
import { ElectronFolderPicker } from './ElectronFolderPicker'

/**
 * The real `ElectronFolderPicker` over a recording `dialog` double (16 §4.14; 05 §3.14 ← today's `declareMine`
 * picker): one folder, attached to the window the control was pressed in; a cancelled dialog answers `null`. It yields
 * a path only: the Host re-validates it (`mines.declare`, ADR-019 item 9; 14 §1.10). No real dialog is ever shown.
 */

/** Stands in for the Electron window a `WindowRef` resolves to; only its identity matters here. */
const PANEL = { id: 3 } as unknown as BaseWindow
const FOLDER_DIALOG: OpenDialogOptions = { properties: ['openDirectory'] }

class RecordingDialog {
  readonly calls: Array<{ parent: BaseWindow | undefined; options: OpenDialogOptions }> = []
  constructor(private readonly answer: OpenDialogReturnValue) {}

  showOpenDialog(
    first: BaseWindow | OpenDialogOptions,
    second?: OpenDialogOptions
  ): Promise<OpenDialogReturnValue> {
    if (second === undefined)
      this.calls.push({ parent: undefined, options: first as OpenDialogOptions })
    else this.calls.push({ parent: first as BaseWindow, options: second })
    return Promise.resolve(this.answer)
  }
}

function subject(
  answer: OpenDialogReturnValue,
  windows: Record<number, BaseWindow> = { 3: PANEL }
) {
  const dialog = new RecordingDialog(answer)
  const picker = new ElectronFolderPicker({
    dialog: dialog as never,
    windowOf: (ref: WindowRef) => windows[ref.windowId] ?? null
  })
  return { dialog, picker }
}

describe('ElectronFolderPicker (16 §4.14)', () => {
  it('[ADR-019, NFR-PLAT-09] pick opens a folders-only picker over the parent window and answers the chosen folder', async () => {
    const { dialog, picker } = subject({ canceled: false, filePaths: ['/home/j/work/ore'] })

    expect(await picker.pick({ windowId: 3 })).toBe('/home/j/work/ore')
    expect(dialog.calls).toEqual([{ parent: PANEL, options: FOLDER_DIALOG }])
  })

  it('[ADR-019] a cancelled FolderPicker answers null', async () => {
    const { picker } = subject({ canceled: true, filePaths: ['/home/j/ignored'] })

    expect(await picker.pick({ windowId: 3 })).toBeNull()
  })

  it('[ADR-019] a FolderPicker dialog that answers no folder answers null', async () => {
    const { picker } = subject({ canceled: false, filePaths: [] })

    expect(await picker.pick({ windowId: 3 })).toBeNull()
  })

  it('[ADR-019] a parent window that is gone opens the folder picker on its own', async () => {
    const { dialog, picker } = subject({ canceled: false, filePaths: ['/home/j/ore'] }, {})

    expect(await picker.pick({ windowId: 3 })).toBe('/home/j/ore')
    expect(dialog.calls).toEqual([{ parent: undefined, options: FOLDER_DIALOG }])
  })
})
