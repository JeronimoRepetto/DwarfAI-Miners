// The Host's single-instance rule (ADR-002 D3; 07 S12.02; 13 FM-009, FM-037): the UI endpoint bind
// is the mutex. Pure: the endpoint of ISSUE-022 binds, probes an endpoint in use with a `hello`,
// reports what it found, and follows the decision.
//
// - bound → the boot continues (S12.04 follows).
// - in use and the existing endpoint answers `hello` → this Host exits ALREADY_RUNNING (S12.02).
// - in use by a stale POSIX socket (the file exists, nothing listens) → remove it and bind again,
//   once; a second stale answer is an error (FM-037 → the UI sees `spawn-failed`).
// - in use by something that never answers `hello` (on Windows a pipe name taken by another
//   process, on POSIX a listener that is not a Host) → an error, and nothing is removed.
// - any other bind failure (permissions, a socket path over the `sun_path` limit) → an error.

/** One bind attempt as the endpoint saw it; `retried` is true for the attempt after a removal. */
export type BindAttempt =
  | { outcome: 'bound'; retried: boolean }
  | { outcome: 'in-use'; existing: 'answers-hello' | 'stale-socket' | 'no-hello'; retried: boolean }
  | { outcome: 'failed'; errCode: string; retried: boolean }

export type BindDecision =
  | { kind: 'continue' }
  | { kind: 'exit'; refusal: 'ALREADY_RUNNING' }
  | { kind: 'remove-stale-and-retry' }
  | { kind: 'error'; cause: 'stale-socket-again' | 'in-use-without-hello' }
  | { kind: 'error'; cause: 'bind-failed'; errCode: string }

export function decideBind(attempt: BindAttempt): BindDecision {
  switch (attempt.outcome) {
    case 'bound':
      return { kind: 'continue' }
    case 'failed':
      return { kind: 'error', cause: 'bind-failed', errCode: attempt.errCode }
    case 'in-use':
      if (attempt.existing === 'answers-hello') return { kind: 'exit', refusal: 'ALREADY_RUNNING' }
      if (attempt.existing === 'no-hello') return { kind: 'error', cause: 'in-use-without-hello' }
      return attempt.retried
        ? { kind: 'error', cause: 'stale-socket-again' }
        : { kind: 'remove-stale-and-retry' }
  }
}
