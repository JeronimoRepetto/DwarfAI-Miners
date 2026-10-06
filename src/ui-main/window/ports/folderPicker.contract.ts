import { describe, expect, it } from 'vitest'
import type { FolderPicker } from '../adapters/ElectronFolderPicker'
import type { WindowRef } from './nativeActions'

export interface FolderPickerSubject {
  picker: FolderPicker
  /** The window each dialog was attached to, in order, as the `WindowRef` it was opened over. */
  attachedTo(): WindowRef[]
}

/**
 * The `FolderPicker` contract (16 §4.14, 16 §2.8), run by the double and by the real adapter alike: native and
 * user-initiated, the dialog is opened over the window the control was pressed in and answers the one folder the person
 * chose, a path only (the Host re-validates it, ADR-019 item 9; 14 §1.10); a cancelled dialog answers `null`. `make`
 * answers a picker whose dialog the person ends by choosing `chosen`, or cancels when it is `null`.
 */
export function runFolderPickerContract(
  name: string,
  make: (chosen: string | null) => FolderPickerSubject
): void {
  const PANEL: WindowRef = { windowId: 3 }

  describe(`${name} meets the FolderPicker contract (16 §4.14)`, () => {
    it('[ADR-019] the dialog over the window the control was pressed in answers the chosen folder', async () => {
      const subject = make('C:/work/ore')

      expect(await subject.picker.pick(PANEL)).toBe('C:/work/ore')

      expect(subject.attachedTo()).toEqual([PANEL])
    })

    it('[ADR-019] a cancelled folder dialog answers null', async () => {
      const subject = make(null)

      expect(await subject.picker.pick(PANEL)).toBeNull()
    })
  })
}
