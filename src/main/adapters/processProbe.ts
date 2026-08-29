import { execFile } from 'node:child_process'
import type { Platform } from '../platform/platform'
import { currentPlatform } from '../platform/platform'

/**
 * Is a Codex CLI process running right now?
 *
 * Codex sessions have no pid or lock file, so asking the operating system for
 * its process list is the only way to tell an idle-but-open TUI from a closed
 * one. The query is per-OS; the parsing and the verdict are not, so both stay
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

/** What CodexProvider needs from the operating system's process list. */
export interface ProcessProbePort {
  isCodexProcessRunning(): Promise<boolean>
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
