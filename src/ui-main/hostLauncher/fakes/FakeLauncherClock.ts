// The launcher's clock double (17 §2.2: no real timers below L4): a mutable now that only `sleep`
// and `advance` move. `sleep(ms)` advances virtual time at once and records the wait, so a
// 15 s readiness budget runs in no real time. Never imported by production code (R14).
import type { LauncherClock, Sleep } from '../ports'

export class FakeLauncherClock implements LauncherClock {
  /** Every `sleep` duration, in call order. */
  readonly sleeps: number[] = []

  constructor(private current = 0) {}

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    this.current += ms
  }

  readonly sleep: Sleep = async (ms) => {
    this.sleeps.push(ms)
    this.current += ms
    // Yield, so concurrent callers interleave as they would on a real event loop.
    await Promise.resolve()
  }
}
