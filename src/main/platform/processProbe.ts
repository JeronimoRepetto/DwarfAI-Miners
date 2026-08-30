import { execFile } from 'node:child_process'
import type { Platform } from './platform'
import { currentPlatform } from './platform'

/**
 * Questions only the operating system's process list can answer.
 *
 * Two of them today: is a Codex CLI process running right now (Codex sessions
 * have no pid or lock file, so this is the only way to tell an idle-but-open
 * TUI from a closed one), and when was a given pid's process actually created
 * (the one fact that distinguishes the process a Claude registry entry was
 * written about from an unrelated process that inherited its recycled pid).
 * Every query is per-OS; the parsing and the verdict are not, so both stay
 * pure and unit-tested and only the spawn is integration territory.
 */

/**
 * WQL-side probe for a live Codex CLI process. The probing powershell.exe's
 * own CommandLine contains this very query text (and therefore the string
 * "codex"), so the filter MUST exclude the probe's own process and every
 * PowerShell host — otherwise the probe always matches itself and reports
 * codex as running unconditionally. Exported so tests can pin these guards.
 */
export const CODEX_PROBE_SCRIPT =
  'Get-CimInstance Win32_Process | Where-Object { ' +
  "$_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|pwsh)' " +
  "-and ($_.Name -match 'codex' -or $_.CommandLine -match 'codex') } " +
  '| Select-Object -First 1 -ExpandProperty ProcessId'

/** One process-list query, as an argv pair that never goes through a shell. */
export interface ProbeCommand {
  command: string
  args: string[]
}

/** Runs one probe command and resolves its stdout. */
export type ProbeRunner = (command: ProbeCommand) => Promise<string>

/** What the providers need from the operating system's process list. */
export interface ProcessProbePort {
  isCodexProcessRunning(): Promise<boolean>
  /**
   * When the process that owns `pid` was created, as epoch milliseconds, or
   * null when the answer cannot be determined (pid gone, tool missing, output
   * unparseable). Callers treat null as "unknown", never as "dead" — the
   * pid-reuse guard must fail open rather than kill a live session.
   */
  processStartTimeMs(pid: number): Promise<number | null>
}

/**
 * The process-list query for one platform.
 *
 * Windows goes through PowerShell because Win32_Process is the only place a
 * full command line is readable. Every other platform uses `pgrep -f`, which
 * matches the same two things the WQL filter does (the executable name and the
 * full command line) in one call.
 */
export function buildCodexProbeCommand(platform: Platform): ProbeCommand {
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-Command', CODEX_PROBE_SCRIPT] }
  }
  return { command: 'pgrep', args: ['-f', 'codex'] }
}

/**
 * True when the probe found a codex process other than this one.
 *
 * `pgrep -f codex` has the same self-match pitfall as the Windows script: it
 * matches any process whose command line merely mentions "codex", and this
 * app's own process is in that list. pgrep excludes itself, but nothing
 * excludes the caller, so `selfPid` is filtered out here — the POSIX
 * equivalent of the `$_.ProcessId -ne $PID` guard in CODEX_PROBE_SCRIPT.
 */
export function parseCodexProbeOutput(stdout: string, selfPid: number): boolean {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
    .some((pid) => pid !== selfPid)
}

/**
 * The process-creation-time query for one platform.
 *
 * Windows asks Get-Process for a FILETIME because that is the exact unit the
 * Claude registry records in procStart — no date parsing, no timezone. Linux
 * reads /proc/<pid>/stat (field 22, ticks since boot) together with /proc/stat
 * (btime) in one spawn, because ticks are meaningless without the boot time
 * observed at the same moment. macOS uses `ps -o lstart=`, the only stock ps
 * column that prints an unambiguous year. Only a number is ever interpolated,
 * so no command here can be steered by data this app read off disk.
 */
export function buildProcessStartProbeCommand(platform: Platform, pid: number): ProbeCommand {
  const id = Math.trunc(pid)
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', `(Get-Process -Id ${id}).StartTime.ToFileTime()`]
    }
  }
  if (platform === 'linux') {
    return { command: 'cat', args: [`/proc/${id}/stat`, '/proc/stat'] }
  }
  return { command: 'ps', args: ['-p', String(id), '-o', 'lstart='] }
}

/** FILETIME counts 100ns units since 1601-01-01; epoch counts ms since 1970-01-01. */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n

/**
 * Sanity window for a converted start time: 2000-01-01 to 2200-01-01. The
 * registry's procStart is documented as a FILETIME, but a Claude Code build on
 * another OS could one day record a different unit under the same key; a
 * conversion landing outside any plausible process lifetime must disable the
 * guard (null) rather than declare every session on the machine dead.
 */
const MIN_PLAUSIBLE_EPOCH_MS = 946_684_800_000
const MAX_PLAUSIBLE_EPOCH_MS = 7_258_118_400_000

/**
 * A Windows FILETIME string as epoch milliseconds, or null when the value is
 * not a digit run or converts to an implausible instant. BigInt keeps the
 * arithmetic exact: FILETIME values exceed Number.MAX_SAFE_INTEGER.
 */
export function filetimeToEpochMs(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d{1,20}$/.test(trimmed)) return null
  const epochMs = Number((BigInt(trimmed) - FILETIME_EPOCH_OFFSET) / 10_000n)
  if (epochMs < MIN_PLAUSIBLE_EPOCH_MS || epochMs > MAX_PLAUSIBLE_EPOCH_MS) return null
  return epochMs
}

/** Parse `(Get-Process -Id <pid>).StartTime.ToFileTime()` output; null when it printed no FILETIME. */
export function parseWindowsProcessStart(stdout: string): number | null {
  return filetimeToEpochMs(stdout)
}

/**
 * Parse the concatenated `/proc/<pid>/stat` + `/proc/stat` output into epoch
 * milliseconds.
 *
 * The pid line is the only one containing parentheses (comm is always
 * parenthesized; /proc/stat rows never are), which also makes a dead pid
 * detectable: cat keeps going after a missing first file, so only /proc/stat
 * comes back and no line qualifies. comm may itself contain spaces and closing
 * parens, so the numeric fields resume after the LAST ')'. starttime is field
 * 22 overall — index 19 after the comm — in USER_HZ ticks since boot, and
 * USER_HZ is fixed at 100 by the kernel ABI regardless of CONFIG_HZ, so one
 * tick is 10ms without a getconf round trip.
 */
export function parseLinuxProcessStart(stdout: string): number | null {
  const statLine = stdout.split('\n').find((line) => line.includes('(') && line.includes(')'))
  const btimeMatch = /^btime (\d+)$/m.exec(stdout)
  if (statLine === undefined || btimeMatch === null) return null
  const fieldsAfterComm = statLine
    .slice(statLine.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  const startTicks = Number(fieldsAfterComm[19])
  if (!Number.isFinite(startTicks)) return null
  return Number(btimeMatch[1]) * 1_000 + startTicks * 10
}

const DARWIN_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11
}

/**
 * Parse `ps -o lstart=` output ("Sat Aug 29 11:07:36 2026") into epoch
 * milliseconds. lstart prints local wall-clock time, so the Date component
 * constructor — the local-time interpretation — recovers the right instant.
 * Resolution is one second, well inside the guard's tolerance; the one hour
 * repeated by a DST fall-back is genuinely ambiguous, but a session started
 * inside it can at worst re-appear after a restart, never type anywhere wrong.
 */
export function parseDarwinProcessStart(stdout: string): number | null {
  const match =
    /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(
      stdout
    )
  if (match === null) return null
  const month = DARWIN_MONTHS[match[1] as string]
  if (month === undefined) return null
  return new Date(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  ).getTime()
}

/** Route one platform's start-time probe output to its parser. */
function parseProcessStartOutput(platform: Platform, stdout: string): number | null {
  if (platform === 'win32') return parseWindowsProcessStart(stdout)
  if (platform === 'linux') return parseLinuxProcessStart(stdout)
  return parseDarwinProcessStart(stdout)
}

function runProbeCommand(probe: ProbeCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(probe.command, probe.args, { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      // A non-zero exit is a normal "no match" answer (pgrep exits 1), not a
      // failure: whatever was printed is still the verdict.
      if (error !== null && typeof error.code !== 'number') {
        reject(error) // the probe binary could not be started at all
        return
      }
      resolve(stdout)
    })
  })
}

export interface ProcessProbeOptions {
  platform?: Platform
  /** Injected for tests; defaults to a real child-process spawn. */
  run?: ProbeRunner
  /** This process's pid, excluded from the results; defaults to process.pid. */
  selfPid?: number
}

/** The process probe for one platform. Nothing is spawned until it is asked. */
export function createProcessProbe(options: ProcessProbeOptions = {}): ProcessProbePort {
  const platform = options.platform ?? currentPlatform()
  const run = options.run ?? runProbeCommand
  const selfPid = options.selfPid ?? process.pid
  const probe = buildCodexProbeCommand(platform)
  return {
    async isCodexProcessRunning(): Promise<boolean> {
      try {
        return parseCodexProbeOutput(await run(probe), selfPid)
      } catch {
        // Missing binary, timeout, access denied — all "unknown", reported as
        // not running rather than blocking or throwing inside a poll tick.
        return false
      }
    },
    async processStartTimeMs(pid: number): Promise<number | null> {
      try {
        return parseProcessStartOutput(
          platform,
          await run(buildProcessStartProbeCommand(platform, pid))
        )
      } catch {
        // Same classes of failure as above, but the honest answer here is
        // "unknown" (null), which the pid-reuse guard reads as alive — an
        // errored probe must never make a live dwarf disappear.
        return null
      }
    }
  }
}

/**
 * True when a process whose name or command line mentions "codex" is currently
 * running, on whichever platform this is. Kept as a free function because it is
 * CodexProvider's default injection point.
 */
export function isCodexProcessRunning(): Promise<boolean> {
  return createProcessProbe().isCodexProcessRunning()
}
