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
 * WQL-side probe for a live Codex CLI process — a coarse pre-filter, not the
 * verdict. It selects every process whose name or command line mentions
 * "codex" and prints `ProcessId<TAB>Name<TAB>CommandLine` for each, leaving the
 * decision to `isCodexAgentProcess`.
 *
 * The filter used to BE the verdict, and that is issue #374: "mentions codex"
 * matched the Chrome helper of Codex's bundled browser plugin, whose command
 * line is a path under `~/.codex/plugins/`, so a session that had died
 * mid-turn stayed on the board as working for the full idle retention. WQL can
 * only ask whether a string occurs; telling an executable from a path argument
 * needs the rows themselves, which is why they come back here.
 *
 * Two guards stay in the query. `$_.ProcessId -ne $PID` and the PowerShell
 * name exclusion cost nothing and remove the probe's own host, whose
 * CommandLine contains this very query text and therefore the string "codex".
 *
 * `[Console]::Out.WriteLine` bypasses PowerShell's output formatter, which
 * hard-wraps a long line at the host width — a break inside the entry-point
 * path would hide the marker the node shape is recognised by. Exported so
 * tests can pin the projection and these guards.
 */
export const CODEX_PROBE_SCRIPT =
  'Get-CimInstance Win32_Process | Where-Object { ' +
  "$_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|pwsh)' " +
  "-and ($_.Name -match 'codex' -or $_.CommandLine -match 'codex') } " +
  '| ForEach-Object { ' +
  '[Console]::Out.WriteLine(($_.ProcessId, $_.Name, $_.CommandLine) -join [char]9) }'

/**
 * Executable names the Codex agent itself runs under.
 *
 * Measured read-only on 2026-09-10, codex-cli 0.153.4 installed through pnpm
 * (docs/codex-v2-format.md §10): `@openai/codex`'s `bin/codex.js` resolves its
 * native binary to `vendor/<target triple>/bin/codex.exe` on Windows and
 * `.../bin/codex` everywhere else. The triple names the directory, never the
 * file, so there is no `codex-x86_64-pc-windows-msvc.exe` to match.
 *
 * Deliberately not here: `codex-command-runner-<version>.exe` and the other
 * `codex-*` helpers in `~/.codex/.sandbox-bin`. Each runs one command for a
 * session and exits, with that session's own `codex.exe` as its parent — a
 * helper answering for the agent is exactly the mistake #374 was.
 */
export const CODEX_BINARY_NAMES: readonly string[] = ['codex', 'codex.exe']

/**
 * Interpreter names the npm-installed CLI runs under. `codex` on PATH is a
 * shim that execs `node <pkg>/bin/codex.js`, and that node process is the
 * native binary's parent for the whole session, so it is a Codex process too.
 * Bun and Deno are UNMEASURED here; neither shim shape was observed.
 */
const NODE_BINARY_NAMES: readonly string[] = ['node', 'node.exe']

/**
 * The CLI's entry-point script, as the last three segments of its path under
 * either separator.
 *
 * Matching the *script* and not the package directory is the whole point: a
 * command line mentioning `@openai/codex` alone is also produced by an editor
 * with a file from that package open and by `pnpm add -g @openai/codex`. The
 * lookahead requires the path to END there, so a `.map` or a backup beside it
 * does not read as the entry point. This is the "script argument" test without
 * argv quoting rules: nothing but node's script argument carries that path.
 */
const CODEX_CLI_SCRIPT_PATTERN = /[/\\]codex[/\\]bin[/\\]codex\.js(?=["'\s]|$)/i

/**
 * The bundled-plugin tree, whose contents are helpers and never the agent.
 *
 * Belt and braces over the name test rather than a substitute for it, and it
 * catches one case the name test cannot: `~/.codex/plugins/.plugin-appserver/`
 * holds its own `codex.exe` (measured 2026-09-10), which serves plugins rather
 * than a session. So the exclusion is checked FIRST — a genuine agent is never
 * launched from inside this tree.
 */
const CODEX_PLUGIN_TREE_PATTERN = /\.codex[/\\]plugins[/\\]/i

/** One row of the operating system's process list, as a probe reports it. */
export interface ProbeProcessRow {
  pid: number
  /** The executable's own name, not a path — `codex.exe`, `node`, `cmd.exe`. */
  name: string
  commandLine: string
}

/**
 * Whether one process row is a Codex agent — the whole verdict, in one pure
 * function so every shape #374 confused can be asserted without an OS.
 *
 * Two accepted shapes, both measured: the native binary by name, and the node
 * interpreter running the CLI's entry-point script. Nothing is accepted for
 * merely mentioning `.codex` in an argument, which is what a plugin host, an
 * editor holding `~/.codex/config.toml`, and this app's own probe all do.
 */
export function isCodexAgentProcess(row: ProbeProcessRow): boolean {
  if (CODEX_PLUGIN_TREE_PATTERN.test(row.commandLine)) return false
  const name = row.name.trim().toLowerCase()
  if (CODEX_BINARY_NAMES.includes(name)) return true
  return NODE_BINARY_NAMES.includes(name) && CODEX_CLI_SCRIPT_PATTERN.test(row.commandLine)
}

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
 * full command line is readable. Elsewhere `pgrep -f codex` is the same coarse
 * filter over the same two fields — but it must PRINT the command line beside
 * each pid, because a bare pid cannot be judged (#374), and the flag for that
 * differs: procps prints the full command line under `-a`, while macOS pgrep
 * has no `-a` and prints it under `-l` when `-f` is also given.
 */
export function buildCodexProbeCommand(platform: Platform): ProbeCommand {
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-Command', CODEX_PROBE_SCRIPT] }
  }
  if (platform === 'linux') {
    return { command: 'pgrep', args: ['-fa', 'codex'] }
  }
  return { command: 'pgrep', args: ['-fl', 'codex'] }
}

/**
 * Split stdout into rows, folding any line that does not begin a new row into
 * the one before it.
 *
 * Concatenated with no separator on purpose: the break this repairs is a
 * formatter wrap, which splits a line at the host width without inserting
 * anything, so rejoining restores the original exactly. A command line that
 * genuinely contains a newline loses that newline and nothing else, which no
 * test here asks about. A continuation that itself starts like a row is
 * indistinguishable from one and is read as a row; a wrap landing exactly on
 * `<digits><separator>` is the only way there, and it costs at most one row.
 */
function foldProbeRows(stdout: string, startsRow: RegExp): string[] {
  const rows: string[] = []
  for (const line of stdout.split('\n')) {
    const text = line.replace(/\r$/, '')
    if (startsRow.test(text) || rows.length === 0) {
      rows.push(text)
      continue
    }
    rows[rows.length - 1] += text
  }
  return rows
}

/** `ProcessId<TAB>Name<TAB>CommandLine`, as CODEX_PROBE_SCRIPT prints it. */
function parseWindowsProcessRows(stdout: string): ProbeProcessRow[] {
  const rows: ProbeProcessRow[] = []
  for (const row of foldProbeRows(stdout, /^\d+\t/)) {
    const match = /^(\d+)\t([^\t]*)\t([\s\S]*)$/.exec(row)
    if (match !== null) {
      rows.push({
        pid: Number(match[1]),
        name: match[2] as string,
        commandLine: match[3] as string
      })
    }
  }
  return rows
}

/**
 * `<pid> <full command line>`, as `pgrep -fa` / `pgrep -fl` prints it.
 *
 * pgrep reports no executable name of its own, so the name is the basename of
 * argv[0] — the first whitespace-delimited token. pgrep joins argv with plain
 * spaces and quotes nothing, so an interpreter path containing a space would
 * be cut short; that costs a name, and the plugin-tree exclusion and the
 * entry-point test both read the whole line regardless.
 */
function parsePosixProcessRows(stdout: string): ProbeProcessRow[] {
  const rows: ProbeProcessRow[] = []
  for (const row of foldProbeRows(stdout, /^\s*\d+\s+\S/)) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(row)
    if (match === null) continue
    const commandLine = match[2] as string
    const argv0 = commandLine.split(/\s+/)[0] as string
    rows.push({
      pid: Number(match[1]),
      name: argv0.slice(argv0.search(/[^/\\]*$/)),
      commandLine
    })
  }
  return rows
}

/** Route one platform's process-list output to its row parser. */
function parseProcessRows(platform: Platform, stdout: string): ProbeProcessRow[] {
  return platform === 'win32' ? parseWindowsProcessRows(stdout) : parsePosixProcessRows(stdout)
}

/**
 * True when the process list holds a Codex agent other than this one.
 *
 * `selfPid` is filtered out here rather than in the query: this app's own
 * command line mentions `~/.codex`, so it is in the coarse filter's results,
 * and pgrep excludes only itself. That is the POSIX equivalent of the
 * `$_.ProcessId -ne $PID` guard in CODEX_PROBE_SCRIPT, and the one exclusion
 * that never has to be inferred from a string.
 */
export function parseCodexProbeOutput(
  platform: Platform,
  stdout: string,
  selfPid: number
): boolean {
  return parseProcessRows(platform, stdout).some(
    (row) => row.pid !== selfPid && isCodexAgentProcess(row)
  )
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

/**
 * How far two readings of one process's creation time may sit apart before
 * they describe two different processes.
 *
 * Not an equality test, because no two probes here answer in the same unit:
 * `ps -o lstart=` prints whole seconds, /proc/<pid>/stat counts 10ms ticks
 * against a btime the kernel recomputes per read, and the FILETIME conversion
 * truncates. 2s absorbs every one of those artifacts while staying orders of
 * magnitude below any interval a pid is actually recycled over — a recycled pid
 * names a process created seconds to days later, never 2s later.
 *
 * claudeProvider.ts keeps its own PROC_START_TOLERANCE_MS for the registry's
 * procStart guard (#45); same number, same units, same reasoning, and this is
 * the home for it now that a second guard (#231) asks the same question.
 */
export const PROCESS_START_TOLERANCE_MS = 2_000

/**
 * Whether two creation-time readings describe the same process — the one
 * comparison that tells a live launch from an unrelated process wearing its
 * recycled pid. Both sides must be real readings: a caller with `null` in hand
 * has no evidence and must not ask.
 */
export function sameProcessStart(probedMs: number, recordedMs: number): boolean {
  return Math.abs(probedMs - recordedMs) <= PROCESS_START_TOLERANCE_MS
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
        return parseCodexProbeOutput(platform, await run(probe), selfPid)
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
 * True when a Codex agent process is currently running, on whichever platform
 * this is — the native `codex` binary by name, or the node interpreter running
 * the CLI's entry-point script. Not "a process that mentions codex": that
 * counted a bundled-plugin helper and kept a dead session on the board for the
 * whole idle retention (#374). Kept as a free function because it is
 * CodexProvider's default injection point.
 */
export function isCodexProcessRunning(): Promise<boolean> {
  return createProcessProbe().isCodexProcessRunning()
}
