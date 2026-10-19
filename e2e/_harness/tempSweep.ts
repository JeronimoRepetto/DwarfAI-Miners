import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The E2E lane's last check (Playwright `globalSetup` / `globalTeardown`; ISSUE-056): every temp folder the harness and
 * its cases make is named `dwarfai-e2e-*` and removed by its own teardown. A run that leaves one behind fails, after
 * the folder is removed, so a leak is a visible defect and never a slowly filling disk. Only folders made during this
 * run are looked at; another run's or another worktree's are never touched.
 */
const PREFIX = 'dwarfai-e2e-'
const RUN_START = 'DWARFAI_E2E_RUN_START'

/** The `dwarfai-e2e-*` folders under the temp folder made at or after `since` (epoch ms). */
export function e2eTempFolders(since: number): string[] {
  const root = tmpdir()
  return readdirSync(root)
    .filter((name) => name.startsWith(PREFIX))
    .map((name) => path.join(root, name))
    .filter((folder) => {
      try {
        return statSync(folder).birthtimeMs >= since
      } catch {
        return false
      }
    })
}

/** `globalSetup`: notes when the run started. */
export function markRunStart(): void {
  process.env[RUN_START] = String(Date.now())
}

/** `globalTeardown`: removes what the run left in the temp folder, and fails the run when it left anything. */
export function sweepRunLeftovers(): void {
  const since = Number(process.env[RUN_START] ?? Date.now())
  const left = e2eTempFolders(since)
  for (const folder of left)
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  if (left.length > 0) {
    throw new Error(`the E2E run left ${left.length} temp folder(s) behind: ${left.join(', ')}`)
  }
}
