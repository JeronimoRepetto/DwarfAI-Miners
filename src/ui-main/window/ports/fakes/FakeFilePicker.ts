import type { FilePicker, WindowRef } from '../nativeActions'

/**
 * Hand-written double of `FilePicker` (16 §4.14, 16 §2.8). `picked` is what the person chooses in the dialog; `null`
 * plays a cancelled dialog, which answers `[]`. Every parent the picker was opened over is recorded.
 */
export class FakeFilePicker implements FilePicker {
  readonly parents: WindowRef[] = []

  constructor(private readonly picked: readonly string[] | null) {}

  pickMany(parent: WindowRef): Promise<string[]> {
    this.parents.push(parent)
    return Promise.resolve(this.picked === null ? [] : [...this.picked])
  }
}
