// The per-OS process listings behind `ProcessControl.listProcesses` (16 §3, owner amendment I): the
// running processes that carry a wanted stem, with the working folder the OS reports for each. No
// pid leaves this module, so a listing is never evidence of identity (06 INV-51). It never signals
// or ends anything. Every OS read is a dependency, so the same code runs against scripted OS
// answers in the L3 tests and against the real OS in the L8 lane.
//
// Adopted from spike S-014-1 (`spikes/S-014-1/pidSource.ts`): the stem rule, procfs on Linux,
// `ps` + `lsof` on macOS, and on Windows CIM `Win32_Process` with the working folder read from each
// match's process parameters (PEB) by a non-elevated reader, which Node cannot do. Its attribution
// by start time is not adopted: the kill identity stays `no-identity` until S-014-1 passes.
//
// Fail-safe direction (owner amendment I): a listing that cannot be read is a failed read, never an
// empty one, and a match whose working folder cannot be read keeps `cwd: null`, so its caller can
// refuse to conclude anything from it.
import { splitWindowsCommandLine } from './windowsCommandLine'
import {
  DARWIN_PS,
  POWERSHELL_DROPPED_ENV,
  windowsPowerShell,
  type QueryOutcome,
  type QueryRunner,
  type ReadOutcome
} from '../probe/types'

/** One listed process before the stem is named: what the OS says it runs, and where. */
export interface RawProcess {
  /** The executable's path or name as the OS reports it; null when it gives none. */
  executable: string | null
  /** The command line split into arguments, the executable first (empty when not read). */
  argv: readonly string[]
  /** The working folder as the OS reports it; null when it could not be read. */
  cwd: string | null
}

/** One OS's listing: the processes carrying one of `stems`, or why there is no listing. */
export type RawListing = (stems: readonly string[]) => Promise<ReadOutcome<readonly RawProcess[]>>

/**
 * The bound on one listing query (`ps`, `lsof`, PowerShell). The package names none. Windows
 * compiles its folder reader and queries CIM, which took 0.35 s here and up to 20 s on a loaded CI
 * runner (spike S-014-1); a slower answer is an unreadable listing, which closes nothing.
 */
export const LISTING_QUERY_TIMEOUT_MS = 30_000

/** macOS's own `lsof`, by path for the reason `DARWIN_PS` gives. */
export const DARWIN_LSOF = '/usr/sbin/lsof'

/** Interpreters whose arguments name the CLI they run (`node …/codex.js`). */
const INTERPRETERS = new Set(['node', 'bun', 'deno'])

/** `C:\x\Codex.exe` → `codex`; `/usr/bin/node` → `node`; `…/bin/opencode` → `opencode`. */
function stemOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|js|cjs|mjs|ts)$/i, '').toLowerCase()
}

/**
 * The wanted stem a process carries, or null. Its executable's stem, equal to a wanted one or a
 * native build of it (`<stem>-…`); under an interpreter, also any argument's (not only the first
 * script: a path `ps` split on a space still ends in the script's own name, and over-matching only
 * keeps a session open).
 */
export function matchedStem(
  row: Pick<RawProcess, 'executable' | 'argv'>,
  stems: readonly string[]
): string | null {
  const executable = row.executable ?? row.argv[0] ?? ''
  const carried = [stemOf(executable)]
  if (INTERPRETERS.has(carried[0] as string)) {
    for (const arg of row.argv.slice(1)) if (!arg.startsWith('-')) carried.push(stemOf(arg))
  }
  for (const wanted of stems) {
    const stem = wanted.toLowerCase()
    if (stem === '') continue
    if (carried.some((own) => own === stem || own.startsWith(`${stem}-`))) return wanted
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Linux: procfs, no process spawned.

export interface LinuxListingDeps {
  readText: (path: string) => Promise<string>
  listDir: (path: string) => Promise<readonly string[]>
  readLink: (path: string) => Promise<string>
}

export function createLinuxListing(deps: LinuxListingDeps): RawListing {
  return async (stems) => {
    let entries: readonly string[]
    try {
      entries = await deps.listDir('/proc')
    } catch (error) {
      return {
        ok: false,
        cause: `could not read /proc (${(error as NodeJS.ErrnoException).code ?? 'error'})`
      }
    }
    const pids = entries.filter((name) => /^\d+$/.test(name)).map(Number)
    const rows = await Promise.all(
      pids.map(async (pid): Promise<RawProcess | null> => {
        let argv: string[]
        try {
          argv = (await deps.readText(`/proc/${pid}/cmdline`)).split('\0').filter(Boolean)
        } catch {
          // The process ended between the folder listing and its read.
          return null
        }
        const executable = await deps.readLink(`/proc/${pid}/exe`).catch(() => null)
        if (matchedStem({ executable, argv }, stems) === null) return null
        const cwd = await deps.readLink(`/proc/${pid}/cwd`).catch(() => null)
        return { executable, argv, cwd }
      })
    )
    return { ok: true, value: rows.filter((row): row is RawProcess => row !== null) }
  }
}

// ---------------------------------------------------------------------------------------------
// macOS: `ps` for every executable path, `ps` again for the interpreters' arguments, `lsof` for the
// working folders of the matches.

const PS_ROW = /^\s*(\d+)\s+(.+?)\s*$/

/** `<pid> <rest of line>` rows, or null when a line is not one or there are none. */
function pidRows(text: string): Map<number, string> | null {
  const rows = new Map<number, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const match = PS_ROW.exec(line)
    if (match === null) return null
    rows.set(Number(match[1]), match[2] as string)
  }
  return rows.size === 0 ? null : rows
}

/** `lsof -Fn` output: `p<pid>` opens a process, `n<path>` is its working folder. */
export function parseLsofCwd(text: string): Map<number, string> {
  const cwd = new Map<number, string>()
  let pid: number | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null) cwd.set(pid, line.slice(1))
  }
  return cwd
}

const C_LOCALE = { LC_ALL: 'C' }

export function createDarwinListing(deps: { runQuery: QueryRunner }): RawListing {
  const query = (file: string, args: readonly string[]): Promise<QueryOutcome> =>
    deps.runQuery(file, args, { timeoutMs: LISTING_QUERY_TIMEOUT_MS, env: C_LOCALE })
  return async (stems) => {
    const listed = await query(DARWIN_PS, ['-A', '-o', 'pid=,comm='])
    if (!listed.ok) return listed
    const executables = pidRows(listed.stdout)
    if (executables === null) return { ok: false, cause: 'gave an unparseable answer' }

    const interpreters = [...executables]
      .filter(([, executable]) => INTERPRETERS.has(stemOf(executable)))
      .map(([pid]) => pid)
    const argvOf = new Map<number, string[]>()
    if (interpreters.length > 0) {
      const args = await query(DARWIN_PS, ['-o', 'pid=,args=', '-p', interpreters.join(',')])
      // An interpreter whose arguments are unknown might run the provider: no listing.
      if (!args.ok) return args
      for (const [pid, line] of pidRows(args.stdout) ?? []) argvOf.set(pid, line.split(/\s+/))
    }

    const matches: Array<{ pid: number; executable: string; argv: string[] }> = []
    for (const [pid, executable] of executables) {
      const argv = argvOf.get(pid) ?? []
      if (matchedStem({ executable, argv }, stems) !== null) matches.push({ pid, executable, argv })
    }
    let cwd = new Map<number, string>()
    if (matches.length > 0) {
      const folders = await query(DARWIN_LSOF, [
        '-a',
        '-d',
        'cwd',
        '-Fn',
        '-p',
        matches.map((match) => match.pid).join(',')
      ])
      // lsof exits 1 when one of the pids ended meanwhile; every folder is then unknown (null).
      if (folders.ok) cwd = parseLsofCwd(folders.stdout)
    }
    return {
      ok: true,
      value: matches.map(({ pid, executable, argv }) => ({
        executable,
        argv,
        cwd: cwd.get(pid) ?? null
      }))
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Windows: CIM `Win32_Process` through Windows PowerShell 5.1 (never `wmic`), the working folder of
// each prefiltered row read from its process parameters (PEB) with `NtQueryInformationProcess` and
// `ReadProcessMemory`, compiled in memory by `Add-Type`. Every text leaves base64-encoded UTF-16, so
// no console code page can change a path.

/** The in-memory reader of another process's working folder (x64 targets only; anything else: null). */
const WIN32_CWD_READER = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DwarfAiProcessCwd {
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

/**
 * The PowerShell script: every process whose name, executable path or command line mentions a
 * stem (a superset of the matches, so the stem rule itself runs here in TypeScript), one `R` line
 * each, then `END`. A stem keeps only `[A-Za-z0-9_-]`, so none can inject into the script.
 */
export function win32ListingScript(stems: readonly string[]): string {
  const pattern = stems
    .map((stem) => stem.replace(/[^A-Za-z0-9_-]/g, ''))
    .filter((stem) => stem !== '')
    .join('|')
  return [
    `Add-Type -TypeDefinition @'\n${WIN32_CWD_READER}\n'@`,
    "function B64($t) { if ($null -eq $t) { '-' } else { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$t)) } }",
    'Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,CommandLine | ForEach-Object {',
    `  if ("$($_.Name) $($_.ExecutablePath) $($_.CommandLine)" -match '(?i)(${pattern})') {`,
    '    $exe = if ($_.ExecutablePath) { $_.ExecutablePath } else { $_.Name }',
    '    "R`t$(B64 $exe)`t$(B64 $_.CommandLine)`t$(B64 ([DwarfAiProcessCwd]::Get([int]$_.ProcessId)))"',
    '  }',
    '}',
    "'END'"
  ].join('\n')
}

function fromBase64(field: string): string | null | undefined {
  if (field === '-') return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(field) || field.length % 4 !== 0) return undefined
  return Buffer.from(field, 'base64').toString('utf16le')
}

/** A working folder without the trailing separator the PEB keeps (`C:\x\` → `C:\x`; `C:\` stays). */
function withoutTrailingSeparator(folder: string): string {
  return /^[A-Za-z]:\\$/.test(folder) ? folder : folder.replace(/[\\/]+$/, '')
}

/** The `R` lines of the script's answer, or null when it is cut short or a line is not one. */
export function parseWin32Listing(text: string): RawProcess[] | null {
  const rows: RawProcess[] = []
  let ended = false
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    if (ended) return null
    if (line.trim() === 'END') {
      ended = true
      continue
    }
    const [tag, exe, cmd, cwd, ...rest] = line.split('\t')
    if (tag !== 'R' || cwd === undefined || rest.length > 0) return null
    const fields = [exe, cmd, cwd].map((field) => fromBase64(field as string))
    if (fields.some((field) => field === undefined)) return null
    const [executable, commandLine, folder] = fields as Array<string | null>
    rows.push({
      executable: executable ?? null,
      argv:
        commandLine === null || commandLine === undefined
          ? []
          : splitWindowsCommandLine(commandLine),
      cwd: folder === null || folder === undefined ? null : withoutTrailingSeparator(folder)
    })
  }
  return ended ? rows : null
}

export function createWin32Listing(deps: {
  runQuery: QueryRunner
  env: Readonly<Record<string, string | undefined>>
}): RawListing {
  return async (stems) => {
    const encoded = Buffer.from(win32ListingScript(stems), 'utf16le').toString('base64')
    const out = await deps.runQuery(
      windowsPowerShell(deps.env),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeoutMs: LISTING_QUERY_TIMEOUT_MS, dropEnv: POWERSHELL_DROPPED_ENV }
    )
    if (!out.ok) return out
    const rows = parseWin32Listing(out.stdout)
    return rows === null
      ? { ok: false, cause: 'gave an unparseable answer' }
      : { ok: true, value: rows }
  }
}
