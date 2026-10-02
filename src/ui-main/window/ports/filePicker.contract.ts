import { describe, expect, it } from 'vitest'
import type { FilePicker, WindowRef } from './nativeActions'

export interface FilePickerSubject {
  picker: FilePicker
  /** The window each dialog was attached to, in order, as the `WindowRef` it was opened over. */
  attachedTo(): WindowRef[]
}

/**
 * The `FilePicker` contract (16 §4.14, 16 §2.8), run by the double and by the real adapter alike: native and
 * user-initiated, the dialog is opened over the window the control was pressed in and answers the paths the person
 * chose, paths only (the Host re-validates each, ADR-019 item 9); a cancelled dialog answers `[]`. `make` answers a
 * picker whose dialog the person ends by choosing `chosen`, or cancels when it is `null`.
 */
export function runFilePickerContract(
  name: string,
  make: (chosen: readonly string[] | null) => FilePickerSubject
): void {
  const PANEL: WindowRef = { windowId: 3 }

  describe(`${name} meets the FilePicker contract (16 §4.14)`, () => {
    it('[ADR-019] the dialog over the window the control was pressed in answers the chosen paths in order', async () => {
      const subject = make(['C:/work/a.txt', 'C:/work/b.png'])

      expect(await subject.picker.pickMany(PANEL)).toEqual(['C:/work/a.txt', 'C:/work/b.png'])

      expect(subject.attachedTo()).toEqual([PANEL])
    })

    it('[ADR-019] a cancelled dialog answers []', async () => {
      const subject = make(null)

      expect(await subject.picker.pickMany(PANEL)).toEqual([])
    })
  })
}
