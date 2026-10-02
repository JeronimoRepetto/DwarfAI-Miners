// L8 OS lane (17 §1.8; ADR-002 D3, D6; 07 S12.02; 13 FM-009, FM-012, FM-114): the Host launcher
// with real processes of this platform. The Host is the stub of fixtures/bin/fake-host, started the
// way the real Host is started: the installed Electron binary with ELECTRON_RUN_AS_NODE=1, the
// entry script, DWARFAI_HOST_DATA_DIR. Each case uses its own temporary data folder and a private
// endpoint (a pipe or socket name no DwarfAI-Miners on this machine uses), so it never meets the
// owner's app. A spawned Host is detached by design: every case ends each Host it started in its
// `finally` and checks that none is left running.
//
// The Windows job case is spike SP-02's harness made the regression test (17 §4; ISSUE-314): a job
// holder (C#, compiled at test time by the .NET Framework compiler that ships with Windows) puts a
// "UI" — a Node process running the launcher's own code, bundled for the run — into a
// KILL_ON_JOB_CLOSE job, the UI starts the Host, the holder closes the job, and the test asks the
// Host for `hello`.
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type HostEndpoint } from '@dwarfai/contracts'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { buildManifest, serializeManifest } from './hostManifest'
import { createHelloProber } from './helloProber'
import { createNodeHostLauncher } from './index'
import { createPosixSpawner } from './posix'
import { buildHostSpawn } from './spawnHost'
import { copySourceOf } from './versionedCopy'
import { loadWinLaunch } from './win-launch/nativeWinLaunch'
import { createWindowsSpawner } from './windows'

const WINDOWS = process.platform === 'win32'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const FAKE_HOST = path.join(REPO_ROOT, 'fixtures', 'bin', 'fake-host', 'fake-host.cjs')
/** The Electron binary of the installed `electron` package (its main export is the path). */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const CLIENT = { appVersion: '0.0.0', buildId: 'os-test' }
// ADDED for ISSUE-031: the launcher starts the Host from its versioned copy (ADR-002 D5), made from
// the installed Electron runtime against this manifest, into each world's own copy root.
const MANIFEST_TEXT = serializeManifest(
  await buildManifest(
    copySourceOf(
      ELECTRON,
      process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
    )
  )
)
const CASE_TIMEOUT_MS = 120_000
// ADDED (fix: Windows launch timeout): the launch helper the Windows spawner loads, built by
// `pnpm build:native` into the repository's prebuilds/.
const PREBUILDS = path.join(REPO_ROOT, 'prebuilds')

interface FakeHostReport {
  pid: number
  epoch: string
  runAsNode: boolean
  dataDirArrived: boolean
  cwd: string
  envNames: string[]
}

/** One case's folder, Host data folder and private endpoint. */
interface World {
  root: string
  hostDataDir: string
  endpoint: HostEndpoint
  /** ADDED for ISSUE-031: this world's copy root and build manifest. */
  copyRoot: string
  hostManifest: string
}

const worlds: World[] = []

function newWorld(mode: 'ready' | 'migrating' = 'ready'): World {
  // On POSIX directly under /tmp, so the socket path fits sun_path on macOS.
  const root = WINDOWS
    ? mkdtempSync(path.join(tmpdir(), 'dwarfai-030-os-'))
    : mkdtempSync('/tmp/dw030-')
  const hostDataDir = path.join(root, 'userData', 'host')
  mkdirSync(hostDataDir, { recursive: true })
  const endpoint: HostEndpoint = WINDOWS
    ? {
        kind: 'named-pipe',
        path: `\\\\.\\pipe\\dwarfai-test-030-${randomBytes(8).toString('hex')}`
      }
    : {
        kind: 'unix-socket',
        dir: path.join(root, 'run'),
        path: path.join(root, 'run', 'host-0123456789ab.sock')
      }
  writeFileSync(
    path.join(hostDataDir, 'fake-host.json'),
    JSON.stringify({
      endpoint: endpoint.path,
      mode,
      migratingMs: 1_000,
      maxLifeMs: CASE_TIMEOUT_MS
    })
  )
  const hostManifest = path.join(root, 'host-manifest.json')
  writeFileSync(hostManifest, MANIFEST_TEXT)
  const world = { root, hostDataDir, endpoint, copyRoot: path.join(root, 'copies'), hostManifest }
  worlds.push(world)
  return world
}

function launcherFor(world: World, log = new RecordingUiLog()) {
  return createNodeHostLauncher({
    hostDataDir: world.hostDataDir,
    execPath: ELECTRON,
    hostEntry: FAKE_HOST,
    hostManifest: world.hostManifest,
    build: 'dev',
    copyRoot: world.copyRoot,
    prebuildsDir: PREBUILDS,
    log,
    client: CLIENT,
    endpoint: world.endpoint
  })
}

/** Every fake Host that bound in this world, by its report. */
function hostReports(world: World): FakeHostReport[] {
  return readdirSync(world.hostDataDir)
    .filter((name) => /^fake-host-\d+\.json$/.test(name))
    .map(
      (name) =>
        JSON.parse(readFileSync(path.join(world.hostDataDir, name), 'utf8')) as FakeHostReport
    )
}

function proberFor(world: World) {
  return createHelloProber({
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = connect(world.endpoint.path)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      }),
    tokenFile: path.join(world.hostDataDir, 'run', 'ui.token'),
    protocolVersion: PROTOCOL_VERSION,
    client: { ...CLIENT, pid: process.pid }
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

/** Ends `pid` and waits until it is gone; true when nothing is left. */
async function endProcess(pid: number): Promise<boolean> {
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (let waited = 0; waited < 5_000 && isAlive(pid); waited += 100) await sleep(100)
  return !isAlive(pid)
}

/** Ends every fake Host of every world, then removes the worlds; fails the case if a Host survives. */
async function endEveryHost(): Promise<void> {
  const ended = worlds.splice(0)
  const survivors: number[] = []
  for (const world of ended) {
    for (const report of hostReports(world)) {
      if (!(await endProcess(report.pid))) survivors.push(report.pid)
    }
  }
  const leftovers: string[] = []
  for (const world of ended) {
    if (!(await removeFolder(world.root))) leftovers.push(world.root)
  }
  expect(survivors, 'no Host process is left running').toEqual([])
  expect(leftovers, 'every temporary folder is removed').toEqual([])
}

/** Removes `dir`, retrying while Windows still holds a just-ended process's folder for up to 10 s. */
async function removeFolder(dir: string): Promise<boolean> {
  for (let waited = 0; waited <= 10_000; waited += 250) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(250)
    }
  }
  return false
}

describe('Host launcher with real processes (ADR-002 D3, D6)', () => {
  afterAll(async () => {
    await endEveryHost()
  })

  it(
    '[S12.02, FM-009] a second Host started against a running one exits ALREADY_RUNNING and the UI attaches to the first',
    async () => {
      const world = newWorld()
      try {
        const log = new RecordingUiLog()
        expect(await launcherFor(world, log).ensureHostRunning(), JSON.stringify(log.entries)).toBe(
          'spawned'
        )
        const [first, ...others] = hostReports(world)
        expect(others).toEqual([])
        expect(first?.runAsNode, 'ELECTRON_RUN_AS_NODE reached the Host').toBe(true)
        expect(first?.dataDirArrived, 'DWARFAI_HOST_DATA_DIR reached the Host').toBe(true)
        // The UI's own environment came along (names compared ignoring case, as Windows does).
        expect(first?.envNames.map((name) => name.toUpperCase())).toContain(
          WINDOWS ? 'SYSTEMROOT' : 'PATH'
        )

        // A second Host started the launcher's way against the same data folder and endpoint.
        const spawner = WINDOWS
          ? createWindowsSpawner({ loadHelper: () => loadWinLaunch({ prebuildsDir: PREBUILDS }) })
          : createPosixSpawner()
        const second = await spawner(
          buildHostSpawn({
            execPath: ELECTRON,
            hostEntry: FAKE_HOST,
            hostDataDir: world.hostDataDir,
            uiEnv: process.env
          })
        )
        if (second.kind !== 'launched') throw new Error(`second launch: ${JSON.stringify(second)}`)
        try {
          expect(await second.host.exited).toBe(64)
        } finally {
          second.host.release()
        }
        expect(hostReports(world).map((report) => report.pid)).toEqual([first?.pid])

        expect(await launcherFor(world).ensureHostRunning()).toBe('attached')
        expect(isAlive(first?.pid ?? -1)).toBe(true)
        expect(await proberFor(world)()).toMatchObject({ kind: 'hello-ok', state: 'ready' })
      } finally {
        await endEveryHost()
      }
    },
    CASE_TIMEOUT_MS
  )

  it.runIf(WINDOWS)(
    '[ADR-002, FM-114] on Windows no console window is created for the Host',
    async () => {
      const world = newWorld()
      try {
        expect(await launcherFor(world).ensureHostRunning()).toBe('spawned')
        const [host] = hostReports(world)
        const pid = host?.pid ?? -1
        const powershell = path.join(
          process.env['SystemRoot'] ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        )
        const script = [
          `$consoles = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='conhost.exe'").Count`,
          `$window = (Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`,
          '"$consoles $window"'
        ].join('; ')
        // Sampled over the Host's first second and after: a console flash would show in either.
        for (let sample = 0; sample < 3; sample += 1) {
          const answer = execFileSync(
            powershell,
            ['-NoProfile', '-NonInteractive', '-Command', script],
            {
              encoding: 'utf8',
              windowsHide: true
            }
          ).trim()
          expect(answer, 'no conhost child and no visible window').toBe('0 0')
          await sleep(300)
        }
      } finally {
        await endEveryHost()
      }
    },
    CASE_TIMEOUT_MS
  )
})

// ---- the UI-in-a-job / UI-in-a-process-group cases: the UI is a separate Node process ----

/** The UI process: runs ensureHostRunning with the launcher's own code, reports, stays alive. */
function uiEntry(): string {
  const index = path.join(HERE, 'index.ts').replace(/\\/g, '/')
  return [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    `import { createNodeHostLauncher } from '${index}'`,
    "const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))",
    'const entries = []',
    'setTimeout(() => process.exit(0), 120_000)',
    'try {',
    '  const launcher = createNodeHostLauncher({ ...config, log: { record: (entry) => entries.push(entry) } })',
    '  const result = await launcher.ensureHostRunning()',
    '  writeFileSync(config.reportFile, JSON.stringify({ result, entries, uiPid: process.pid }))',
    '} catch (error) {',
    '  writeFileSync(config.reportFile, JSON.stringify({ error: String(error), uiPid: process.pid }))',
    '}',
    'setInterval(() => {}, 1_000)'
  ].join('\n')
}

interface UiReport {
  result?: unknown
  error?: string
  entries?: Array<{ event: string; causeClass?: string }>
  uiPid: number
}

/** Bundles the UI entry with the repository's launcher into one ESM file. */
async function buildUi(dir: string): Promise<string> {
  const entry = path.join(dir, 'ui-entry.mjs')
  writeFileSync(entry, uiEntry())
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: { '@dwarfai/contracts': path.join(REPO_ROOT, 'src', 'contracts', 'index.ts') }
    },
    ssr: { noExternal: true },
    build: {
      ssr: entry,
      outDir: path.join(dir, 'ui'),
      emptyOutDir: true,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'ui.mjs' } }
    }
  })
  return path.join(dir, 'ui', 'ui.mjs')
}

function uiConfig(world: World, reportFile: string): string {
  const file = path.join(world.root, 'ui-config.json')
  writeFileSync(
    file,
    JSON.stringify({
      hostDataDir: world.hostDataDir,
      execPath: ELECTRON,
      hostEntry: FAKE_HOST,
      hostManifest: world.hostManifest,
      build: 'dev',
      copyRoot: world.copyRoot,
      prebuildsDir: PREBUILDS,
      client: CLIENT,
      endpoint: world.endpoint,
      reportFile
    })
  )
  return file
}

function readUiReport(file: string): UiReport | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as UiReport) : undefined
}

function launchedHow(report: UiReport): string | undefined {
  return report.entries?.find((entry) => entry.event === 'host.spawn')?.causeClass
}

/** SP-02's job holder and job query (spikes/SP-02/hostSurvivesJob.os.test.ts). */
const JOB_TOOL = String.raw`
using System;
using System.Runtime.InteropServices;

static class JobTool {
  const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
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
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);

  static int Main(string[] args) {
    switch (args[0]) {
      case "holder": return Holder(args[1], args[2]);
      case "injob": return InJob(int.Parse(args[1]));
      case "canbreak": return CanBreak(args[1]);
    }
    return 2;
  }

  static IntPtr NewJob(uint flags) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    EXTENDED_LIMIT info = new EXTENDED_LIMIT();
    info.Basic.LimitFlags = flags;
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) {
      Console.WriteLine("error SetInformationJobObject " + Marshal.GetLastWin32Error()); return IntPtr.Zero;
    }
    return job;
  }

  // The UI's parent: a KILL_ON_JOB_CLOSE job; "scoop-shim" is the job Scoop's shim.exe gives its program.
  // ADDED (fix: Windows launch timeout): "nested" puts the UI in a job that allows breakaway, nested
  // inside one that forbids it (SP-02 finding 2: a breakaway can then succeed and still leave the
  // child in the outer job).
  static int Holder(string kind, string cmd) {
    uint flags = KILL_ON_JOB_CLOSE;
    if (kind == "breakaway-ok" || kind == "nested") flags |= BREAKAWAY_OK;
    if (kind == "scoop-shim") flags |= SILENT_BREAKAWAY_OK;
    IntPtr outer = kind == "nested" ? NewJob(KILL_ON_JOB_CLOSE) : IntPtr.Zero;
    IntPtr job = NewJob(flags);
    if (job == IntPtr.Zero || (kind == "nested" && outer == IntPtr.Zero)) return 1;
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW,
        IntPtr.Zero, null, ref si, out pi)) {
      Console.WriteLine("error CreateProcess " + Marshal.GetLastWin32Error()); return 1;
    }
    if (outer != IntPtr.Zero && !AssignProcessToJobObject(outer, pi.hProcess)) {
      Console.WriteLine("error AssignProcessToJobObject " + Marshal.GetLastWin32Error()); return 1;
    }
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
      Console.WriteLine("error AssignProcessToJobObject " + Marshal.GetLastWin32Error()); return 1;
    }
    ResumeThread(pi.hThread);
    Console.WriteLine("child " + pi.dwProcessId);
    Console.Out.Flush();
    Console.ReadLine();
    CloseHandle(job);
    if (outer != IntPtr.Zero) CloseHandle(outer);
    bool exited = WaitForSingleObject(pi.hProcess, 10000) == 0;
    Console.WriteLine("child-exited " + (exited ? "true" : "false"));
    Console.Out.Flush();
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

  // Whether the jobs this tool runs in (the test runner's) let a child break away: the outer jobs the
  // UI inherits from the runner decide whether a breakaway-ok job can be left (SP-02 "Results").
  static int CanBreak(string cmd) {
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
        CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi)) {
      Console.WriteLine("false"); return 0;
    }
    bool inJob;
    IsProcessInJob(pi.hProcess, IntPtr.Zero, out inJob);
    TerminateProcess(pi.hProcess, 0);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    Console.WriteLine(inJob ? "false" : "true");
    return 0;
  }
}
`

describe.runIf(WINDOWS)('Host survival on Windows (SP-02 regression test)', () => {
  let toolsDir = ''
  let jobTool = ''
  let uiScript = ''
  let runnerCanBreakAway = false

  beforeAll(async () => {
    toolsDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-030-job-'))
    const source = path.join(toolsDir, 'jobtool.cs')
    jobTool = path.join(toolsDir, 'jobtool.exe')
    writeFileSync(source, JOB_TOOL)
    const windir = process.env['WINDIR'] ?? 'C:\\Windows'
    const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    execFileSync(csc, ['/nologo', `/out:${jobTool}`, source], { windowsHide: true })
    uiScript = await buildUi(toolsDir)
    const probeTarget = `"${path.join(windir, 'System32', 'whoami.exe')}"`
    runnerCanBreakAway =
      execFileSync(jobTool, ['canbreak', probeTarget], {
        encoding: 'utf8',
        windowsHide: true
      }).trim() === 'true'
  }, CASE_TIMEOUT_MS)

  afterAll(async () => {
    // The tool's image may stay locked for a moment after its last process exits.
    rmSync(toolsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    await endEveryHost()
  })

  const inJob = (pid: number): string =>
    execFileSync(jobTool, ['injob', String(pid)], { encoding: 'utf8', windowsHide: true }).trim()

  /** holder(job kind) → UI → Host; closes the job; returns what was measured. */
  async function runChain(jobKind: 'plain' | 'breakaway-ok' | 'scoop-shim' | 'nested') {
    const world = newWorld()
    const reportFile = path.join(world.root, 'ui-report.json')
    const uiCmd = [process.execPath, uiScript, uiConfig(world, reportFile)]
      .map((part) => `"${part}"`)
      .join(' ')
    const holder: ChildProcessWithoutNullStreams = spawn(jobTool, ['holder', jobKind, uiCmd], {
      windowsHide: true
    })
    const lines: string[] = []
    createInterface({ input: holder.stdout }).on('line', (line) => lines.push(line))
    let uiPid = 0
    try {
      const childLine = await waitFor(
        () => lines.find((line) => line.startsWith('child ') || line.startsWith('error')),
        10_000,
        'the job holder'
      )
      expect(childLine, `job holder (${jobKind})`).toMatch(/^child \d+$/)
      uiPid = Number(childLine.slice('child '.length))
      const report = await waitFor(
        () => readUiReport(reportFile),
        60_000,
        `the UI report (${jobKind})`
      )
      expect(report.result, `${jobKind}: ${JSON.stringify(report)}`).toBe('spawned')
      const [host] = hostReports(world)
      const hostPid = host?.pid ?? -1
      const measured = {
        uiInJob: inJob(uiPid) === 'true',
        hostInJobBeforeClose: inJob(hostPid) === 'true',
        launcher: launchedHow(report)
      }
      holder.stdin.write('close\n')
      const exited = await waitFor(
        () => lines.find((line) => line.startsWith('child-exited ')),
        15_000,
        'the job to close'
      )
      await sleep(500)
      return {
        ...measured,
        uiExitedWithJob: exited === 'child-exited true' && !isAlive(uiPid),
        hostAnswersAfterClose: await proberFor(world)()
      }
    } finally {
      if (uiPid !== 0) await endProcess(uiPid)
      if (holder.exitCode === null) holder.kill()
    }
  }

  it(
    '[SP-02, FM-012] on Windows a UI started inside a KILL_ON_JOB_CLOSE job spawns a Host that survives the job being closed',
    async () => {
      try {
        for (const jobKind of ['plain', 'breakaway-ok', 'scoop-shim'] as const) {
          const measured = await runChain(jobKind)
          expect(measured.uiInJob, `the UI is in the ${jobKind} job`).toBe(true)
          expect(measured.hostInJobBeforeClose, `the Host is outside every job (${jobKind})`).toBe(
            false
          )
          expect(measured.uiExitedWithJob, `closing the ${jobKind} job ends the UI`).toBe(true)
          expect(
            measured.hostAnswersAfterClose,
            `the Host answers after the ${jobKind} job`
          ).toMatchObject({
            kind: 'hello-ok',
            state: 'ready'
          })
          // A job that forbids breakaway forces the WMI step (D6 item 2). Where the job allows it, the breakaway
          // step (D6 item 1) is used whenever the test runner's own jobs allow it too.
          const expected = jobKind === 'plain' || !runnerCanBreakAway ? 'wmi' : 'breakaway'
          expect(measured.launcher, `${jobKind} job → ${expected} step`).toBe(expected)
        }
      } finally {
        await endEveryHost()
      }
    },
    CASE_TIMEOUT_MS * 2
  )

  // ADDED (fix: Windows launch timeout): breakaway now runs inside the UI itself, so the job check
  // (resume the Host only when it is outside every job, else WMI) is proven where it matters: a UI in
  // nested jobs, whose inner job allows breakaway and whose outer job does not.
  it(
    '[SP-02, FM-012] on Windows a UI in nested jobs, the outer one forbidding breakaway, spawns a Host outside every job that survives the jobs being closed',
    async () => {
      try {
        const measured = await runChain('nested')
        expect(measured.uiInJob, 'the UI is in the nested jobs').toBe(true)
        expect(measured.hostInJobBeforeClose, 'the Host is outside every job').toBe(false)
        expect(measured.uiExitedWithJob, 'closing the jobs ends the UI').toBe(true)
        expect(measured.hostAnswersAfterClose, 'the Host answers after the jobs').toMatchObject({
          kind: 'hello-ok',
          state: 'ready'
        })
        // The outer job keeps a breakaway child, so the WMI step (D6 item 2) starts the Host.
        expect(measured.launcher, 'nested jobs → wmi step').toBe('wmi')
      } finally {
        await endEveryHost()
      }
    },
    CASE_TIMEOUT_MS
  )
})

describe.runIf(!WINDOWS)('Host survival on POSIX', () => {
  let toolsDir = ''
  let uiScript = ''

  beforeAll(async () => {
    toolsDir = mkdtempSync('/tmp/dw030-ui-')
    uiScript = await buildUi(toolsDir)
  }, CASE_TIMEOUT_MS)

  afterAll(async () => {
    rmSync(toolsDir, { recursive: true, force: true })
    await endEveryHost()
  })

  it(
    "[ADR-002] on POSIX the Host survives the UI's process group being killed",
    async () => {
      const world = newWorld()
      const reportFile = path.join(world.root, 'ui-report.json')
      // The UI leads its own process group, as an app started from a launcher or a shell does.
      const ui: ChildProcess = spawn(process.execPath, [uiScript, uiConfig(world, reportFile)], {
        detached: true,
        stdio: 'ignore'
      })
      const uiPid = ui.pid ?? -1
      try {
        const report = await waitFor(() => readUiReport(reportFile), 60_000, 'the UI report')
        expect(report.result, JSON.stringify(report)).toBe('spawned')
        const [host] = hostReports(world)
        process.kill(-uiPid, 'SIGKILL')
        await waitFor(() => (isAlive(uiPid) ? undefined : true), 10_000, 'the UI group to die')
        await sleep(500)
        expect(isAlive(host?.pid ?? -1), 'the Host still runs').toBe(true)
        expect(await proberFor(world)()).toMatchObject({ kind: 'hello-ok', state: 'ready' })
      } finally {
        await endProcess(uiPid)
        await endEveryHost()
      }
    },
    CASE_TIMEOUT_MS
  )
})
