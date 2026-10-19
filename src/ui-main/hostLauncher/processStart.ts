// Gate owner identity (ADR-002 D3; ADR-014 item 1–2): a process is `(pid, processStartTimeMs)`, and
// a gate owner is alive while its pid runs with a start time within IDENTITY_TOLERANCE_MS of the
// recorded one. The same reader gives this UI's own start time for the gate it takes, so both
// sides of the comparison come from one OS source.
//
// The per-OS rules are the Host's (src/host/platform/process/probe/{win32,linux,darwin}.ts,
// ISSUE-018/019), restated because the UI tree may not import the Host (R10):
// - Windows: `Get-Process … StartTime.ToFileTime()` through Windows PowerShell 5.1 by path, with
//   only the pid put into the script; a pid that is not running answers `gone`.
// - Linux: procfs, `btime` of /proc/stat plus field 22 of /proc/<pid>/stat; no process spawned.
// - macOS: `ps -p <pid> -o lstart=` in the C locale; `ps` exits 1 with no output for an unknown pid.
//
// A read that fails for any other reason is `unknown`, which counts as alive: the gate then waits
// for its 60 s age rule rather than be taken from a live owner (FM-010).
import { readFile } from 'node:fs/promises'
import type { ProcessIdentityProbe } from './ports'
import { windowsPowerShell } from './windows'

/** ADR-014 item 2: the one tolerance on a start-time comparison. */
export const IDENTITY_TOLERANCE_MS = 2_000

/** The bound on one start-time query: the Host's START_TIME_QUERY_TIMEOUT_MS. */
export const START_TIME_QUERY_TIMEOUT_MS = 5_000

/**
 * macOS's own `ps` and `sysctl` by path, never looked up on PATH, which the person's environment decides (the Host's
 * DARWIN_PS and DARWIN_SYSCTL, restated: R10). Windows already runs its System32 tools by path.
 */
export const DARWIN_PS = '/bin/ps'
export const DARWIN_SYSCTL = '/usr/sbin/sysctl'

export type StartRead = { kind: 'started'; ms: number } | { kind: 'gone' } | { kind: 'unknown' }

/** Runs one OS query as an argv array (never a shell), bounded by `timeoutMs`. */
export type QueryRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: Record<string, string> }
) => Promise<
  { ok: true; stdout: string } | { ok: false; cause: string; code?: number; stdout?: string }
>

export interface ProcessStartReaderOptions {
  platform: 'win32' | 'darwin' | 'linux'
  /** Required on Windows and macOS. */
  runQuery?: QueryRunner
  /** Reads a whole text file (Linux); default `fs.readFile`. */
  readText?: (path: string) => Promise<string>
  /** SystemRoot on Windows; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
}

const UNKNOWN: StartRead = { kind: 'unknown' }
const GONE: StartRead = { kind: 'gone' }

export function createProcessStartReader(
  options: ProcessStartReaderOptions
): (pid: number) => Promise<StartRead> {
  const { platform, runQuery } = options
  if (platform === 'linux') {
    const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'))
    return (pid) => readLinux(pid, readText)
  }
  if (runQuery === undefined) return () => Promise.resolve(UNKNOWN)
  if (platform === 'darwin') return (pid) => readDarwin(pid, runQuery)
  const powershell = windowsPowerShell(options.env ?? process.env)
  return (pid) => readWindows(pid, powershell, runQuery)
}

export function createIdentityProbe(
  read: (pid: number) => Promise<StartRead>
): ProcessIdentityProbe {
  return async ({ pid, processStartTimeMs }) => {
    const start = await read(pid)
    if (start.kind === 'unknown') return true
    if (start.kind === 'gone') return false
    return Math.abs(start.ms - processStartTimeMs) <= IDENTITY_TOLERANCE_MS
  }
}

async function readWindows(
  pid: number,
  powershell: string,
  runQuery: QueryRunner
): Promise<StartRead> {
  const script = [
    `$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { 'gone' } else { $p.StartTime.ToFileTime() }"
  ].join('; ')
  const out = await runQuery(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: START_TIME_QUERY_TIMEOUT_MS
  })
  if (!out.ok) return UNKNOWN
  const text = out.stdout.trim()
  if (text === 'gone') return GONE
  const ms = filetimeToEpochMs(text)
  return ms === null ? UNKNOWN : { kind: 'started', ms }
}

async function readLinux(
  pid: number,
  readText: (path: string) => Promise<string>
): Promise<StartRead> {
  let stat: string
  try {
    stat = await readText(`/proc/${Math.trunc(pid)}/stat`)
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT' ? GONE : UNKNOWN
  }
  const procStat = await readText('/proc/stat').catch(() => null)
  if (procStat === null) return UNKNOWN
  const ms = parseLinuxStartTime(stat, procStat)
  return ms === null ? UNKNOWN : { kind: 'started', ms }
}

async function readDarwin(pid: number, runQuery: QueryRunner): Promise<StartRead> {
  const out = await runQuery(DARWIN_PS, ['-p', String(Math.trunc(pid)), '-o', 'lstart='], {
    timeoutMs: START_TIME_QUERY_TIMEOUT_MS,
    env: { LC_ALL: 'C' }
  })
  if (!out.ok) return out.code === 1 && (out.stdout ?? '').trim() === '' ? GONE : UNKNOWN
  const ms = parseDarwinLstart(out.stdout)
  return ms === null ? UNKNOWN : { kind: 'started', ms }
}

/** FILETIME counts 100 ns units since 1601-01-01; epoch ms count from 1970-01-01. */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n

function filetimeToEpochMs(text: string): number | null {
  if (!/^\d{1,20}$/.test(text)) return null
  return Number((BigInt(text) - FILETIME_EPOCH_OFFSET) / 10_000n)
}

/** USER_HZ is fixed at 100 by the kernel ABI whatever CONFIG_HZ is. */
const USER_HZ_MS = 10

/** `btime` plus field 22 `starttime`; the numeric fields resume after the LAST ')' of `comm`. */
function parseLinuxStartTime(stat: string, procStat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const btime = /^btime (\d+)\s*$/m.exec(procStat)
  const ticks = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19]
  if (btime === null || ticks === undefined || !/^\d+$/.test(ticks)) return null
  return Number(btime[1]) * 1_000 + Number(ticks) * USER_HZ_MS
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LSTART =
  /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/

/** `ps -o lstart=` ("Thu Oct  1 12:00:00 2026"), local wall-clock time, one-second resolution. */
function parseDarwinLstart(text: string): number | null {
  const match = LSTART.exec(text)
  if (match === null) return null
  const month = MONTHS.indexOf(match[1] as string)
  if (month < 0) return null
  const [day, hours, minutes, seconds, year] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number
  ]
  return new Date(year, month, day, hours, minutes, seconds).getTime()
}
