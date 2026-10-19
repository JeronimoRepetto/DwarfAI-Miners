// The StopAllPort double (16 §2.8 `Recording<Port>`): it owns the scripted dwarfs, ends each of
// them except the ones scripted to fail, and records every `stopAll` call, in order, with its
// `requestId`. `hold()` keeps the next calls in flight until `release()`, so a test can send a
// repeat while the first is unsettled. It never signals anything else (INV-120). Passes
// runStopAllContract. Never imported by production code (R14).
import type { DwarfId } from '../../../contracts/wire'
import type { StopAllOutcome, StopAllPort } from '../ports/stopAll'

export interface RecordingStopAllOptions {
  /** The owned dwarfs; default none. */
  owned?: readonly DwarfId[]
  /** The owned dwarfs whose end fails; default none. */
  failing?: readonly DwarfId[]
  /** Where each call is also written, as `stopAll:<requestId>`, to order it against frames. */
  journal?: string[]
}

export class RecordingStopAll implements StopAllPort {
  /** The `requestId` of every call, in call order. */
  readonly calls: string[] = []
  private gate: Promise<void> = Promise.resolve()
  private open: () => void = () => {}

  constructor(private readonly options: RecordingStopAllOptions = {}) {}

  async stopAll(requestId: string): Promise<StopAllOutcome> {
    this.calls.push(requestId)
    this.options.journal?.push(`stopAll:${requestId}`)
    await this.gate
    const owned = this.options.owned ?? []
    const failing = new Set(this.options.failing ?? [])
    return {
      ended: owned.filter((dwarfId) => !failing.has(dwarfId)),
      failed: owned.filter((dwarfId) => failing.has(dwarfId))
    }
  }

  /** Holds every later call in flight until `release()`. */
  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve))
  }

  release(): void {
    this.open()
  }
}
