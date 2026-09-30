// POSIX tree kill of a session DwarfAI did not start (ADR-014 item 3, "observed sessions"): the
// process group is the person's terminal's, so no group is ever signalled; the snapshotted
// descendants get SIGTERM leaves first, then the root; after the TERM wait the survivors and the
// root get SIGKILL, identity-checked (escalate).
import type { EndOutcome } from '../../../kernel/domain/processIdentity'
import { escalate, openKill } from './escalate'
import { descendantsOf } from './snapshot'
import type { PosixKillDeps, ProcessRow } from './types'

export async function killForeignTree(
  deps: PosixKillDeps,
  opened?: { rows: readonly ProcessRow[] | null }
): Promise<EndOutcome> {
  let rows: readonly ProcessRow[] | null
  if (opened === undefined) {
    const result = await openKill(deps)
    if ('outcome' in result) return result.outcome
    rows = result.rows
  } else rows = opened.rows
  const recorded = rows === null ? [] : descendantsOf(rows, deps.target)
  for (const descendant of recorded) deps.signal(descendant.pid, 'SIGTERM')
  const sent = deps.signal(deps.target.pid, 'SIGTERM')
  const exited = await deps.waitForExit(deps.target.pid, deps.graceMs)
  return escalate(deps, recorded, { exited, denied: sent === 'denied' }, (pid) =>
    deps.signal(pid, 'SIGKILL')
  )
}
