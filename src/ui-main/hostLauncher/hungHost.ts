// The identity-checked end of a hung Host (ADR-002 D9 steps 2 and 4; ADR-014 item 2; 07 S12.B13, S12.B14): what the
// person's Retry on `unavailable{unresponsive}` does once the Retry's own `hello` got no answer. The Host launcher is
// the only UI code that starts the Host, and the only one that ends it.
//
// 1. Read `run/host.identity` (09 §1; `hostIdentityRecordSchema`): missing, unreadable or invalid → `identity-missing`.
// 2. Match it by the ADR-014 item 2 identity rule: the same boot (`bootId`; `'unknown'` on either side is a mismatch),
//    and the pid running with a start time within IDENTITY_TOLERANCE_MS of the recorded one (a pid that is gone, or
//    whose start time cannot be read, is a mismatch) → otherwise `identity-mismatch`, and nothing is signalled.
// 3. End **that one process**, never its process group or tree: POSIX `SIGTERM`, then — re-checked first — `SIGKILL`
//    after HUNG_HOST_TERM_GRACE_MS; on Windows one `TerminateProcess` (Node's `process.kill` on Windows). Then wait
//    until its exit is observed, at most HUNG_HOST_EXIT_WAIT_MS from the first signal: `ended`; a refused signal is
//    `end-failed {access-denied}`, a process still alive after the wait `end-failed {still-alive}`.
//
// Nothing here logs: HostClient logs the outcome (`host.hung-end`, 19 §9.1), never the pid or the file path.
import type { HostIdentityRecord } from '@dwarfai/contracts'
import type { LauncherClock, Sleep } from './ports'
import { IDENTITY_TOLERANCE_MS, type StartRead } from './processStart'

/** ADR-002 D9 step 2: `SIGKILL` follows `SIGTERM` after 2 s (POSIX). */
export const HUNG_HOST_TERM_GRACE_MS = 2_000
/** ADR-002 D9 step 2: the exit is waited for at most 5 s. */
export const HUNG_HOST_EXIT_WAIT_MS = 5_000
/** How often the exit is looked for while waiting. */
export const HUNG_HOST_EXIT_POLL_MS = 100

export type HostSignal = 'SIGTERM' | 'SIGKILL'

/** What one signal to one pid did. */
export type SignalResult = 'sent' | 'gone' | 'access-denied' | 'failed'

export interface HungHostPorts {
  platform: 'win32' | 'darwin' | 'linux'
  /** `<hostDataDir>/run/host.identity`, or null when it is missing, unreadable or invalid. */
  readIdentity(): Promise<HostIdentityRecord | null>
  /** This machine's boot id the way the Host derives it (ADR-015 item 4), or null when it cannot be read. */
  currentBootId(): Promise<string | null>
  /** The OS start time of `pid` (processStart.ts). */
  readStart(pid: number): Promise<StartRead>
  /** Sends `signal` to that one pid: never a process group (no negative pid), never a tree. */
  signal(pid: number, signal: HostSignal): SignalResult
  /** Whether a process with `pid` still exists. */
  isAlive(pid: number): boolean
  clock: LauncherClock
  sleep: Sleep
}

export type HungHostEnd =
  | { outcome: 'ended' }
  | { outcome: 'identity-missing' }
  | { outcome: 'identity-mismatch' }
  | { outcome: 'end-failed'; errCode: 'access-denied' | 'still-alive' | 'signal-failed' }

/** ADR-014 item 2: the recorded process is the live one with that pid, in this boot. */
async function matches(ports: HungHostPorts, identity: HostIdentityRecord): Promise<boolean> {
  if (identity.bootId === 'unknown') return false
  const bootId = await ports.currentBootId()
  if (bootId === null || bootId !== identity.bootId) return false
  const start = await ports.readStart(identity.pid)
  return (
    start.kind === 'started' &&
    Math.abs(start.ms - identity.processStartTimeMs) <= IDENTITY_TOLERANCE_MS
  )
}

function failed(result: SignalResult): HungHostEnd | null {
  if (result === 'access-denied') return { outcome: 'end-failed', errCode: 'access-denied' }
  if (result === 'failed') return { outcome: 'end-failed', errCode: 'signal-failed' }
  return null
}

export async function endHungHost(ports: HungHostPorts): Promise<HungHostEnd> {
  const identity = await ports.readIdentity()
  if (identity === null) return { outcome: 'identity-missing' }
  if (!(await matches(ports, identity))) return { outcome: 'identity-mismatch' }

  const { pid } = identity
  const startedAt = ports.clock.now()
  const term = ports.signal(pid, 'SIGTERM')
  if (term === 'gone') return { outcome: 'ended' }
  const termFailed = failed(term)
  if (termFailed !== null) return termFailed

  let killed = ports.platform === 'win32' // TerminateProcess is already the hard end
  for (;;) {
    if (!ports.isAlive(pid)) return { outcome: 'ended' }
    const waited = ports.clock.now() - startedAt
    if (waited >= HUNG_HOST_EXIT_WAIT_MS) return { outcome: 'end-failed', errCode: 'still-alive' }
    if (!killed && waited >= HUNG_HOST_TERM_GRACE_MS) {
      killed = true
      // The pid may have been reused since SIGTERM: SIGKILL goes only to the same process.
      if (!(await matches(ports, identity))) return { outcome: 'ended' }
      const kill = ports.signal(pid, 'SIGKILL')
      if (kill === 'gone') return { outcome: 'ended' }
      const killFailed = failed(kill)
      if (killFailed !== null) return killFailed
      continue
    }
    await ports.sleep(HUNG_HOST_EXIT_POLL_MS)
  }
}
