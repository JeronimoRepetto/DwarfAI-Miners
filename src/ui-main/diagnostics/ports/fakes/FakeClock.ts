// The UiClock double: a mutable now, advanced by hand. It never reads real time. Never imported by production
// code (R14).
import type { UiClock } from '../clock'

export class FakeClock implements UiClock {
  constructor(private current = 0) {}

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    this.current += ms
  }
}
