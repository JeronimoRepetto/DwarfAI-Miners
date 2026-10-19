// The pure half of scripts/ci/check-elevated-refusal.mjs (ADR-002 D6; 07 S12.03; 13 FM-011): what one elevated start
// of the built Host must show. The hosted Windows runner runs every step elevated (an administrator with UAC off), so
// the checks job can start the real Host with a high-integrity token, the branch the non-elevated OS lane cannot
// reach (src/ui-main/hostLauncher/elevatedRefused.os.test.ts). The Host must refuse with ELEVATED_REFUSED and bind
// nothing. A job that is not elevated fails the check instead of passing it: it would prove nothing.
import { isElevatedRid } from './unelevated.mjs'

/** The Host's exit code for a refused elevated start (src/host/wiring/exitCodes.ts; hostExitCodes.ts). */
export const ELEVATED_REFUSED_EXIT_CODE = 65

/**
 * The verdict on one start.
 * - `rid`: the job token's integrity RID (`whoami /groups`), or null when it could not be read;
 * - `exit`: the Host's exit code, or `'timed-out'` when it had not exited within the budget (it was then ended);
 * - `bound`: whether the Host wrote `run/host.identity` (after its bind) or `run/ui.token`.
 */
export function verdict({ rid, exit, bound }) {
  const level = rid === null ? 'unreadable' : `0x${rid.toString(16)}`
  // isElevatedRid counts an unreadable level as elevated (the safe side for the unelevated probe); here it must not
  // count, because the check proves something only on a token known to be high integrity.
  if (rid === null || !isElevatedRid(rid)) {
    return {
      ok: false,
      message: `this job is not elevated (integrity ${level}): the check proves nothing here`
    }
  }
  if (exit === 'timed-out') {
    return { ok: false, message: 'the Host started elevated and did not exit: it was not refused' }
  }
  if (exit.code !== ELEVATED_REFUSED_EXIT_CODE) {
    return {
      ok: false,
      message: `the Host started elevated exited with ${String(exit.code)}, not ELEVATED_REFUSED (${ELEVATED_REFUSED_EXIT_CODE})`
    }
  }
  if (bound.identityFile || bound.uiToken) {
    return {
      ok: false,
      message: 'the Host refused but bound its endpoint or wrote its uiToken first'
    }
  }
  return {
    ok: true,
    message: `the Host started elevated (integrity ${level}) refused with ELEVATED_REFUSED and bound nothing`
  }
}

/** `--entry <out/host/main.js>`, and nothing else. */
export function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === '--entry' && argv[1] !== '') {
    return { kind: 'run', entry: argv[1] }
  }
  return { kind: 'usage' }
}
