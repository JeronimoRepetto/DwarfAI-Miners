import type { FolderPicker } from '../../adapters/ElectronFolderPicker'
import type { WindowRef } from '../nativeActions'

/**
 * Hand-written double of `FolderPicker` (16 §4.14, 16 §2.8). `chosen` is the folder the person picks in the dialog;
 * `null` plays a cancelled dialog. Every parent the picker was opened over is recorded.
 */
export class FakeFolderPicker implements FolderPicker {
  readonly parents: WindowRef[] = []

  constructor(public chosen: string | null) {}

  pick(parent: WindowRef): Promise<string | null> {
    this.parents.push(parent)
    return Promise.resolve(this.chosen)
  }
}
