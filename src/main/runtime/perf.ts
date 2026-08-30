/**
 * Poll-cost instrumentation, dormant unless DWARFAI_PERF is set (issue #25).
 *
 * The app polls every 2 seconds for as long as it is running, so a stage that
 * quietly doubles in cost is invisible: nothing ever prints a number to compare
 * against. This keeps that number one env var away instead of one profiling
 * session away, and when the flag is off every call here is a no-op — no
 * clock read, no allocation, no branch worth measuring.
 *
 * Deliberately read straight from process.env rather than from AppConfig: this
 * is a debugging device, not a product setting, and it must be usable without
 * a config round trip (`DWARFAI_PERF=1 pnpm dev`).
 *
 * It must be a REAL environment variable, not a .env entry: this module is
 * imported while index.ts's own imports resolve, which is before index.ts calls
 * loadDotenv(), so a .env line would arrive too late to be seen.
 */

const PERF_ENV_VAR = 'DWARFAI_PERF'

/** Whether poll-duration logging is switched on for this process. */
export function perfLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PERF_ENV_VAR]
  if (raw === undefined) return false
  const normalized = raw.toLowerCase()
  return normalized === '1' || normalized === 'true'
}

/** What one poll cost, in wall-clock milliseconds, plus whatever it counted. */
export interface PollSample {
  totalMs: number
  /** Stage name -> summed milliseconds, in the order the stages first appeared. */
  stages: Record<string, number>
  /** Counter name -> summed value (sessions seen, dwarfs published, ...). */
  counts: Record<string, number>
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10
}

/** One line per poll: total first, then where the time went, then what it saw. */
export function formatPollSample(sample: PollSample): string {
  const parts = [`[perf] poll ${round(sample.totalMs).toFixed(1)}ms`]
  const stages = Object.entries(sample.stages)
  if (stages.length > 0) {
    parts.push(stages.map(([name, ms]) => `${name} ${round(ms).toFixed(1)}`).join(' '))
  }
  const counts = Object.entries(sample.counts)
  if (counts.length > 0) {
    parts.push(counts.map(([name, value]) => `${name} ${value}`).join(' '))
  }
  return parts.join(' | ')
}

export interface PollProfilerOptions {
  enabled: boolean
  log: (line: string) => void
  /** Monotonic millisecond clock; injected so tests never assert on real time. */
  now?: () => number
}

interface OpenPoll {
  startedAt: number
  stages: Map<string, number>
  counts: Map<string, number>
}

/**
 * Accumulates the stages of ONE poll and prints them when it closes.
 *
 * Single-poll state is safe because the poller drops overlapping ticks, so at
 * most one poll is ever open. A poll that never closed (a throw between begin
 * and end) is discarded by the next begin() rather than blended into it: a
 * blended sample would report a cost no single poll ever paid.
 */
export class PollProfiler {
  private readonly enabled: boolean
  private readonly log: (line: string) => void
  private readonly now: () => number
  private open: OpenPoll | null = null

  constructor(options: PollProfilerOptions) {
    this.enabled = options.enabled
    this.log = options.log
    this.now = options.now ?? (() => performance.now())
  }

  /** Open a poll, discarding any previous one that never closed. */
  begin(): void {
    if (!this.enabled) return
    this.open = { startedAt: this.now(), stages: new Map(), counts: new Map() }
  }

  /** Attribute `ms` to a named stage of the poll currently open. */
  stage(name: string, ms: number): void {
    if (this.open === null) return
    this.open.stages.set(name, (this.open.stages.get(name) ?? 0) + ms)
  }

  /** Run `work`, attributing its wall time to `name`. Transparent when disabled. */
  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (this.open === null) return work()
    const startedAt = this.now()
    try {
      return await work()
    } finally {
      this.stage(name, this.now() - startedAt)
    }
  }

  /** measure() for work that is not a promise (aggregation, publishing). */
  measureSync<T>(name: string, work: () => T): T {
    if (this.open === null) return work()
    const startedAt = this.now()
    try {
      return work()
    } finally {
      this.stage(name, this.now() - startedAt)
    }
  }

  /** Add to a named counter of the poll currently open. */
  count(name: string, delta = 1): void {
    if (this.open === null) return
    this.open.counts.set(name, (this.open.counts.get(name) ?? 0) + delta)
  }

  /** Close the poll, print its line, and return it. Null when nothing was open. */
  end(): PollSample | null {
    const open = this.open
    if (open === null) return null
    this.open = null
    const sample: PollSample = {
      totalMs: this.now() - open.startedAt,
      stages: Object.fromEntries(open.stages),
      counts: Object.fromEntries(open.counts)
    }
    this.log(formatPollSample(sample))
    return sample
  }
}

/**
 * The profiler the running app uses. Shared at module scope so the poller can
 * time provider scans while the runtime times publishing, without threading a
 * debug-only object through contracts that exist for the product.
 */
export const pollProfiler = new PollProfiler({
  enabled: perfLoggingEnabled(),
  log: (line) => console.log(line)
})
