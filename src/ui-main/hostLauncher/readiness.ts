// Readiness (ADR-002 D4 item 3; 07 S12.B03; 13 FM-008): a successful `hello` handshake, never a
// timer or a pid. The endpoint is probed every 50 ms from the moment the wait starts; it ends
//
// - `ready` on a `hello.ok` whose state is `ready` or `upgrade-pending` (a Host past its boot);
//   `starting` and `migrating` keep the UI waiting;
// - `timed-out` after 15 s, or, while the last answer was `migrating`, after up to 15 s + 30 s;
// - `host-exited` as soon as the watched Host is seen to exit with a code other than
//   ALREADY_RUNNING (that Host found another one on the endpoint, which the wait then attaches to).
//
// The connect-and-`hello` attempt itself is the HelloProber port (helloProber.ts).
import type { HelloAnswer, HelloProber, LauncherClock, Sleep } from './ports'
import { HOST_EXIT_CODES } from './hostExitCodes'

/** ADR-002 D4 item 3 (herdr): poll every 50 ms … */
export const READINESS_POLL_MS = 50
/** … and give up after 15 s … */
export const READINESS_BUDGET_MS = 15_000
/** … extended by up to 30 s only while the Host reports `migrating`. */
export const MIGRATING_EXTENSION_MS = 30_000
/** ADR-002 D3: the loser of the spawn gate polls the endpoint every 250 ms. */
export const LOSER_POLL_MS = 250

export type ReadinessOutcome =
  | { kind: 'ready'; answer: Extract<HelloAnswer, { kind: 'hello-ok' }> }
  | { kind: 'timed-out'; lastAnswer: HelloAnswer['kind'] }
  | { kind: 'host-exited'; code: number }

export interface ReadinessDeps {
  probe: HelloProber
  clock: LauncherClock
  sleep: Sleep
  /** The watched Host's exit (LaunchedHost.exited); absent when attaching to a Host already there. */
  exited?: Promise<number | null>
}

/** A `hello.ok` state from which the UI attaches. */
export function isReadyState(state: string): boolean {
  return state === 'ready' || state === 'upgrade-pending'
}

/** ADR-002 D4 item 3: whether the wait is over after `elapsedMs`, given the last answer. */
export function readinessExpired(elapsedMs: number, lastAnswer: HelloAnswer): boolean {
  if (elapsedMs >= READINESS_BUDGET_MS + MIGRATING_EXTENSION_MS) return true
  const migrating = lastAnswer.kind === 'hello-ok' && lastAnswer.state === 'migrating'
  return elapsedMs >= READINESS_BUDGET_MS && !migrating
}

export async function waitForReadiness(deps: ReadinessDeps): Promise<ReadinessOutcome> {
  const start = deps.clock.now()
  // Set by the exit watcher, read by the loop between attempts.
  const watched: { exitCode: number | null } = { exitCode: null }
  void deps.exited?.then((code) => {
    if (code !== null && code !== HOST_EXIT_CODES.ALREADY_RUNNING) watched.exitCode = code
  })
  for (;;) {
    if (watched.exitCode !== null) return { kind: 'host-exited', code: watched.exitCode }
    const answer = await deps.probe()
    if (answer.kind === 'hello-ok' && isReadyState(answer.state)) return { kind: 'ready', answer }
    if (watched.exitCode !== null) return { kind: 'host-exited', code: watched.exitCode }
    if (readinessExpired(deps.clock.now() - start, answer)) {
      return { kind: 'timed-out', lastAnswer: answer.kind }
    }
    await deps.sleep(READINESS_POLL_MS)
  }
}
