// layer: L2
import type { BaseWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { describe, expect, it } from 'vitest'
import type { WindowRef } from '../ports/nativeActions'
import { ElectronFilePicker } from './ElectronFilePicker'
import { runFilePickerContract } from '../ports/filePicker.contract'

/**
 * The real `ElectronFilePicker` over a recording `dialog` double (16 §4.14; 05 §3.14 ← `index.ts:578`): today's
 * native picker, files only and several at once, attached to the window the control was pressed in; a cancelled
 * dialog answers `[]`. It yields paths only: the Host re-validates each (ADR-019 item 9).
 */

/** Stands in for the Electron window a `WindowRef` resolves to; only its identity matters here. */
const PANEL = { id: 3 } as unknown as BaseWindow

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
  const picker = new ElectronFilePicker({
    dialog: dialog as never,
    windowOf: (ref: WindowRef) => windows[ref.windowId] ?? null
  })
  return { dialog, picker }
}

describe('ElectronFilePicker (16 §4.14)', () => {
  it('[ADR-019] pickMany opens a files-only, multi-select picker over the parent window and answers the paths', async () => {
    const paths = ['/home/j/notes.md', '/home/j/shot.png']
    const { dialog, picker } = subject({ canceled: false, filePaths: paths })

    expect(await picker.pickMany({ windowId: 3 })).toEqual(paths)
    expect(dialog.calls).toEqual([
      { parent: PANEL, options: { properties: ['openFile', 'multiSelections'] } }
    ])
  })

  it('[ADR-019] a cancelled FilePicker answers an empty list', async () => {
    const { picker } = subject({ canceled: true, filePaths: ['/home/j/ignored.md'] })
    expect(await picker.pickMany({ windowId: 3 })).toEqual([])
  })

  it('[ADR-019] a parent window that is gone opens the picker on its own', async () => {
    const { dialog, picker } = subject({ canceled: false, filePaths: ['/home/j/a.md'] }, {})

    expect(await picker.pickMany({ windowId: 3 })).toEqual(['/home/j/a.md'])
    expect(dialog.calls).toEqual([
      { parent: undefined, options: { properties: ['openFile', 'multiSelections'] } }
    ])
  })
})

runFilePickerContract('ElectronFilePicker over Electron dialog', (chosen) => {
  const { dialog, picker } = subject({ canceled: chosen === null, filePaths: [...(chosen ?? [])] })
  return {
    picker,
    attachedTo: () =>
      dialog.calls.map((call) => (call.parent === PANEL ? { windowId: 3 } : { windowId: -1 }))
  }
})
