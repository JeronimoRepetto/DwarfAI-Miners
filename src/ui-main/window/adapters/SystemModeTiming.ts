import type { ModeTiming } from '../ports/modeTiming'

/** `ModeTiming` over the process clock and `setTimeout` (ISSUE-284; ADR-025 item 3: `t0` is the UI-main clock). */
export class SystemModeTiming implements ModeTiming {
  now(): number {
    return Date.now()
  }

  after(ms: number, fire: () => void): () => void {
    const timer = setTimeout(fire, ms)
    return () => clearTimeout(timer)
  }
}
