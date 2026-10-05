import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  IDENTITY_TOLERANCE_MS,
  createProcessStartReader
} from '../../src/ui-main/hostLauncher/processStart'
import { osQueryRunner, thisPlatform } from '../../src/ui-main/hostLauncher/testing/osQueryRunner'

/**
 * Spike SP-02, L8 Windows (testing strategy `17` §4; ADR-002 D6; spike register SP-02).
 *
 * Question: does a Host spawned by the UI inherit the UI's Windows job object (also when the UI was started through
 * a Scoop shim), and which start path survives the job being closed? The harness builds the whole chain from real
 * processes: a job holder puts a "UI" (a Node process, as Electron main is) in a `KILL_ON_JOB_CLOSE` job, the UI
 * starts a stub Host that serves a named pipe, the holder closes the job, and the test asks the Host over the pipe.
 *
 * Job kinds:
 * - `plain`: `KILL_ON_JOB_CLOSE` alone, the worst case (breakaway refused).
 * - `breakaway-ok`: `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`.
 * - `scoop-shim`: the job Scoop's shim.exe gives the program it starts: `KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK`,
 *   child created suspended, assigned, then resumed (scoop-better-shimexe `shim.cpp`, recorded in
 *   `spike-results/SP-02.md`).
 *
 * The native pieces (job holder, breakaway launcher, WMI launcher, job query) are one small C# program compiled at
 * test time by the .NET Framework compiler that ships with Windows; nothing is installed. The breakaway launcher
 * stands in for the tiny native launcher of ADR-002 D6 item 1. Kept afterwards as the ADR-002 regression test.
 * Set `SP02_REPORT=<file>` to write the measurements as JSON (the spike record's raw output).
 */

type JobKind = 'plain' | 'breakaway-ok' | 'scoop-shim' | 'real-scoop-shim'
type StartMode = 'node-detached' | 'd6'

interface UiReport {
  mode: StartMode
  launcher: 'node-detached' | 'breakaway' | 'wmi'
  hostPid: number
  launchMs: number
  createMs: number | null
  breakawayRefused: boolean
  breakawayRefusal: string | null
  uiInJob: boolean
  uiPid: number
}

interface Measurement extends UiReport {
  jobKind: JobKind
  hostInJobBeforeClose: boolean
  uiExitedWithJob: boolean
  hostAnswersAfterClose: boolean
}

const CSHARP = String.raw`
using System;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;

static class Sp02 {
  const uint CREATE_SUSPENDED = 0x4, CREATE_NEW_PROCESS_GROUP = 0x200, CREATE_NO_WINDOW = 0x08000000;
  const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  const uint KILL_ON_JOB_CLOSE = 0x2000, BREAKAWAY_OK = 0x800, SILENT_BREAKAWAY_OK = 0x1000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED_LIMIT {
    public BASIC_LIMIT Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);

  static int Main(string[] args) {
    switch (args[0]) {
      case "holder": return Holder(args[1], args[2]);
      case "breakaway": return Breakaway(args[1]);
      case "wmi": return Wmi(args[1]);
      case "injob": return InJob(int.Parse(args[1]));
    }
    return 2;
  }

  // A job holder: the UI's parent. "scoop-shim" mirrors the job Scoop's shim.exe creates.
  static int Holder(string kind, string cmd) {
    uint flags = KILL_ON_JOB_CLOSE;
    if (kind == "breakaway-ok") flags |= BREAKAWAY_OK;
    if (kind == "scoop-shim") flags |= SILENT_BREAKAWAY_OK;
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    EXTENDED_LIMIT info = new EXTENDED_LIMIT();
    info.Basic.LimitFlags = flags;
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) {
      Console.WriteLine("error SetInformationJobObject " + Marshal.GetLastWin32Error()); return 1;
    }
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW,
        IntPtr.Zero, null, ref si, out pi)) {
      Console.WriteLine("error CreateProcess " + Marshal.GetLastWin32Error()); return 1;
    }
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
      Console.WriteLine("error AssignProcessToJobObject " + Marshal.GetLastWin32Error()); return 1;
    }
    ResumeThread(pi.hThread);
    Console.WriteLine("child " + pi.dwProcessId);
    Console.Out.Flush();
    Console.ReadLine();
    CloseHandle(job);
    bool exited = WaitForSingleObject(pi.hProcess, 10000) == 0;
    Console.WriteLine("child-exited " + (exited ? "true" : "false"));
    Console.Out.Flush();
    return 0;
  }

  // ADR-002 D6 item 1: CreateProcessW with breakaway, new process group, no window, clean stdio handles.
  // Measured by SP-02: in nested jobs, breakaway leaves only the jobs that allow it and CreateProcessW still succeeds,
  // so the child is created suspended and checked with IsProcessInJob; still in a job counts as refused.
  static int Breakaway(string cmd) {
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    Stopwatch watch = Stopwatch.StartNew();
    bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
      CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
      IntPtr.Zero, null, ref si, out pi);
    if (!ok) {
      int error = Marshal.GetLastWin32Error();
      Console.WriteLine("refused create-error " + error);
      return error == 5 ? 5 : 1;
    }
    bool stillInJob;
    IsProcessInJob(pi.hProcess, IntPtr.Zero, out stillInJob);
    if (stillInJob) {
      TerminateProcess(pi.hProcess, 1);
      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
      Console.WriteLine("refused still-in-job");
      return 5;
    }
    ResumeThread(pi.hThread);
    watch.Stop();
    Console.WriteLine("pid " + pi.dwProcessId + " ms " + watch.Elapsed.TotalMilliseconds.ToString("F1"));
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return 0;
  }

  // ADR-002 D6 item 2: WMI Win32_Process.Create, hidden window.
  static int Wmi(string cmd) {
    Stopwatch watch = Stopwatch.StartNew();
    ManagementClass startup = new ManagementClass("Win32_ProcessStartup");
    ManagementObject startupInfo = startup.CreateInstance();
    startupInfo["ShowWindow"] = (ushort)0;
    ManagementClass process = new ManagementClass("Win32_Process");
    ManagementBaseObject input = process.GetMethodParameters("Create");
    input["CommandLine"] = cmd;
    input["ProcessStartupInformation"] = startupInfo;
    ManagementBaseObject output = process.InvokeMethod("Create", input, null);
    watch.Stop();
    uint result = (uint)output["ReturnValue"];
    if (result != 0) { Console.WriteLine("error Win32_Process.Create " + result); return 1; }
    Console.WriteLine("pid " + output["ProcessId"] + " ms " + watch.Elapsed.TotalMilliseconds.ToString("F1"));
    return 0;
  }

  static int InJob(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) { Console.WriteLine("gone"); return 0; }
    bool result;
    IsProcessInJob(handle, IntPtr.Zero, out result);
    CloseHandle(handle);
    Console.WriteLine(result ? "true" : "false");
    return 0;
  }
}
`

/** The stub Host: serves a named pipe, answers `ping`, stops on `quit`; a 120 s safety exit prevents leaks. */
const HOST = String.raw`
import net from 'node:net'
const server = net.createServer((socket) => {
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line === 'ping') socket.write('pong ' + process.pid + '\n')
      if (line === 'quit') socket.end('bye\n', () => process.exit(0))
    }
  })
})
server.listen(process.argv[2])
setTimeout(() => process.exit(0), 120000).unref()
`

/**
 * The UI: a Node process, as Electron main is. It starts the Host, waits until the Host answers, writes its report,
 * then stays alive until the job ends it. `d6` is the ADR-002 D6 start path: the breakaway launcher, and WMI when
 * breakaway is refused.
 */
const UI = String.raw`
import { spawn, execFileSync } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
const [mode, launcherExe, hostScript, pipe, outFile] = process.argv.slice(2)
const hostCmd = '"' + process.execPath + '" "' + hostScript + '" "' + pipe + '"'

function runLauncher(kind) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(launcherExe, [kind, hostCmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('close', (code) => resolve({ code, out: out.trim(), ms: performance.now() - started }))
  })
}

function ping() {
  return new Promise((resolve) => {
    const socket = net.connect(pipe)
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 1000)
    socket.on('error', () => { clearTimeout(timer); resolve(false) })
    socket.on('connect', () => socket.write('ping\n'))
    socket.on('data', (data) => { clearTimeout(timer); socket.destroy(); resolve(String(data).startsWith('pong')) })
  })
}

let report
if (mode === 'node-detached') {
  const started = performance.now()
  const child = spawn(process.execPath, [hostScript, pipe], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  report = { launcher: 'node-detached', hostPid: child.pid, launchMs: performance.now() - started, createMs: null, breakawayRefused: false, breakawayRefusal: null }
} else {
  let result = await runLauncher('breakaway')
  let launcher = 'breakaway'
  const breakawayRefused = result.code === 5
  const breakawayRefusal = breakawayRefused ? result.out : null
  if (breakawayRefused) {
    result = await runLauncher('wmi')
    launcher = 'wmi'
  }
  const match = /^pid (\d+) ms ([\d.]+)/.exec(result.out)
  if (!match) throw new Error('launcher failed: ' + result.out)
  report = { launcher, hostPid: Number(match[1]), launchMs: result.ms, createMs: Number(match[2]), breakawayRefused, breakawayRefusal }
}
const deadline = Date.now() + 15000
while (!(await ping())) {
  if (Date.now() > deadline) throw new Error('the Host never answered')
  await new Promise((resolve) => setTimeout(resolve, 100))
}
const uiInJob = execFileSync(launcherExe, ['injob', String(process.pid)], { encoding: 'utf8' }).trim() === 'true'
// AMENDED: was a direct writeFileSync(outFile, …). The test polls existsSync(outFile) and parses it, and the file
// exists, still empty, from the moment it is created until the bytes land, so a loaded run parsed "" ("Unexpected
// end of JSON input"). The report is written beside it and renamed into place: outFile appears only complete.
writeFileSync(outFile + '.partial', JSON.stringify({ mode, ...report, uiInJob, uiPid: process.pid }))
renameSync(outFile + '.partial', outFile)
setInterval(() => {}, 1000)
`

let workDir = ''
let helperExe = ''
let hostScript = ''
let uiScript = ''
const measurements: Measurement[] = []

/** Quotes one Windows command-line argument (the harness paths hold no quote characters). */
const quote = (value: string): string => `"${value}"`

function inJob(pid: number): string {
  return execFileSync(helperExe, ['injob', String(pid)], { encoding: 'utf8' }).trim()
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readStart = createProcessStartReader({ platform: thisPlatform(), runQuery: osQueryRunner() })

/**
 * Ends `pid` at cleanup, only while it is still the process that was running at `recordedAtMs` (ADR-014: never a
 * bare pid): it started no later than that, within the one tolerance. A pid that is gone or that the OS handed to a
 * later process is `gone`, never signalled; one whose start time cannot be read is `unconfirmed`, never signalled. A
 * process that exits between that check and the kill is the end state cleanup wants, so ESRCH (no such process)
 * answers `gone`; every other error still throws (the Host exits right after it answers `quit`).
 */
async function endIfAlive(
  pid: number,
  recordedAtMs: number
): Promise<'ended' | 'gone' | 'unconfirmed'> {
  const start = await readStart(pid)
  if (start.kind === 'unknown') return 'unconfirmed'
  if (start.kind === 'gone' || start.ms > recordedAtMs + IDENTITY_TOLERANCE_MS) return 'gone'
  try {
    process.kill(pid)
    return 'ended'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'
    throw error
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Sends one line to the Host's pipe and returns the first reply line, or null when nothing answers. */
function ask(pipe: string, line: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect(pipe)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, 3000)
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', (data) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(String(data).trim())
    })
  })
}

/** Runs one chain: holder(job kind) → UI → Host(start mode); closes the job; asks the Host. */
async function runChain(jobKind: JobKind, mode: StartMode): Promise<Measurement> {
  const pipe = `\\\\.\\pipe\\dwarfai-sp02-${randomBytes(8).toString('hex')}`
  const outFile = path.join(workDir, `ui-${jobKind}-${mode}.json`)
  const uiCmd = [process.execPath, uiScript, mode, helperExe, hostScript, pipe, outFile]
    .map(quote)
    .join(' ')
  const holder: ChildProcessWithoutNullStreams = spawn(helperExe, ['holder', jobKind, uiCmd], {
    windowsHide: true
  })
  const lines: string[] = []
  createInterface({ input: holder.stdout }).on('line', (line) => lines.push(line))
  let hostPid = 0
  let uiPid = 0
  // When each pid was known to be its process: the UI when the holder named it, the Host when the UI wrote its report.
  let uiSeenAtMs = 0
  let hostSeenAtMs = 0
  try {
    const childLine = await waitFor(
      () => lines.find((line) => line.startsWith('child ') || line.startsWith('error')),
      10000,
      'the job holder'
    )
    expect(childLine, `job holder (${jobKind})`).toMatch(/^child \d+$/)
    uiPid = Number(childLine.slice('child '.length))
    uiSeenAtMs = Date.now()
    const report = await waitFor(
      () =>
        existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8')) as UiReport) : undefined,
      30000,
      `the UI report (${jobKind}, ${mode})`
    )
    hostPid = report.hostPid
    hostSeenAtMs = statSync(outFile).mtimeMs
    const hostInJobBeforeClose = inJob(hostPid) === 'true'
    holder.stdin.write('close\n')
    const exitedLine = await waitFor(
      () => lines.find((line) => line.startsWith('child-exited ')),
      15000,
      'the job to close'
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const reply = await ask(pipe, 'ping')
    const measurement: Measurement = {
      jobKind,
      ...report,
      hostInJobBeforeClose,
      uiExitedWithJob: exitedLine === 'child-exited true' && !isAlive(uiPid),
      hostAnswersAfterClose: reply === `pong ${hostPid}`
    }
    measurements.push(measurement)
    return measurement
  } finally {
    if (hostPid && isAlive(hostPid)) {
      await ask(pipe, 'quit')
      // AMENDED: was `if (isAlive(hostPid)) process.kill(hostPid)`. The Host exits from `quit` between the check and
      // the kill, which threw `kill ESRCH` and failed a passing run (PR #1126 Windows OS lane); gone is the end state.
      await endIfAlive(hostPid, hostSeenAtMs)
    }
    // AMENDED: was `if (uiPid && isAlive(uiPid)) process.kill(uiPid)`, the same check-then-kill race (see above).
    if (uiPid) await endIfAlive(uiPid, uiSeenAtMs)
    if (holder.exitCode === null) holder.kill()
  }
}

/**
 * The owner's check with the real Scoop shim (`SP02_SCOOP_SHIM` = path of an installed Scoop `shim.exe`): the shim
 * starts the UI as it starts any Scoop app, the UI starts the Host by the D6 path, the shim process is ended (which
 * closes its job), and the test asks the Host.
 */
async function runRealShimChain(shimSource: string): Promise<Measurement> {
  const pipe = `\\\\.\\pipe\\dwarfai-sp02-${randomBytes(8).toString('hex')}`
  const outFile = path.join(workDir, 'ui-real-scoop-shim.json')
  const shimExe = path.join(workDir, 'ui-shim.exe')
  copyFileSync(shimSource, shimExe)
  const args = [uiScript, 'd6', helperExe, hostScript, pipe, outFile].map(quote).join(' ')
  writeFileSync(
    path.join(workDir, 'ui-shim.shim'),
    `path = ${quote(process.execPath)}\nargs = ${args}\n`
  )
  const shim = spawn(shimExe, [], { windowsHide: true, stdio: 'ignore' })
  let report: UiReport | undefined
  try {
    report = await waitFor(
      () =>
        existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8')) as UiReport) : undefined,
      30000,
      'the UI report (real Scoop shim)'
    )
    const hostInJobBeforeClose = inJob(report.hostPid) === 'true'
    shim.kill()
    const uiPid = report.uiPid
    await waitFor(() => (isAlive(uiPid) ? undefined : true), 15000, 'the UI to end with the shim')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const reply = await ask(pipe, 'ping')
    const measurement: Measurement = {
      jobKind: 'real-scoop-shim',
      ...report,
      hostInJobBeforeClose,
      uiExitedWithJob: !isAlive(uiPid),
      hostAnswersAfterClose: reply === `pong ${report.hostPid}`
    }
    measurements.push(measurement)
    return measurement
  } finally {
    if (report && isAlive(report.hostPid)) {
      await ask(pipe, 'quit')
      // AMENDED: was `if (isAlive(report.hostPid)) process.kill(report.hostPid)`, the check-then-kill race of runChain.
      await endIfAlive(report.hostPid, statSync(outFile).mtimeMs)
    }
    // AMENDED: was `if (report && isAlive(report.uiPid)) process.kill(report.uiPid)`, the same race.
    if (report) await endIfAlive(report.uiPid, statSync(outFile).mtimeMs)
    if (shim.exitCode === null) shim.kill()
  }
}

/** Starts a real Node child that idles until it is ended (or exits on its own after `lifetimeMs`). */
function startIdleChild(lifetimeMs: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', `setTimeout(() => {}, ${lifetimeMs})`], {
    windowsHide: true
  })
}

const exitOf = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })

// The harness's own cleanup, on real processes of this OS (no faked OS): it must not fail a run whose process
// already ended, which is what happens when the Host exits from `quit` between a liveness check and the kill.
describe('SP-02 harness cleanup', () => {
  it('[SP-02] ending a process that has already exited reports it gone instead of throwing ESRCH', async () => {
    const child = startIdleChild(0)
    // The process exists once spawn returns: it started no later than this.
    const seenAtMs = Date.now()
    await exitOf(child)
    const pid = child.pid ?? 0
    expect(pid).toBeGreaterThan(0)
    let outcome: string
    try {
      outcome = await endIfAlive(pid, seenAtMs)
    } catch (error) {
      outcome = `threw ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    }
    expect(outcome).toBe('gone')
  })

  it('[SP-02] ending a process that still runs ends it', async () => {
    const child = startIdleChild(60_000)
    const seenAtMs = Date.now()
    try {
      const pid = child.pid ?? 0
      expect(pid).toBeGreaterThan(0)
      expect(await endIfAlive(pid, seenAtMs)).toBe('ended')
      await exitOf(child)
      expect(isAlive(pid)).toBe(false)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  })
})

describe.runIf(process.platform === 'win32')(
  'SP-02: the Host survives the UI job (ADR-002 D6)',
  () => {
    beforeAll(() => {
      workDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp02-'))
      const source = path.join(workDir, 'sp02.cs')
      helperExe = path.join(workDir, 'sp02.exe')
      hostScript = path.join(workDir, 'host.mjs')
      uiScript = path.join(workDir, 'ui.mjs')
      writeFileSync(source, CSHARP)
      writeFileSync(hostScript, HOST)
      writeFileSync(uiScript, UI)
      const windir = process.env['WINDIR'] ?? 'C:\\Windows'
      const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
      execFileSync(csc, ['/nologo', `/out:${helperExe}`, '/r:System.Management.dll', source])
    }, 60000)

    afterAll(async () => {
      const reportFile = process.env['SP02_REPORT']
      if (reportFile) {
        const testProcessInJob = helperExe ? inJob(process.pid) : 'unknown'
        writeFileSync(reportFile, JSON.stringify({ testProcessInJob, measurements }, null, 2))
      }
      // The helper image may stay locked for a moment after its last process exits.
      for (let attempt = 0; attempt < 10 && workDir; attempt += 1) {
        try {
          rmSync(workDir, { recursive: true, force: true })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    })

    it('[SP-02, ADR-002] a Host started from a job child, directly and through the shim, still answers after the job is closed', async () => {
      // "Directly": the UI sits in a KILL_ON_JOB_CLOSE job, with and without BREAKAWAY_OK. "Through the shim": the UI
      // was started by a Scoop-style shim.
      for (const jobKind of ['plain', 'breakaway-ok', 'scoop-shim'] as const) {
        const measured = await runChain(jobKind, 'd6')
        expect(measured.uiInJob, `the UI is in the ${jobKind} job`).toBe(true)
        expect(measured.uiExitedWithJob, `closing the ${jobKind} job ends the UI`).toBe(true)
        expect(measured.hostAnswersAfterClose, `the Host answers after the ${jobKind} job`).toBe(
          true
        )
        expect(measured.hostInJobBeforeClose, `the Host is outside every job (${jobKind})`).toBe(
          false
        )
        // A job without BREAKAWAY_OK refuses the breakaway launcher, so D6 item 2 (WMI) must take over. Where the job
        // allows breakaway, the launcher used also depends on any job the test runner itself is in.
        if (jobKind === 'plain') expect(measured.launcher, 'plain job → WMI fallback').toBe('wmi')
      }
    }, 120000)

    it('[SP-02] a Host spawned with Node spawn({ detached: true }) stays in a job the UI is in unless the job grants silent breakaway', async () => {
      // Why Node's own spawn is not the start path (ADR-002 D6 item 4): libuv sets no breakaway flag.
      const expectedSurvival: Record<Exclude<JobKind, 'real-scoop-shim'>, boolean> = {
        plain: false,
        'breakaway-ok': false,
        'scoop-shim': true
      }
      for (const jobKind of ['plain', 'breakaway-ok', 'scoop-shim'] as const) {
        const measured = await runChain(jobKind, 'node-detached')
        expect(measured.uiExitedWithJob, `closing the ${jobKind} job ends the UI`).toBe(true)
        expect(measured.hostAnswersAfterClose, `Node-spawned Host after the ${jobKind} job`).toBe(
          expectedSurvival[jobKind]
        )
      }
    }, 120000)

    // Owner-only: needs an installed Scoop (spike-results/SP-02.md, owner steps). CI and agents skip it.
    it.runIf(Boolean(process.env['SP02_SCOOP_SHIM']))(
      '[SP-02, ADR-002] a Host started from a UI launched through the installed Scoop shim still answers after the shim ends',
      async () => {
        const measured = await runRealShimChain(process.env['SP02_SCOOP_SHIM'] ?? '')
        expect(measured.uiInJob, 'the UI is in the shim job').toBe(true)
        expect(measured.uiExitedWithJob, 'ending the shim ends the UI').toBe(true)
        expect(measured.hostInJobBeforeClose, 'the Host is outside every job').toBe(false)
        expect(measured.hostAnswersAfterClose, 'the Host answers after the shim ends').toBe(true)
      },
      60000
    )
  }
)
