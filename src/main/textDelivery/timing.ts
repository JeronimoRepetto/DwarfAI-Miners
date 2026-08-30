/**
 * Per-stage instrumentation for one delivery attempt (issue #21).
 *
 * A Kick or Send can take seconds, and until now the log said only whether it
 * worked. Splitting the wait into named stages is what turns "it feels slow"
 * into a number: bringing the console forward, starting the child process, and
 * the relay turn itself are wildly different costs, and only one of them is
 * worth optimizing at a time.
 *
 * The privacy rule is absolute and unchanged: stages, durations, channels and
 * verdicts are recorded — never the message, or any part of it. Nothing here
 * ever accepts the payload, so there is no way for it to leak one.
 *
 * The clock is injected so tests assert real numbers instead of sleeping.
 */

/**
 * The stages a delivery walks through. Not every attempt walks every stage: a
 * relay never focuses a window, and a console send never spawns a relay.
 */
export type DeliveryStage = 'focus' | 'spawn' | 'relay' | 'total'

export interface StageTimings {
  /** Bringing the target session's console window to the foreground. */
  focusMs?: number
  /** Starting the child process that carries out the action. */
  spawnMs?: number
  /** The one-shot `claude -p` relay turn: CLI cold start plus one model turn. */
  relayMs?: number
  /** Everything the runtime waited for, the stages above included. */
  totalMs?: number
}

/** Reading order for the log line: the order a delivery actually walks them. */
const STAGE_ORDER: ReadonlyArray<[DeliveryStage, keyof StageTimings]> = [
  ['focus', 'focusMs'],
  ['spawn', 'spawnMs'],
  ['relay', 'relayMs'],
  ['total', 'totalMs']
]

const FIELD_OF: Record<DeliveryStage, keyof StageTimings> = {
  focus: 'focusMs',
  spawn: 'spawnMs',
  relay: 'relayMs',
  total: 'totalMs'
}

export interface StageTimer {
  /**
   * Run `work` under `stage` and return its value, recording the elapsed time
   * either way — a failed attempt is the one most worth timing, so a rejection
   * is timed and then re-thrown untouched.
   */
  measure<T>(stage: DeliveryStage, work: () => Promise<T>): Promise<T>
  /** Record a duration measured somewhere else. */
  record(stage: DeliveryStage, ms: number): void
  /**
   * Fold in the stages a nested port already measured. Our own reading wins on
   * a clash: the outer timer measured the whole call, the inner only part of it.
   */
  absorb(stages: StageTimings | undefined): void
  /** A copy of everything recorded so far, safe for the caller to keep. */
  timings(): StageTimings
}

export function createStageTimer(now: () => number = Date.now): StageTimer {
  const timings: StageTimings = {}

  function record(stage: DeliveryStage, ms: number): void {
    // A clock that steps backwards (a manual system-time change, a coarse
    // timer) must never produce a negative duration in the log.
    timings[FIELD_OF[stage]] = Math.max(0, ms)
  }

  return {
    async measure<T>(stage: DeliveryStage, work: () => Promise<T>): Promise<T> {
      const startedAt = now()
      try {
        return await work()
      } finally {
        record(stage, now() - startedAt)
      }
    },
    record,
    absorb(stages: StageTimings | undefined): void {
      if (stages === undefined) return
      for (const [, field] of STAGE_ORDER) {
        const value = stages[field]
        if (value !== undefined && timings[field] === undefined) timings[field] = Math.max(0, value)
      }
    },
    timings: () => ({ ...timings })
  }
}

/**
 * One log-line fragment, e.g. `focus=12ms spawn=4ms relay=5210ms total=5240ms`.
 * Stages this attempt never walked are simply absent rather than printed as
 * zero, so the line says which path the delivery actually took.
 */
export function formatStageTimings(timings: StageTimings): string {
  return STAGE_ORDER.filter(([, field]) => timings[field] !== undefined)
    .map(([stage, field]) => `${stage}=${Math.round(timings[field] as number)}ms`)
    .join(' ')
}
