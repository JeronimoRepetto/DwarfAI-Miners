// The DrainGate double (16 §2.8 `Fake<Port>`): a test opens and clears blockers by hand, as the
// launching and asking modules will report open turns, asks, in-flight work and non-resumable
// sessions (ADR-002 D8 items 2–3). Passes runDrainGateContract. Never imported by production code
// (R14).
import type { DrainBlocker, DrainGate } from '../ports/drainGate'

export class FakeDrainGate implements DrainGate {
  private open: DrainBlocker[] = []
  /** How many times `blockers()` was read. */
  reads = 0

  constructor(initial: readonly DrainBlocker[] = []) {
    this.open = [...initial]
  }

  blockers(): readonly DrainBlocker[] {
    this.reads += 1
    return [...this.open]
  }

  /** Opens one more blocker. */
  block(blocker: DrainBlocker): void {
    this.open.push(blocker)
  }

  /** Clears every blocker. */
  clear(): void {
    this.open = []
  }
}
