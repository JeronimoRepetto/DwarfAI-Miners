// Spike S-015-2 (testing strategy 17 §4; ADR-015 item 4; spike register S-015-2): reads every candidate source of
// the boot and logon identity on the current OS, with its latency, so the per-OS table of ADR-015 item 4 can be held
// or corrected from observed values. `bootIdentity.os.test.ts` runs it in the OS lane (L8, one leg per OS); the
// owner runs it by hand before and after each transition the procedure lists (`bootIdentity.md`):
//
//   node spikes/S-015-2/bootIdentity.ts snapshot --label <step> --out <file>
//   node spikes/S-015-2/bootIdentity.ts compare <before.json> <after.json>
//
// Nothing here needs elevation, changes a system setting or installs anything. On Windows the reference readings
// (kernel boot time, logon session LUID, tick counters) come from a small C# program compiled with the .NET Framework
// compiler that ships with Windows (the SP-02 approach); it stands in for a native call and is not a production
// source. Identity values that could single out a machine or a session (UUIDs, LUIDs, logon SIDs, session ids) are
// recorded only as a short SHA-256 prefix, which is enough to tell "same" from "changed" (privacy guard, 17 §5.2).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir, uptime, userInfo, version } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** One reading of one source. `value` is comparable across snapshots; `null` means unreadable. */
export interface Reading {
  readonly source: string
  /** Which ADR-015 item 4 field the source is a candidate for. */
  readonly field: 'bootId' | 'bootTimeMs' | 'logonSessionId' | 'reference'
  readonly value: string | number | null
  readonly latencyMs: number
  readonly error: string | null
}

export interface Snapshot {
  readonly label: string
  readonly takenAt: string
  readonly platform: NodeJS.Platform
  readonly osRelease: string
  readonly osVersion: string
  readonly node: string
  /** Windows only: whether Fast Startup (`HiberbootEnabled`) is on, read, never changed. */
  readonly fastStartup: boolean | null
  readonly readings: readonly Reading[]
}

/** A short, one-way fingerprint of an identity value: equal inputs give equal outputs, nothing more. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function timed(
  source: string,
  field: Reading['field'],
  read: () => string | number | null
): Reading {
  const started = performance.now()
  try {
    const value = read()
    return { source, field, value, latencyMs: round(performance.now() - started), error: null }
  } catch (error) {
    const message = error instanceof Error ? (error.message.split(/\r?\n/)[0] ?? '') : String(error)
    return {
      source,
      field,
      value: null,
      latencyMs: round(performance.now() - started),
      error: message.slice(0, 200)
    }
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10
}

/** `now − os.uptime()`, rounded to the second as ADR-015 item 4 rounds the Windows boot instant. */
function uptimeBootMs(): number {
  return Math.round((Date.now() - uptime() * 1000) / 1000) * 1000
}

function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    shell: false,
    ...(env ? { env } : {})
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Windows

const WINDOWS_HELPER = String.raw`
using System;
using System.Runtime.InteropServices;

static class S0152 {
  [StructLayout(LayoutKind.Sequential)]
  struct TIMEOFDAY { public long BootTime, CurrentTime, TimeZoneBias; public uint TimeZoneId, Reserved; public ulong BootTimeBias, SleepTimeBias; }
  [StructLayout(LayoutKind.Sequential)]
  struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_STATISTICS { public LUID TokenId, AuthenticationId; public long ExpirationTime; public int TokenType, ImpersonationLevel; public uint DynamicCharged, DynamicAvailable, GroupCount, PrivilegeCount; public LUID ModifiedId; }

  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, out TIMEOFDAY info, int len, out int ret);
  [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
  [DllImport("kernel32.dll")] static extern bool QueryUnbiasedInterruptTime(out ulong t);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out TOKEN_STATISTICS info, int len, out int ret);

  static long FileTimeToUnixMs(long ft) { return (ft - 116444736000000000L) / 10000L; }

  static void Main() {
    TIMEOFDAY tod; int ret;
    int status = NtQuerySystemInformation(3, out tod, Marshal.SizeOf(typeof(TIMEOFDAY)), out ret);
    ulong unbiased; QueryUnbiasedInterruptTime(out unbiased);
    IntPtr token; TOKEN_STATISTICS stats; string luid = "";
    if (OpenProcessToken(GetCurrentProcess(), 0x0008, out token) &&
        GetTokenInformation(token, 10, out stats, Marshal.SizeOf(typeof(TOKEN_STATISTICS)), out ret)) {
      luid = stats.AuthenticationId.High.ToString("x8") + stats.AuthenticationId.Low.ToString("x8");
    }
    uint session; ProcessIdToSessionId(GetCurrentProcessId(), out session);
    Console.Write("{\"ntStatus\":" + status +
      ",\"ntBootTimeMs\":" + FileTimeToUnixMs(tod.BootTime) +
      ",\"ntCurrentTimeMs\":" + FileTimeToUnixMs(tod.CurrentTime) +
      ",\"sleepTimeBias100ns\":" + tod.SleepTimeBias +
      ",\"tickCount64Ms\":" + GetTickCount64() +
      ",\"unbiasedInterruptMs\":" + (unbiased / 10000UL) +
      ",\"authenticationId\":\"" + luid + "\"" +
      ",\"sessionId\":" + session + "}");
  }
}
`

interface HelperOutput {
  ntStatus: number
  ntBootTimeMs: number
  ntCurrentTimeMs: number
  sleepTimeBias100ns: number
  tickCount64Ms: number
  unbiasedInterruptMs: number
  authenticationId: string
  sessionId: number
}

/** Compiles the reference helper into `dir`; returns its path. */
export function compileWindowsHelper(dir: string): string {
  const source = path.join(dir, 's0152.cs')
  const exe = path.join(dir, 's0152.exe')
  writeFileSync(source, WINDOWS_HELPER)
  const windir = process.env['WINDIR'] ?? 'C:\\Windows'
  const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  execFileSync(csc, ['/nologo', `/out:${exe}`, source], { windowsHide: true })
  return exe
}

const SYSTEM32 = path.join(
  process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows',
  'System32'
)
const PREFETCH_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters'
const POWER_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power'

/** A REG_DWORD value read with the reg.exe that ships with Windows, or null when absent. */
function regDword(key: string, name: string): number | null {
  const out = run(path.join(SYSTEM32, 'reg.exe'), ['query', key, '/v', name])
  const match = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(out)
  return match?.[1] ? Number.parseInt(match[1], 16) : null
}

function windowsReadings(helperExe: string | null): Reading[] {
  const readings: Reading[] = [
    timed('registry PrefetchParameters\\BootId (reg.exe)', 'bootId', () =>
      regDword(PREFETCH_KEY, 'BootId')
    ),
    timed('CIM Win32_OperatingSystem.LastBootUpTime (powershell)', 'bootTimeMs', () => {
      const out = run(path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::Out.Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"
      ])
      return Math.round(Date.parse(out.trim()) / 1000) * 1000
    }),
    timed('now - os.uptime() (Node, in process)', 'bootTimeMs', uptimeBootMs),
    timed('whoami /logonid (logon SID)', 'logonSessionId', () => {
      const out = run(path.join(SYSTEM32, 'whoami.exe'), ['/logonid'])
      const sid = /S-1-5-5-\d+-\d+/.exec(out)?.[0]
      return sid ? fingerprint(sid) : null
    })
  ]
  if (helperExe) {
    const started = performance.now()
    let helper: HelperOutput | null = null
    let error: string | null = null
    try {
      helper = JSON.parse(run(helperExe, [])) as HelperOutput
    } catch (caught) {
      error = String(caught).slice(0, 200)
    }
    const latencyMs = round(performance.now() - started)
    const add = (source: string, field: Reading['field'], value: string | number | null): void => {
      readings.push({ source, field, value, latencyMs, error })
    }
    add(
      'NtQuerySystemInformation(SystemTimeOfDayInformation).BootTime, to the second (helper)',
      'reference',
      helper ? Math.round(helper.ntBootTimeMs / 1000) * 1000 : null
    )
    add(
      'now - GetTickCount64(), to the second (helper)',
      'reference',
      helper ? Math.round((helper.ntCurrentTimeMs - helper.tickCount64Ms) / 1000) * 1000 : null
    )
    add(
      'now - QueryUnbiasedInterruptTime() (excludes sleep), to the second (helper)',
      'reference',
      helper
        ? Math.round((helper.ntCurrentTimeMs - helper.unbiasedInterruptMs) / 1000) * 1000
        : null
    )
    add(
      'SystemTimeOfDayInformation.SleepTimeBias, ms (helper)',
      'reference',
      helper ? Math.round(helper.sleepTimeBias100ns / 10000) : null
    )
    add(
      'token TokenStatistics.AuthenticationId (logon LUID, helper)',
      'logonSessionId',
      helper?.authenticationId ? fingerprint(helper.authenticationId) : null
    )
    add(
      'ProcessIdToSessionId (terminal session, helper)',
      'reference',
      helper ? fingerprint(String(helper.sessionId)) : null
    )
  }
  return readings
}

// ---------------------------------------------------------------------------------------------------------------
// Linux

function linuxReadings(): Reading[] {
  return [
    timed('/proc/sys/kernel/random/boot_id', 'bootId', () =>
      fingerprint(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
    ),
    timed('/proc/stat btime', 'bootTimeMs', () => {
      const match = /^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
      return match ? Number(match[1]) * 1000 : null
    }),
    timed('now - os.uptime() (Node, in process)', 'bootTimeMs', uptimeBootMs),
    timed('/proc/self/sessionid (audit session)', 'logonSessionId', () => {
      const value = readFileSync('/proc/self/sessionid', 'utf8').trim()
      // 4294967295 is (unsigned) -1: no audit session was set for this process.
      return value === '4294967295' ? null : fingerprint(value)
    }),
    timed('XDG_SESSION_ID (environment)', 'logonSessionId', () => {
      const value = process.env['XDG_SESSION_ID']
      return value ? fingerprint(value) : null
    }),
    timed('/proc/self/cgroup session-N.scope (systemd-logind)', 'logonSessionId', () => {
      const match = /session-([^/.\s]+)\.scope/.exec(readFileSync('/proc/self/cgroup', 'utf8'))
      return match?.[1] ? fingerprint(match[1]) : null
    }),
    timed('init system (/proc/1/comm)', 'reference', () =>
      readFileSync('/proc/1/comm', 'utf8').trim()
    )
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// macOS

/**
 * The environment of the macOS logon readers. `who` and `ps -o lstart` format their times with `strftime`, whose
 * month and day names follow the locale and whose clock follows the time zone. The C locale and UTC make the output
 * one fixed shape, so a parser never depends on the person's settings.
 */
const MACOS_FIXED_FORMAT_ENV = { ...process.env, LC_ALL: 'C', TZ: 'UTC0' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The login minute of `user`'s console line in `who` output (utmpx), e.g. `Oct  2 19:20`; null without one. utmpx
 * keeps only the minute, so two logins within one minute read the same.
 */
export function parseWhoConsoleLogin(whoOutput: string, user: string): string | null {
  for (const line of whoOutput.split(/\r?\n/)) {
    const match = /^(\S+)\s+console\s+(.+?)\s*$/.exec(line)
    if (match?.[1] === user && match[2]) return match[2]
  }
  return null
}

/**
 * The start instant, in ms since the epoch, of the `loginwindow` process of `uid` in the output of
 * `ps -axo uid=,lstart=,comm=` run with `MACOS_FIXED_FORMAT_ENV` (C locale, UTC); null without one or when the
 * time does not have that exact shape. loginwindow runs once per GUI login under the user's own uid and is replaced
 * at every logout, so its start instant identifies the logon to the second.
 */
export function parseLoginwindowStart(psOutput: string, uid: number): number | null {
  const row =
    /^\s*(\d+)\s+[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s+(.+?)\s*$/
  for (const line of psOutput.split(/\r?\n/)) {
    const match = row.exec(line)
    if (!match || Number(match[1]) !== uid || !match[8]?.endsWith('/loginwindow')) continue
    const [month, day, hours, minutes, seconds, year] = [
      MONTHS.indexOf(match[2] ?? ''),
      ...match.slice(3, 8).map(Number)
    ] as [number, number, number, number, number, number]
    const ms = Date.UTC(year, month, day, hours, minutes, seconds)
    const back = new Date(ms)
    // Date.UTC rolls an out-of-range field over (Oct 32 → Nov 1); a value that does not round-trip is unreadable.
    const exact =
      month >= 0 &&
      back.getUTCMonth() === month &&
      back.getUTCDate() === day &&
      back.getUTCHours() === hours &&
      back.getUTCMinutes() === minutes &&
      back.getUTCSeconds() === seconds
    return exact ? ms : null
  }
  return null
}

function macosReadings(): Reading[] {
  return [
    timed('sysctl kern.bootsessionuuid', 'bootId', () =>
      fingerprint(run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']).trim())
    ),
    timed('sysctl kern.boottime', 'bootTimeMs', () => {
      const out = run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])
      const match = /sec = (\d+), usec = (\d+)/.exec(out)
      return match ? Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000) : null
    }),
    timed('now - os.uptime() (Node, in process)', 'bootTimeMs', uptimeBootMs),
    timed('SECURITYSESSIONID (environment, audit session)', 'logonSessionId', () => {
      const value = process.env['SECURITYSESSIONID']
      return value ? fingerprint(value) : null
    }),
    timed('ps -o sess= (session of this process)', 'logonSessionId', () => {
      const value = run('/bin/ps', ['-o', 'sess=', '-p', String(process.pid)]).trim()
      return value ? fingerprint(value) : null
    }),
    // `ps -o sess=` reads 0 for every process and SECURITYSESSIONID is absent from some shells (P2, 2026-10-02), so
    // these two read the GUI login itself (P2b).
    timed('who console login (utmpx, to the minute)', 'logonSessionId', () =>
      parseWhoConsoleLogin(run('/usr/bin/who', [], MACOS_FIXED_FORMAT_ENV), userInfo().username)
    ),
    timed('loginwindow start time (ps lstart, to the second)', 'logonSessionId', () =>
      parseLoginwindowStart(
        run('/bin/ps', ['-axo', 'uid=,lstart=,comm='], MACOS_FIXED_FORMAT_ENV),
        userInfo().uid
      )
    )
  ]
}

// ---------------------------------------------------------------------------------------------------------------

/** Every candidate source of the current OS, read once. */
export function readAll(helperExe: string | null = null): Reading[] {
  if (process.platform === 'win32') return windowsReadings(helperExe)
  if (process.platform === 'darwin') return macosReadings()
  return linuxReadings()
}

export function snapshot(label: string, helperExe: string | null = null): Snapshot {
  let fastStartup: boolean | null = null
  if (process.platform === 'win32') {
    try {
      fastStartup = regDword(POWER_KEY, 'HiberbootEnabled') === 1
    } catch {
      fastStartup = null
    }
  }
  return {
    label,
    takenAt: new Date().toISOString(),
    platform: process.platform,
    osRelease: release(),
    osVersion: version(),
    node: process.versions.node,
    fastStartup,
    readings: readAll(helperExe)
  }
}

/** Per source present in both snapshots: whether it was readable on each side and whether its value changed. */
export interface SourceChange {
  readonly source: string
  readonly field: Reading['field']
  readonly before: string | number | null
  readonly after: string | number | null
  readonly changed: boolean | 'unknown'
}

export function compareSnapshots(before: Snapshot, after: Snapshot): SourceChange[] {
  return before.readings
    .filter((reading) => after.readings.some((other) => other.source === reading.source))
    .map((reading) => {
      const other = after.readings.find((candidate) => candidate.source === reading.source)
      const afterValue = other?.value ?? null
      const changed =
        reading.value === null || afterValue === null ? 'unknown' : reading.value !== afterValue
      return {
        source: reading.source,
        field: reading.field,
        before: reading.value,
        after: afterValue,
        changed
      }
    })
}

/** The identity ADR-015 item 4 compares, built from chosen sources; `'unknown'` when unreadable. */
export interface BootIdentity {
  readonly bootId: string | number | 'unknown'
  readonly bootTimeMs: number | 'unknown'
  readonly logonSessionId: string | number | 'unknown'
}

export type RebootVerdict =
  | 'rebooted (rule 1: bootId)'
  | 'logged out (rule 2: logonSessionId)'
  | 'rebooted (rule 3: bootTimeMs after the epoch start)'
  | 'same boot (rule 4)'

/**
 * ADR-015 item 4 "Reboot detection", rules 1–4 as written, applied to two identities so the record can say which
 * rule would catch each observed transition. `'unknown'` never compares equal. Spike harness only: the production
 * decision is ISSUE-019's (`currentBootIdentity()`) and ADR-015's reconcile table.
 */
export function rebootVerdict(
  previous: BootIdentity,
  current: BootIdentity,
  previousEpochStartMs: number
): RebootVerdict {
  const known = <T>(value: T | 'unknown'): value is T => value !== 'unknown'
  if (known(previous.bootId) && known(current.bootId) && previous.bootId !== current.bootId) {
    return 'rebooted (rule 1: bootId)'
  }
  if (
    known(previous.logonSessionId) &&
    known(current.logonSessionId) &&
    previous.logonSessionId !== current.logonSessionId
  ) {
    return 'logged out (rule 2: logonSessionId)'
  }
  if (
    (!known(previous.bootId) || !known(current.bootId)) &&
    known(current.bootTimeMs) &&
    current.bootTimeMs - previousEpochStartMs > 60_000
  ) {
    return 'rebooted (rule 3: bootTimeMs after the epoch start)'
  }
  return 'same boot (rule 4)'
}

/** The identity a snapshot gives when each field takes the named source; `'unknown'` when unreadable or absent. */
export function identityFrom(
  shot: Snapshot,
  sources: { bootId: string; bootTimeMs: string; logonSessionId: string }
): BootIdentity {
  const valueOf = (source: string): string | number | 'unknown' =>
    shot.readings.find((reading) => reading.source === source)?.value ?? 'unknown'
  const bootTime = valueOf(sources.bootTimeMs)
  return {
    bootId: valueOf(sources.bootId),
    bootTimeMs: typeof bootTime === 'number' ? bootTime : 'unknown',
    logonSessionId: valueOf(sources.logonSessionId)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Command line (owner procedure, bootIdentity.md)

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv
  if (command === 'snapshot') {
    const label = rest[rest.indexOf('--label') + 1] ?? 'unlabelled'
    const outIndex = rest.indexOf('--out')
    let helperExe: string | null = null
    let dir: string | null = null
    try {
      if (process.platform === 'win32') {
        dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0152-'))
        helperExe = compileWindowsHelper(dir)
      }
      const text = `${JSON.stringify(snapshot(label, helperExe), null, 2)}\n`
      const outFile = outIndex >= 0 ? rest[outIndex + 1] : undefined
      if (outFile) writeFileSync(outFile, text)
      process.stdout.write(text)
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
    return
  }
  if (command === 'compare' && rest.length === 2 && rest.every((file) => existsSync(file))) {
    const [before, after] = rest.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Snapshot)
    if (!before || !after) return
    for (const change of compareSnapshots(before, after)) {
      const state = change.changed === 'unknown' ? 'UNKNOWN' : change.changed ? 'CHANGED' : 'same'
      process.stdout.write(`${state.padEnd(8)} ${change.field.padEnd(15)} ${change.source}\n`)
    }
    return
  }
  process.stderr.write(
    'usage: node spikes/S-015-2/bootIdentity.ts snapshot --label <step> [--out <file>]\n' +
      '       node spikes/S-015-2/bootIdentity.ts compare <before.json> <after.json>\n'
  )
  process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
