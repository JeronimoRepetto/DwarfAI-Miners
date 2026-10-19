import type { ChildProcess } from 'node:child_process'

/** Whether the app's process exits within `ms`. */
export async function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(child.exitCode !== null || child.signalCode !== null),
      ms
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// AMENDED for ISSUE-241, the end of cut 4 (was: also `hostLog` and `cleanShutdown`, read only by the deleted
// stop-all-legacy-first case, `LegacyEndFirstAdapter` on A-N26): the adapter left the tree.
