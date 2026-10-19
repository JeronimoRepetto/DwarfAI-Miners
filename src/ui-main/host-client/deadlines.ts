// Main's per-method deadlines (14 §3.10, architect values, config keys; FM-032). Rule: every deadline is longer than
// the longest Host-side timeout the method can wait for (16 §2.6), so a slow but ordinary outcome arrives as its
// typed result, never as TIMEOUT. A TIMEOUT never cancels the Host command and is never re-sent by main: its effects
// still arrive as frames, and a repeat with the same `requestId` returns the settled result (14 §1.6, §3.10).

/** 14 §3.10 "default (queries, preferences, rename, feed, `asking.setStep`)". */
export const DEFAULT_DEADLINE_MS = 10_000

/** The Host's hand-over bound of an answer to its channel (ADR-010 item 8; 16 §2.6), restated for the check (R10). */
export const HOST_ASK_HANDOVER_MS = 30_000

/** 14 §3.10, by method; every other method has the default. */
export const METHOD_DEADLINES_MS: Readonly<Record<string, number>> = Object.freeze({
  'session.snapshot': 15_000, // per page
  'launching.launch': 10_000,
  'launching.launchCustom': 10_000,
  'conversation.send': 10_000,
  'conversation.retry': 10_000,
  'asking.answerQuestion': 45_000, // secret read ≤ 10 s + hand-over ≤ 30 s
  'asking.answerPermission': 45_000,
  'jev.suggest': 20_000,
  'preferences.setOpenCodePermissions': 15_000,
  'preferences.setClaudeHooks': 15_000,
  'preferences.answerWelcome': 30_000,
  'mines.remove': 60_000,
  'crew.stop': 60_000,
  'preferences.resetMetrics': 120_000
})

/** `host.shutdown` by mode: `stop-all` waits for every end, `upgrade-drain` answers at acceptance (14 §3.10). */
const HOST_SHUTDOWN_DEADLINES_MS: Readonly<Record<string, number>> = Object.freeze({
  'stop-all': 60_000,
  'upgrade-drain': 10_000
})

/** The deadline of one call of `method` with `params` (14 §3.10). */
export function deadlineOf(method: string, params: unknown): number {
  if (method === 'host.shutdown') {
    const mode = (params as { mode?: unknown } | null)?.mode
    return (
      (typeof mode === 'string' ? HOST_SHUTDOWN_DEADLINES_MS[mode] : undefined) ??
      DEFAULT_DEADLINE_MS
    )
  }
  return METHOD_DEADLINES_MS[method] ?? DEFAULT_DEADLINE_MS
}
