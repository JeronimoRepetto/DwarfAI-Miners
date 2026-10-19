// POSIX tree kill of a session the Host launched (ADR-014 item 3, "launched sessions"; 16 §3
// `group: 'owned'`): the Host spawned it as a process-group leader, so one SIGTERM reaches the
// whole group; after the TERM wait, SIGKILL to the identity-checked survivors — including
// descendants that left the group — and to the root (escalate). The group is signalled only when
// the snapshot shows the root still leads it (pgid = pid); otherwise, or without a snapshot, the
// sequence is the foreign one, which never signals a group.
import type { EndOutcome } from '../../../kernel/domain/processIdentity'
import { escalate, openKill } from './escalate'
import { killForeignTree } from './posixForeign'
import { descendantsOf } from './snapshot'
import type { PosixKillDeps } from './types'

export async function killOwnedTree(deps: PosixKillDeps): Promise<EndOutcome> {
  const opened = await openKill(deps)
  if ('outcome' in opened) return opened.outcome
  const { rows } = opened
  const rootRow = rows?.find((row) => row.pid === deps.target.pid)
  if (rows === null || rootRow?.pgid !== deps.target.pid) return killForeignTree(deps, opened)
  const recorded = descendantsOf(rows, deps.target)
  const sent = deps.signal(-deps.target.pid, 'SIGTERM')
  const exited = await deps.waitForExit(deps.target.pid, deps.graceMs)
  return escalate(deps, recorded, { exited, denied: sent === 'denied' }, (pid) =>
    deps.signal(pid, 'SIGKILL')
  )
}
