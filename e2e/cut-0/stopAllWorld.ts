import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChildProcess } from 'node:child_process'
import type { IsolatedProfile } from '../_harness/launchApp.ts'

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

/** The Host's log records of the profile (`<userData>/logs/host-*.jsonl`, 19 §9). */
export function hostLog(profile: IsolatedProfile): Array<Record<string, unknown>> {
  const dir = path.join(profile.userDataDir, 'logs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith('host-'))
    .sort()
    .flatMap((name) => readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * The clean-shutdown marker the Host left in its database (ADR-002 D7; `app_meta`, 09 §8.4): the reason of the last
 * clean exit, and whether it marks the epoch that was running.
 */
export function cleanShutdown(profile: IsolatedProfile): {
  reason: string | null
  ofRunningEpoch: boolean
} {
  const db = new DatabaseSync(path.join(profile.userDataDir, 'host', 'dwarfai.db'), {
    readOnly: true
  })
  try {
    const row = db
      .prepare(
        'SELECT current_host_epoch, clean_shutdown_epoch, clean_shutdown_reason FROM app_meta WHERE id = 1'
      )
      .get() as
      | {
          current_host_epoch: string
          clean_shutdown_epoch: string | null
          clean_shutdown_reason: string | null
        }
      | undefined
    return {
      reason: row?.clean_shutdown_reason ?? null,
      ofRunningEpoch: row !== undefined && row.clean_shutdown_epoch === row.current_host_epoch
    }
  } finally {
    db.close()
  }
}
