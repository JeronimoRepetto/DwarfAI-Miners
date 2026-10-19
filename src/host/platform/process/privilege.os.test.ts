// L8 OS lane (17 §1.8): the real privilege facts of the user running the tests, one describe per
// OS. Runs only in `pnpm test:os`. The expected elevation is the OS's own answer, read another way:
// a normal start is not elevated, while CI's Windows runner runs elevated (an administrator with
// UAC off), so a fixed `false` would assert something untrue there.
// AMENDED for ISSUE-051: CI's Windows legs run the OS lane as a standard local user
// (scripts/ci/run-unelevated.mjs), so on Windows the test user is also asserted not elevated.
import { release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createQueryRunner } from './NodeProcessControl'
import { createPrivilegeCheck } from './privilege'
import { POWERSHELL_DROPPED_ENV, windowsPowerShell } from './probe/types'
import { createNativeProcessInJob } from '../endpoint/win-pipe/nativeProcessInJob'

/** The native binaries: prebuilds/ at the repository root (`pnpm build:native`), or DWARFAI_WIN_PREBUILDS. */
const PREBUILDS =
  process.env.DWARFAI_WIN_PREBUILDS ??
  join(fileURLToPath(new URL('../../../../', import.meta.url)), 'prebuilds')

/** Windows' own answer: is this token an administrator one with the role enabled (elevated)? */
async function windowsSaysElevated(): Promise<boolean> {
  const out = await createQueryRunner()(
    windowsPowerShell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ],
    { timeoutMs: 20_000, dropEnv: POWERSHELL_DROPPED_ENV }
  )
  if (!out.ok) throw new Error(`the elevation oracle failed: ${out.cause}`)
  return out.stdout.trim() === 'True'
}

describe.runIf(process.platform === 'win32')('privilege check on Windows', () => {
  it('[ADR-002] the privilege check reports the OS elevation for the test user (not elevated on a normal start) and IsProcessInJob returns a value on Windows', async ({
    annotate
  }) => {
    // AMENDED for ISSUE-056 (was: the PowerShell job read): the job status is the Host's own native read, as the
    // Host's composition root takes it; the expectations are unchanged.
    const check = createPrivilegeCheck({
      runQuery: createQueryRunner(),
      readInJob: createNativeProcessInJob({ prebuildsDir: PREBUILDS })
    })

    const [report, elevated] = await Promise.all([check(), windowsSaysElevated()])

    await annotate(`ADR-002 D6 ${JSON.stringify({ release: release(), report, elevated })}`)
    expect(report.elevated).toEqual({ ok: true, value: elevated })
    // AMENDED for ISSUE-051: ISSUE-021's L8 case is "not elevated for the test user". CI's Windows legs now run the
    // OS lane as a standard local user (scripts/ci/run-unelevated.mjs), so a lane that ran elevated, where the real
    // Host refuses to start (ADR-002 D6), fails here, loudly, instead of passing on an elevated runner.
    expect(elevated, 'the OS lane runs as a non-elevated test user').toBe(false)
    expect(report.elevated).toEqual({ ok: true, value: false })
    expect(report.inJob).toEqual({ ok: true, value: expect.any(Boolean) })
  }, 30_000)
})

describe.runIf(process.platform !== 'win32')('privilege check on POSIX', () => {
  it('[ADR-002] the privilege check reports not elevated for a non-root test user and no job objects outside Windows', async ({
    annotate
  }) => {
    const report = await createPrivilegeCheck()()

    await annotate(`ADR-002 D6 ${JSON.stringify({ platform: process.platform, report })}`)
    if (process.geteuid?.() !== 0) expect(report.elevated).toEqual({ ok: true, value: false })
    else expect(report.elevated.ok).toBe(true)
    expect(report.inJob).toBe('not-applicable')
  })
})
