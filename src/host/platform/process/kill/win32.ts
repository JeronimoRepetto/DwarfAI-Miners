// Windows tree kill (ADR-014 item 3), for launched and observed sessions alike: after the identity
// check, the descendants are snapshotted first; then `taskkill /PID <pid> /T /F` (execFile, argv
// array, no shell); after the wait, every identity-checked survivor of the recorded descendants —
// a grandchild whose parent link dangled, which taskkill's own walk cannot reach — gets
// `taskkill /PID <survivor> /F`, and a root still running gets `taskkill /PID <root> /F`.
import type { EndOutcome } from '../../../kernel/domain/processIdentity'
import { escalate, openKill } from './escalate'
import { descendantsOf } from './snapshot'
import type { Win32KillDeps } from './types'

/** The argv of one taskkill: the whole tree of `pid`, or `pid` alone; always forced. */
export function taskkillArgs(pid: number, tree: boolean): string[] {
  return tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F']
}

export async function killWin32Tree(deps: Win32KillDeps): Promise<EndOutcome> {
  const opened = await openKill(deps)
  if ('outcome' in opened) return opened.outcome
  const recorded = opened.rows === null ? [] : descendantsOf(opened.rows, deps.target)
  const sent = await deps.taskkill(deps.target.pid, true)
  const exited = await deps.waitForExit(deps.target.pid, deps.graceMs)
  return escalate(deps, recorded, { exited, denied: sent === 'denied' }, (pid) =>
    deps.taskkill(pid, false)
  )
}
