// Windows start-time and boot-id reader (ADR-014 item 1, ADR-015 items 1 and 4). Kept from the
// legacy `parseWindowsProcessStart` / `filetimeToEpochMs` rule (candidate adapted, ISSUE-018).
// PowerShell is run as a program with an argv array (never `shell: true`, never `wmic`); only a
// number is ever interpolated into its script.
import {
  BOOT_ID_QUERY_TIMEOUT_MS,
  START_TIME_QUERY_TIMEOUT_MS,
  parsed,
  type OsProcessReader,
  type QueryRunner,
  type ReadOutcome
} from './types'

/** FILETIME counts 100 ns units since 1601-01-01; epoch ms count from 1970-01-01. */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n
/** 2000-01-01 … 2200-01-01: anything outside is not a process start this app can meet. */
const MIN_PLAUSIBLE_EPOCH_MS = 946_684_800_000
const MAX_PLAUSIBLE_EPOCH_MS = 7_258_118_400_000

const POWERSHELL = 'powershell.exe'
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'] as const

/** A FILETIME digit run as epoch ms (BigInt: FILETIMEs exceed 2^53), or null when implausible. */
export function filetimeToEpochMs(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,20}$/.test(trimmed)) return null
  const epochMs = Number((BigInt(trimmed) - FILETIME_EPOCH_OFFSET) / 10_000n)
  if (epochMs < MIN_PLAUSIBLE_EPOCH_MS || epochMs > MAX_PLAUSIBLE_EPOCH_MS) return null
  return epochMs
}

export function createWin32Reader(deps: { runQuery: QueryRunner }): OsProcessReader {
  const run = async (script: string, timeoutMs: number): Promise<ReadOutcome<number>> =>
    parsed(await deps.runQuery(POWERSHELL, [...PS_FLAGS, script], { timeoutMs }), filetimeToEpochMs)
  return {
    startTimeMs(pid) {
      return run(
        `(Get-Process -Id ${Math.trunc(pid)}).StartTime.ToFileTime()`,
        START_TIME_QUERY_TIMEOUT_MS
      )
    },
    async bootId() {
      // ADR-015 item 4: Windows has no boot id as such; it is the OS last boot instant, rounded to
      // the second, written as epoch ms. The OS keeps that instant, so every read in one boot agrees.
      const bootMs = await run(
        '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTime()',
        BOOT_ID_QUERY_TIMEOUT_MS
      )
      return bootMs.ok
        ? { ok: true, value: String(Math.round(bootMs.value / 1_000) * 1_000) }
        : bootMs
    }
  }
}
