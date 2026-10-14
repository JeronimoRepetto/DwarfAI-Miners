// The five-cause table of a launch's own outcome (ADR-020 items 3–4; 07 machine 5B S5.16–S5.21).
// Pure: the facts and the times are passed in; nothing here reads a clock (05 §2.2, R1).
import type { LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type { Instant } from '../../../kernel/domain/values'

/** 15 §0: the early-failure window after spawn (ADR-020 D4; NFR-TIM-06). */
export const EARLY_FAILURE_WINDOW_MS = 3_000

/** 15 §0: the default readiness handshake budget (ADR-020 D4; configurable). */
export const HANDSHAKE_TIMEOUT_MS = 30_000

/** The causes a launch's own process can end with; the two Jev causes are settled in `routing`. */
export type SpawnFailureCause = Extract<
  LaunchFailureCause,
  'not-installed' | 'exited-at-once' | 'could-not-start'
>

/** What the launcher observed, in the order it observed it. */
export type LaunchOutcomeEvent =
  | { kind: 'detect-negative' } // ADR-009 D5 `detect()` said not installed (pre-spawn)
  | { kind: 'spawn-error'; code: string } // the OS refused the spawn (`ENOENT`, `EACCES`, …)
  | { kind: 'shim-refused' } // a refused `.cmd`/`.bat` shim (INV-59), never spawned
  | { kind: 'parser-refused' } // `parseHostedCommand` refused "Other…" (ADR-020 item 3), never spawned
  | { kind: 'ready'; at: Instant } // the driver's readiness handshake completed
  | { kind: 'first-agent-event'; at: Instant } // the session's first agent event (strong evidence)
  | { kind: 'ended'; at: Instant; how: 'exit' | 'error' } // the process exited or errored

export type LaunchOutcome =
  { kind: 'pending' } | { kind: 'succeeded' } | { kind: 'failed'; cause: SpawnFailureCause }

/**
 * Settles a launch from what was observed so far (ADR-020 item 4):
 * - before spawn (`t0` null): `ENOENT` or a negative detect → `not-installed` (S5.16); any other
 *   spawn error, a refused shim or a parser refusal → `could-not-start` (S5.17, item 3);
 * - after spawn at `t0`: it succeeds once the handshake is ready AND (`t0` + 3 s passed OR the first
 *   agent event arrived) (S5.21); an exit or error before that is `exited-at-once` inside the window
 *   (S5.20) and `could-not-start` after it (the handshake never completed); no readiness by
 *   `t0 + handshakeTimeoutMs` is `could-not-start` (S5.19). Otherwise it is still `pending`.
 */
export function classifyLaunchOutcome(
  events: readonly LaunchOutcomeEvent[],
  t0: Instant | null,
  now: Instant,
  handshakeTimeoutMs: number = HANDSHAKE_TIMEOUT_MS
): LaunchOutcome {
  let readyAt: Instant | null = null
  let firstAgentAt: Instant | null = null
  let endedAt: Instant | null = null
  for (const event of events) {
    switch (event.kind) {
      case 'detect-negative':
        return failed('not-installed')
      case 'spawn-error':
        return failed(event.code === 'ENOENT' ? 'not-installed' : 'could-not-start')
      case 'shim-refused':
      case 'parser-refused':
        return failed('could-not-start')
      case 'ready':
        readyAt ??= event.at
        break
      case 'first-agent-event':
        firstAgentAt ??= event.at
        break
      case 'ended':
        endedAt ??= event.at
        break
    }
  }
  if (t0 === null) return { kind: 'pending' }

  const windowEnd = t0 + EARLY_FAILURE_WINDOW_MS
  const succeededAt =
    readyAt === null ? null : Math.max(readyAt, Math.min(firstAgentAt ?? windowEnd, windowEnd))
  if (endedAt !== null && (succeededAt === null || endedAt < succeededAt)) {
    return failed(endedAt < windowEnd ? 'exited-at-once' : 'could-not-start')
  }
  if (succeededAt !== null && succeededAt <= now) return { kind: 'succeeded' }
  if (readyAt === null && now - t0 >= handshakeTimeoutMs) return failed('could-not-start')
  return { kind: 'pending' }
}

function failed(cause: SpawnFailureCause): LaunchOutcome {
  return { kind: 'failed', cause }
}
