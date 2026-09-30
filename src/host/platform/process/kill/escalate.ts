// The two halves every per-OS kill sequence shares (ADR-014 items 2–3): the identity check and the
// descendant snapshot before the first signal, and the escalation after the first step — re-scan,
// re-check the root, the uncatchable step for identity-checked survivors and the root, and `ended`
// only once the root's exit is observed.
import type { EndOutcome, ProcessIdentity } from '../../../kernel/domain/processIdentity'
import { descendantsOf, survivorsIn } from './snapshot'
import {
  KILL_WAIT_MS,
  type KillDeps,
  type ProcessRow,
  type RootCheck,
  type SignalOutcome
} from './types'

/** Either the outcome already (nothing to signal) or the listing taken before the first signal. */
export type Opened = { outcome: EndOutcome } | { rows: readonly ProcessRow[] | null }

/**
 * ADR-014 item 2: the root is re-verified against the OS; gone or another process = `ended`,
 * unreadable = `no-identity`, both with nothing signalled. Then the snapshot (item 3). The root's
 * own row is read a second time there, just before the first signal: a complete listing without
 * it, or with another start time, means the root is gone.
 */
export async function openKill(deps: KillDeps): Promise<Opened> {
  const check = await deps.checkRoot()
  if (check === 'gone') return { outcome: { kind: 'ended' } }
  if (check === 'unknown') return { outcome: { kind: 'failed', reason: 'no-identity' } }
  const rows = await deps.snapshot()
  if (rows !== null && survivorsIn(rows, [deps.target]).length === 0) {
    return { outcome: { kind: 'ended' } }
  }
  return { rows }
}

/**
 * After the first step and its wait: re-snapshot; the survivors are the recorded descendants still
 * running with their identity, plus — while the root lives — its descendants now. The root is
 * re-checked before its uncatchable step; a root that is no longer the recorded process is never
 * signalled. Survivors are logged, never a failure; `ended` only once the root's exit is observed
 * (poll ≤ KILL_WAIT_MS after the last signal).
 */
export async function escalate(
  deps: KillDeps,
  recorded: readonly ProcessIdentity[],
  firstStep: { exited: boolean; denied: boolean },
  force: (pid: number) => SignalOutcome | Promise<SignalOutcome>
): Promise<EndOutcome> {
  let { exited, denied } = firstStep
  const rows = await deps.snapshot()
  const survivors = rows === null ? [] : survivorsIn(rows, recorded)
  let rootCheck: RootCheck = 'gone'
  if (!exited) {
    if (rows !== null) {
      const known = new Set(survivors.map((survivor) => survivor.pid))
      for (const now of descendantsOf(rows, deps.target)) {
        if (!known.has(now.pid)) survivors.push(now)
      }
    }
    rootCheck = await deps.checkRoot()
    if (rootCheck === 'gone') exited = true
  }
  if (survivors.length > 0) deps.reportSurvivors(survivors.length)
  for (const survivor of survivors) await force(survivor.pid)
  if (exited) return { kind: 'ended' }
  // The root is alive, but its identity cannot be read now: it is never signalled (06 INV-51).
  if (rootCheck === 'unknown') return { kind: 'failed', reason: 'no-identity' }
  const last = await force(deps.target.pid)
  if (last === 'denied') denied = true
  exited = await deps.waitForExit(deps.target.pid, KILL_WAIT_MS)
  if (exited) return { kind: 'ended' }
  return { kind: 'failed', reason: denied ? 'access-denied' : 'still-alive' }
}
