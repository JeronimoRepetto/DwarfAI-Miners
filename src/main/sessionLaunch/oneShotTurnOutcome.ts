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
  /**
   * Whether `stdoutTail` is this provider's own turn TEXT, or an opaque
   * machine envelope this function must not read as prose (#510 correction).
   *
   * `buildLaunchSpawn` captures every provider's stdout to a file the same
   * way — the capture is deliberately provider-agnostic — but OpenCode is
   * launched with `--format json` (`buildOpenCodeLaunchArgs`, launch.ts),
   * documented only as "raw JSON events" (`opencode run --help`; nothing in
   * `docs/opencode-format.md` covers this stream, only the `opencode.db`
   * store). Before this field existed, a clean-exit OpenCode launch's raw
   * event stream would have been recorded verbatim as the turn's own answer
   * — exactly the silent misreading #510's acceptance criterion (captured
   * text matches what a person reads) rules out. The caller decides this
   * once per provider, from `ONE_SHOT_STDOUT_IS_TURN_TEXT` (launch.ts, beside
   * the argv builders that already decide each provider's own output
   * format) — never guessed here, so the function stays pure and provable
   * with plain strings.
   */
  stdoutIsTurnText: boolean
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
 *
 * A clean exit whose provider is not text-bearing (`stdoutIsTurnText`
 * false, #510 correction) is still `concluded` — process exit is still the
 * completion signal — but carries no `text` at all, never an empty string
 * standing in for one. Absence of text is not a fact here; the ending is.
 * That check comes BEFORE the trim/empty check below on purpose: an opaque
 * envelope that happens to be non-empty must not fall through to
 * `boundTurnText` and be recorded as prose it never was.
 */
export function oneShotTurnOutcome(result: OneShotTurnResult): TurnOutcome {
  if (result.signal !== null) {
    return { kind: 'interrupted', detail: result.signal, endedAt: result.now }
  }
  if (result.exitCode === 0) {
    if (!result.stdoutIsTurnText) return { kind: 'concluded', endedAt: result.now }
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
