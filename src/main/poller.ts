import { aggregateMines } from './domain/aggregate'
import type { Mine, MineTier, ProviderSnapshot } from './domain/types'
import type { Provider } from './providers/provider'

export interface PollerOptions {
  providers: Provider[]
  intervalMs: number
  /** Non-blocking tier lookup (TierService.tierOf bound). */
  tierOf: (path: string) => MineTier
  onUpdate: (mines: Mine[]) => void
  logError?: (message: string, error: unknown) => void
}

/**
 * Scans every provider on a fixed interval and pushes the aggregated mines.
 * One provider failing never kills the loop (Promise.allSettled); overlapping
 * ticks are skipped instead of piling up.
 */
export class Poller {
  private readonly options: PollerOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(options: PollerOptions) {
    this.options = options
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
}
