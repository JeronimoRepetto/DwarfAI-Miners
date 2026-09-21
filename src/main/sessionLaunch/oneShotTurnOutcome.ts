import { boundTurnText, type TurnOutcome } from '../domain/types'

/**
 * One detached launch's own exit, already read back and bounded by the
 * caller (#510) — `launchRunner.ts`'s `TurnOutcomeWatch` is what reads
 * `stdoutTail`/`stderrTail` off the temp files a launch captured and bounds
 * them to `STDOUT_TAIL_BYTES`/`STDERR_TAIL_BYTES` before this function ever
 * sees them, exactly as `resultTurnOutcome` (`claudeTurnOutcome.ts`) is
 * handed an already-extracted `result` string rather than a raw SDK stream.
 * Keeping the byte-level read out of this function is what lets it be proven
 * with plain strings and no temp file at all.
 */
/**
 * How much of a stderr tail an `errored` detail may carry (#510). The runner
 * reads back up to `STDERR_TAIL_BYTES` (4 KB); `detail` is a one-line word for
 * what happened — the panel draws it in parentheses after "Last turn failed" —
 * not a log viewer, so the tail is cut here and the cut is marked with an
 * ellipsis rather than hidden. A product default, not a measured constant.
 */
export const ERRORED_DETAIL_MAX_CHARS = 240

function shortenDetail(stderr: string): string {
  return stderr.length > ERRORED_DETAIL_MAX_CHARS
    ? `${stderr.slice(0, ERRORED_DETAIL_MAX_CHARS)}…`
    : stderr
}

export interface OneShotTurnResult {
  /** Node's own exit shape: the process's own code, or null when a signal ended it. */
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdoutTail: string
  stderrTail: string
  now: number
}

/**
 * A completed one-shot launch's own exit, mapped onto this app's turn-outcome
 * vocabulary (#510) — the detached-launch twin of `resultTurnOutcome`. There
 * is no SDK here to report a distinct cap, so `'capped'` never comes out of
 * this function: a bare process exit carries a code and, at most, a signal —
 * nothing a one-shot CLI's own `--help` documents as "this turn hit a limit
 * rather than finishing", so inventing that reading from an exit code would
 * be exactly the heuristic issue #510 rules out.
 *
 * A clean exit (code 0) with nothing on stdout is still `concluded` — process
 * exit is the completion signal, not the text — so an empty answer records a
 * turn that ended with nothing to say, never an absent outcome. Trimmed
 * before the emptiness check: a CLI's stdout almost always ends in a trailing
 * newline, and a turn that said nothing must not be recorded as if `'\n'`
 * were its answer.
 *
 * A non-zero exit is `errored`, `detail` naming the code and, when the
 * caller's stderr tail was non-empty, a short readable summary of it — the
 * one-shot path's equivalent of a Claude subtype, except there is no fixed
 * vocabulary to read, so the CLI's own words stand in for one. A signal ends
 * the branch differently: Node reports a signal-terminated exit with `code`
 * null and `signal` set, and that is `interrupted`, `detail` the signal's own
 * name — never text, because a killed process did not conclude anything.
 *
 * `exitCode === null` with `signal === null` cannot happen on Node's own
 * `'exit'` event (one of the two is always set), but the type still allows
 * it, and this function reads it as `errored` rather than defaulting to a
 * silent `concluded` — an exit this app cannot explain is never mistaken for
 * a quiet success.
 */
export function oneShotTurnOutcome(result: OneShotTurnResult): TurnOutcome {
  if (result.signal !== null) {
    return { kind: 'interrupted', detail: result.signal, endedAt: result.now }
  }
  if (result.exitCode === 0) {
    const trimmed = result.stdoutTail.trim()
    if (trimmed === '') return { kind: 'concluded', endedAt: result.now }
    const { text, truncated } = boundTurnText(trimmed)
    return {
      kind: 'concluded',
      text,
      ...(truncated ? { truncated: true } : {}),
      endedAt: result.now
    }
  }
  const code = result.exitCode === null ? 'unknown' : String(result.exitCode)
  const stderr = result.stderrTail.trim()
  const detail = stderr === '' ? `exit ${code}` : `exit ${code}: ${shortenDetail(stderr)}`
  return { kind: 'errored', detail, endedAt: result.now }
}
