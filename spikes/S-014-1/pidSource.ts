// Spike S-014-1 (ADR-014 item 2; spike register S-014-1): the candidate pid source for observed sessions whose files
// carry no pid (Codex, Antigravity; OpenCode until verified). It lists the processes of this OS user, keeps the
// provider's root processes, and attributes one of them to an observed session by working folder and start time. It
// answers one identity, or no identity: never a guess (ADR-014 item 2, "No process identity").
//
// Per OS, the facts come from:
// - Linux: procfs (`stat`, `cmdline`, the `exe` and `cwd` links), no process spawned.
// - macOS: `ps -A -o pid=,ppid=,lstart=,args=` in the C locale, then `lsof -a -d cwd -Fn` for the provider rows only.
// - Windows: CIM `Win32_Process` through Windows PowerShell 5.1 (as the probe does, never `wmic`), and the working
//   folder read from each provider row's process parameters (PEB) with `NtQueryInformationProcess` and
//   `ReadProcessMemory`, compiled in memory by `Add-Type`. Node cannot read another process's working folder on
//   Windows; this is the spike's way to measure whether a non-elevated reader can.
//
// Spike code, not production: the gated issue (ISSUE-079) adopts its decision through the kernel `ProcessControl`.
import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import {
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../src/host/kernel/domain/processIdentity'
import { parseDarwinLstart } from '../../src/host/platform/process/probe/darwin'
import { parseLinuxStartTime } from '../../src/host/platform/process/probe/linux'
import { windowsPowerShell } from '../../src/host/platform/process/probe/types'
import { filetimeToEpochMs } from '../../src/host/platform/process/probe/win32'

/** What one OS listing tells about one process. `null` is "could not be read", never a value. */
export interface ProcessFacts {
  pid: number
  ppid: number
  startTimeMs: number | null
  /** The executable's path or name as the OS reports it. */
  executable: string | null
  /** The command line split into arguments, the executable first. */
  argv: readonly string[]
  cwd: string | null
}

/** An observed session as its adapter read it from the provider's files. */
export interface ObservedSession {
  cwd: string
  /** The instant the provider recorded the session's start (its first record). */
  startedAtMs: number
}

/** The provider, by the stems its executable or its launched script carry (`codex`, `codex.js`, `codex-x86_64…`). */
export interface ProviderMatcher {
  stems: readonly string[]
}

export type Attribution =
  | { kind: 'identity'; identity: ProcessIdentity }
  | {
      kind: 'no-identity'
      reason: 'no-candidate' | 'ambiguous' | 'unreadable'
      /** How many provider roots in the same folder and window there were (ambiguous: more than one). */
      candidates: number
    }

/**
 * How far a provider process's start may lie from its session's first record. The one shared tolerance (ADR-014 item
 * 2, ADR-015 item 1): no second constant. The real-CLI measurement records the actual gap per provider.
 */
export const ATTRIBUTION_WINDOW_MS = PROCESS_START_TOLERANCE_MS

/** Interpreters whose first non-option argument is the launched CLI's script. */
const INTERPRETERS = new Set(['node', 'bun', 'deno'])

/** `C:\x\codex.exe` → `codex`; `/usr/bin/node` → `node`. */
function stemOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|js|cjs|mjs|ts)$/i, '').toLowerCase()
}

/** The stems a process carries: its executable's, and its script's when it runs under an interpreter. */
export function stemsOf(row: ProcessFacts): string[] {
  const executable = row.executable ?? row.argv[0] ?? ''
  const stems = [stemOf(executable)]
  if (INTERPRETERS.has(stems[0] as string)) {
    const script = row.argv.slice(1).find((arg) => !arg.startsWith('-'))
    if (script !== undefined) stems.push(stemOf(script))
  }
  return stems.filter((stem) => stem !== '')
}

/** Whether a process is one of the provider's: a stem equal to one of its stems, or `<stem>-…` (a native build). */
export function isProviderProcess(row: ProcessFacts, matcher: ProviderMatcher): boolean {
  return stemsOf(row).some((stem) =>
    matcher.stems.some((wanted) => stem === wanted || stem.startsWith(`${wanted}-`))
  )
}

/**
 * Attributes one provider process to one observed session, or reports why there is none.
 *
 * 1. The provider's processes, by stem; of a chain of them (a wrapper and its native CLI) only the root, whose parent
 *    is not one of them: the session's process is the provider CLI, never its terminal or shell (ADR-014 item 2).
 * 2. Of those roots, the ones in the session's working folder whose start lies within `ATTRIBUTION_WINDOW_MS` of the
 *    session's first record.
 * 3. Exactly one → its identity. None → `no-candidate`, or `unreadable` when a root's folder or start could not be
 *    read (it might have been the one). More than one → `ambiguous`: two sessions started together in one folder
 *    cannot be told apart, so neither is guessed.
 */
export function attributeSession(
  session: ObservedSession,
  rows: readonly ProcessFacts[],
  matcher: ProviderMatcher,
  bootId: string,
  platform: NodeJS.Platform = process.platform
): Attribution {
  const provider = rows.filter((row) => isProviderProcess(row, matcher))
  const providerPids = new Set(provider.map((row) => row.pid))
  const roots = provider.filter((row) => !providerPids.has(row.ppid))
  let unreadable = 0
  const candidates = roots.filter((row) => {
    if (row.cwd === null || row.startTimeMs === null) {
      unreadable++
      return false
    }
    return (
      sameFolder(row.cwd, session.cwd, platform) &&
      Math.abs(session.startedAtMs - row.startTimeMs) <= ATTRIBUTION_WINDOW_MS
    )
  })
  const [only] = candidates
  if (candidates.length === 1 && only !== undefined && only.startTimeMs !== null) {
    return {
      kind: 'identity',
      identity: { pid: only.pid, processStartTimeMs: only.startTimeMs, bootId }
    }
  }
  if (candidates.length > 1) {
    return { kind: 'no-identity', reason: 'ambiguous', candidates: candidates.length }
  }
  return {
    kind: 'no-identity',
    reason: unreadable > 0 ? 'unreadable' : 'no-candidate',
    candidates: 0
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The per-OS listings.

/** The bound on one listing query; Windows compiles its reader first, which takes a few seconds on a cold machine. */
export const LISTING_TIMEOUT_MS = 20_000

function run(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env,
        shell: false,
        windowsHide: true,
        timeout: LISTING_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

async function linuxListing(): Promise<ProcessFacts[]> {
  const procStat = await readFile('/proc/stat', 'utf8')
  const rows: ProcessFacts[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)
      if (fields[0] === 'Z' || fields[0] === 'X') continue
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
      rows.push({
        pid,
        ppid: Number(fields[1]),
        startTimeMs: parseLinuxStartTime(stat, procStat),
        executable: await readlink(`/proc/${pid}/exe`).catch(() => null),
        argv,
        cwd: await readlink(`/proc/${pid}/cwd`).catch(() => null)
      })
    } catch {
      // The process ended while the folder was read.
    }
  }
  return rows
}

/** `ps -A -o pid=,ppid=,lstart=,args=`: lstart is always five words ("Mon Oct  5 10:00:00 2026"). */
export function parseDarwinListing(text: string): Omit<ProcessFacts, 'cwd'>[] {
  const rows: Omit<ProcessFacts, 'cwd'>[] = []
  for (const line of text.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/)
    if (words.length < 8 || !/^\d+$/.test(words[0] as string)) continue
    const argv = words.slice(7)
    rows.push({
      pid: Number(words[0]),
      ppid: Number(words[1]),
      startTimeMs: parseDarwinLstart(words.slice(2, 7).join(' ')),
      executable: argv[0] ?? null,
      argv
    })
  }
  return rows
}

/** `lsof -Fn` output: `p<pid>` opens a process, `n<path>` is its cwd. */
export function parseLsofCwd(text: string): Map<number, string> {
  const cwd = new Map<number, string>()
  let pid: number | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null) cwd.set(pid, line.slice(1))
  }
  return cwd
}

async function darwinListing(matcher: ProviderMatcher): Promise<ProcessFacts[]> {
  const env = { ...process.env, LC_ALL: 'C' }
  const listed = parseDarwinListing(
    await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], env)
  )
  const wanted = listed.filter((row) => isProviderProcess({ ...row, cwd: null }, matcher))
  let cwd = new Map<number, string>()
  if (wanted.length > 0) {
    // lsof exits 1 when one of the pids ended meanwhile; what it printed is still read.
    const out = await run('/usr/sbin/lsof', [
      '-a',
      '-d',
      'cwd',
      '-Fn',
      '-p',
      wanted.map((row) => row.pid).join(',')
    ]).catch((error: { stdout?: string }) => error.stdout ?? '')
    cwd = parseLsofCwd(out)
  }
  return listed.map((row) => ({ ...row, cwd: cwd.get(row.pid) ?? null }))
}

/**
 * Splits a Windows command line the way the C runtime does, enough for a stem: double quotes group, a backslash is
 * literal unless it precedes a quote.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string
    if (char === '\\' && line[i + 1] === '"') {
      current += '"'
      i++
      started = true
    } else if (char === '"') {
      quoted = !quoted
      started = true
    } else if (/\s/.test(char) && !quoted) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

/** The in-memory reader of another process's working folder (x64 targets only; anything else answers null). */
const WIN32_CWD_READER = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class S0141Cwd {
  [StructLayout(LayoutKind.Sequential)]
  struct Pbi { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref Pbi i, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr n, out IntPtr r);
  static byte[] Read(IntPtr h, IntPtr a, int n) {
    var b = new byte[n]; IntPtr r;
    return ReadProcessMemory(h, a, b, (IntPtr)n, out r) && (long)r == n ? b : null;
  }
  public static string Get(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      bool wow;
      if (!IsWow64Process(h, out wow) || wow) return null;
      var pbi = new Pbi(); int len;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out len) != 0) return null;
      var parameters = Read(h, pbi.Peb + 0x20, 8); if (parameters == null) return null;
      var dir = Read(h, (IntPtr)BitConverter.ToInt64(parameters, 0) + 0x38, 16); if (dir == null) return null;
      int bytes = BitConverter.ToUInt16(dir, 0); if (bytes == 0) return null;
      var text = Read(h, (IntPtr)BitConverter.ToInt64(dir, 8), bytes); if (text == null) return null;
      return Encoding.Unicode.GetString(text);
    } finally { CloseHandle(h); }
  }
}`

/** Lists every process; reads the working folder of the rows whose command line names one of `stems`. */
function win32ListingScript(stems: readonly string[]): string {
  const pattern = stems.map((stem) => stem.replace(/[^A-Za-z0-9_-]/g, '')).join('|')
  return [
    `Add-Type -TypeDefinition @'\n${WIN32_CWD_READER}\n'@`,
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine |',
    'ForEach-Object {',
    `  $cwd = $null; if ("$($_.ExecutablePath) $($_.CommandLine)" -match '(?i)(${pattern})') { $cwd = [S0141Cwd]::Get([int]$_.ProcessId) }`,
    '  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId;',
    "    start = $(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTime() } else { '' });",
    '    exe = $_.ExecutablePath; cmd = $_.CommandLine; cwd = $cwd }',
    '} | ConvertTo-Json -Compress -Depth 2'
  ].join('\n')
}

interface Win32Row {
  pid: number
  ppid: number
  start: string
  exe: string | null
  cmd: string | null
  cwd: string | null
}

async function win32Listing(matcher: ProviderMatcher): Promise<ProcessFacts[]> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key]
  const encoded = Buffer.from(win32ListingScript(matcher.stems), 'utf16le').toString('base64')
  const out = await run(
    windowsPowerShell(),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    env
  )
  const parsed = JSON.parse(out) as Win32Row | Win32Row[]
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    startTimeMs: row.start === '' ? null : filetimeToEpochMs(row.start),
    executable: row.exe,
    argv: row.cmd === null ? [] : splitWindowsCommandLine(row.cmd),
    cwd: row.cwd
  }))
}

/** Every process of this OS now, with the working folder of the provider's rows where the OS lets it be read. */
export function listProcesses(
  platform: NodeJS.Platform,
  matcher: ProviderMatcher
): Promise<ProcessFacts[]> {
  if (platform === 'linux') return linuxListing()
  if (platform === 'darwin') return darwinListing(matcher)
  if (platform === 'win32') return win32Listing(matcher)
  return Promise.reject(new Error(`no process listing for ${platform}`))
}

/**
 * Two working folders name the same place: separators, a trailing separator and, on Windows, case aside. No case
 * folding elsewhere: a volume of unknown case sensitivity is compared as written (S-030-1).
 */
export function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (folder: string): string => {
    const unified = path.posix.normalize(folder.replace(/\\/g, '/')).replace(/\/+$/, '')
    return platform === 'win32' ? unified.toLowerCase() : unified
  }
  return norm(a) === norm(b)
}
