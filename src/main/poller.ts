import { aggregateMines } from './domain/aggregate'
import type { Mine, MineTier, ProviderSnapshot } from './domain/types'
import type { Provider } from './providers/provider'

/** Default coalescing window for out-of-band nudges, in milliseconds. */
export const DEFAULT_NUDGE_WINDOW_MS = 300

export interface PollerOptions {
  providers: Provider[]
  intervalMs: number
  /** Non-blocking tier lookup (TierService.tierOf bound). */
  tierOf: (path: string) => MineTier
  onUpdate: (mines: Mine[]) => void
  logError?: (message: string, error: unknown) => void
  /** How long nudge() coalesces further events after firing; defaults to 300 ms. */
  nudgeWindowMs?: number
}

/**
 * Scans every provider on a fixed interval and pushes the aggregated mines.
 * One provider failing never kills the loop (Promise.allSettled); overlapping
 * ticks are skipped instead of piling up.
 *
 * The interval is the ground truth and the only startup-reconciliation source.
 * nudge() is layered on top for the optional hook channel: it can make a scan
 * happen sooner, never less often, so a missed or malformed push event still
 * self-heals on the next regular tick.
 */
export class Poller {
  private readonly options: PollerOptions
  private readonly nudgeWindowMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private nudgeWindow: ReturnType<typeof setTimeout> | null = null
  private nudgePending = false
  private ticking = false

  constructor(options: PollerOptions) {
    this.options = options
    this.nudgeWindowMs = options.nudgeWindowMs ?? DEFAULT_NUDGE_WINDOW_MS
  }

  start(): void {
    if (this.timer !== null) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.nudgeWindow !== null) {
      clearTimeout(this.nudgeWindow)
      this.nudgeWindow = null
    }
    this.nudgePending = false
  }

  /**
   * Ask for a scan now because something outside the poller says the state
   * just changed (a provider hook firing).
   *
   * Leading edge, because the latency win is the entire point: the first
   * nudge after a quiet period scans immediately. Every further nudge inside
   * the window is collapsed into at most ONE trailing scan when the window
   * closes, so a turn that fires several hook events costs two scans at worst
   * rather than one per event.
   */
  nudge(): void {
    if (this.nudgeWindow !== null) {
      this.nudgePending = true
      return
    }
    this.openNudgeWindow()
    this.tickNowOrDefer()
  }

  /** One scan-aggregate-publish cycle. Public for tests and manual refresh. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const results = await Promise.allSettled(
        this.options.providers.map((provider) => provider.scan())
      )
      const snapshots: ProviderSnapshot[] = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          snapshots.push(...result.value)
        } else {
          this.options.logError?.(
            `[poller] Provider ${this.options.providers[index]?.kind ?? '?'} scan failed`,
            result.reason
          )
        }
      })
      this.options.onUpdate(aggregateMines(snapshots, this.options.tierOf))
    } finally {
      this.ticking = false
    }
  }

  /**
   * tick() drops an overlapping call, and that in-flight scan may have started
   * before the event this nudge is reporting. Deferring to the trailing edge
   * keeps the change visible within one window instead of hiding it until the
   * next regular poll.
   */
  private tickNowOrDefer(): void {
    if (this.ticking) {
      this.nudgePending = true
      return
    }
    void this.tick()
  }

  private openNudgeWindow(): void {
    this.nudgePending = false
    this.nudgeWindow = setTimeout(() => {
      this.nudgeWindow = null
      if (!this.nudgePending) return
      // Re-open rather than fire freely, so a sustained event stream stays
      // rate-limited to one scan per window.
      this.openNudgeWindow()
      this.tickNowOrDefer()
    }, this.nudgeWindowMs)
  }
}
