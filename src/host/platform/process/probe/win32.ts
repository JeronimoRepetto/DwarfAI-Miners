// Windows start-time and boot-id reader (ADR-014 item 1, ADR-015 items 1 and 4). Kept from the
// legacy `parseWindowsProcessStart` / `filetimeToEpochMs` rule (candidate adapted, ISSUE-018).
// PowerShell is run as a program with an argv array (never `shell: true`, never `wmic`), by its
// full path under SystemRoot and without an inherited PSModulePath (ISSUE-019); only a number is
// ever interpolated into its script.
import {
  BOOT_ID_QUERY_TIMEOUT_MS,
  POWERSHELL_DROPPED_ENV,
  START_TIME_QUERY_TIMEOUT_MS,
  parsed,
  windowsPowerShell,
  windowsSystemTool,
  type OsProcessReader,
  type QueryRunner,
  type ReadOutcome
} from './types'

/** FILETIME counts 100 ns units since 1601-01-01; epoch ms count from 1970-01-01. */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n
/** 2000-01-01 … 2200-01-01: anything outside is not a process start this app can meet. */
const MIN_PLAUSIBLE_EPOCH_MS = 946_684_800_000
const MAX_PLAUSIBLE_EPOCH_MS = 7_258_118_400_000

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'] as const

/**
 * The registry key whose `BootId` value Windows increments at every boot (a REG_DWORD, readable
 * without elevation). ISSUE-019 (S-015-2): it replaces the CIM `LastBootUpTime` instant as the
 * boot id, which took 413–704 ms warm and exceeded the frozen 2 000 ms bound (16 §2.6) on a cold
 * CI runner; `reg.exe` answers in 23–110 ms, with no PowerShell on the identity path.
 */
export const WIN32_BOOT_ID_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters'

const BOOT_ID_VALUE = /^\s*BootId\s+REG_DWORD\s+0x([0-9a-fA-F]{1,8})\s*$/m

/** A FILETIME digit run as epoch ms (BigInt: FILETIMEs exceed 2^53), or null when implausible. */
export function filetimeToEpochMs(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,20}$/.test(trimmed)) return null
  const epochMs = Number((BigInt(trimmed) - FILETIME_EPOCH_OFFSET) / 10_000n)
  if (epochMs < MIN_PLAUSIBLE_EPOCH_MS || epochMs > MAX_PLAUSIBLE_EPOCH_MS) return null
  return epochMs
}

/** The `BootId` counter of a `reg query … /v BootId` answer, as a decimal string, or null. */
export function parseRegBootId(text: string): string | null {
  const match = BOOT_ID_VALUE.exec(text)
  return match === null ? null : String(Number.parseInt(match[1] as string, 16))
}

export function createWin32Reader(deps: {
  runQuery: QueryRunner
  env?: Readonly<Record<string, string | undefined>>
}): OsProcessReader {
  const run = async (script: string, timeoutMs: number): Promise<ReadOutcome<number>> =>
    parsed(
      await deps.runQuery(windowsPowerShell(deps.env), [...PS_FLAGS, script], {
        timeoutMs,
        dropEnv: POWERSHELL_DROPPED_ENV
      }),
      filetimeToEpochMs
    )
  return {
    startTimeMs(pid) {
      return run(
        `(Get-Process -Id ${Math.trunc(pid)}).StartTime.ToFileTime()`,
        START_TIME_QUERY_TIMEOUT_MS
      )
    },
    async bootId() {
      // ADR-015 item 4 as decided in ISSUE-019 (S-015-2): Windows has no boot id as such; the
      // registry BootId boot counter is one, exact per boot, so every read in one boot agrees.
      const out = await deps.runQuery(
        windowsSystemTool('reg.exe', deps.env),
        ['query', WIN32_BOOT_ID_KEY, '/v', 'BootId'],
        { timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS }
      )
      return parsed(out, parseRegBootId)
    }
  }
}
