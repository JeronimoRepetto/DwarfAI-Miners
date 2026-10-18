// Shared kit of the packaging spike lane (.github/workflows/spikes-package.yml; ISSUE-328): finds the packed apps in a
// folder, starts one, watches the Host it starts and clears the state an installed DwarfAI leaves, and writes scrubbed
// evidence. Used by spikes/S-019-2, S-019-3, S-027-1, S-027-3, SP-03 and S-008-1.
//
// Clearing state DELETES the DwarfAI app data, Host copies and run files of the current OS user. `assertDisposable`
// therefore refuses to run outside GitHub Actions unless `--allow-local` is passed: never run a harness that clears
// state on a machine whose DwarfAI data matters.
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import path from 'node:path'
import { scrubText } from '../../scripts/ci/packagingSpikes.mjs'

export const PLATFORM = process.platform

/** Refuses a destructive harness outside CI unless `--allow-local` was passed. */
export function assertDisposable(argv) {
  if (process.env.GITHUB_ACTIONS === 'true' || argv.includes('--allow-local')) return
  console.error(
    'This harness deletes the DwarfAI app data of the current user. It runs on CI runners only; pass --allow-local ' +
      'to run it on a disposable machine.'
  )
  process.exit(2)
}

/** `--name value` options and bare flags of argv. */
export function options(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      const previous = out[key]
      out[key] = previous === undefined ? next : [previous, next].flat()
      i += 1
    }
  }
  return out
}

export const list = (value) => (value === undefined ? [] : [value].flat())

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `probe` until it returns a truthy value or `timeoutMs` passes; returns the value or null. */
export async function waitFor(probe, timeoutMs, intervalMs = 250) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= end) return null
    await sleep(intervalMs)
  }
}

function largestFile(dir, accept) {
  let best = null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !accept(entry.name)) continue
    const size = statSync(path.join(dir, entry.name)).size
    if (!best || size > best.size) best = { name: entry.name, size }
  }
  return best?.name ?? null
}

/**
 * The packed Electron apps under `root` (depth-limited): `{ os, appDir, executable, fuseFile, asar, infoPlist }`.
 * A Windows or Linux app is a folder holding `resources/app.asar` beside its executable (the largest `.exe`, or the
 * largest file without an extension); a macOS app is a `.app` bundle.
 */
export function findPackedApps(root, maxDepth = 6) {
  const apps = []
  const walk = (dir, depth) => {
    if (depth > maxDepth || !existsSync(dir)) return
    if (dir.endsWith('.app') && existsSync(path.join(dir, 'Contents', 'Resources', 'app.asar'))) {
      const macos = path.join(dir, 'Contents', 'MacOS')
      const name = readdirSync(macos)[0]
      apps.push({
        os: 'darwin',
        appDir: dir,
        executable: path.join(macos, name),
        fuseFile: path.join(
          dir,
          'Contents',
          'Frameworks',
          'Electron Framework.framework',
          'Electron Framework'
        ),
        asar: path.join(dir, 'Contents', 'Resources', 'app.asar'),
        infoPlist: path.join(dir, 'Contents', 'Info.plist')
      })
      return
    }
    const asar = path.join(dir, 'resources', 'app.asar')
    if (existsSync(asar)) {
      const exe = largestFile(dir, (name) => /\.exe$/i.test(name))
      const bin = exe ?? largestFile(dir, (name) => !name.includes('.'))
      if (bin) {
        const executable = path.join(dir, bin)
        apps.push({
          os: exe ? 'win32' : 'linux',
          appDir: dir,
          executable,
          fuseFile: executable,
          asar,
          infoPlist: null
        })
        return
      }
    }
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink())
        walk(path.join(dir, entry.name), depth + 1)
    }
  }
  walk(path.resolve(root), 0)
  return apps
}

/**
 * The executable a harness starts: `--app <path>` as given, or the first packed app found under `--find <dir>` (on
 * Linux an AppImage file passed as `--app` is started as it is).
 */
export function resolveApp(args) {
  if (args.app) return path.resolve(args.app)
  if (args.find) {
    const app = findPackedApps(args.find)[0]
    if (app) return app.executable
  }
  return null
}

/** The per-OS folder Electron keeps app data in (`app.getPath('appData')`). */
export function appDataRoot() {
  if (PLATFORM === 'win32') return process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
  if (PLATFORM === 'darwin') return path.join(homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config')
}

/** The release build's Host copy root (`versionedCopyRoot`, ADR-002 D5, ADR-027 item 2). */
export function copyRoot() {
  if (PLATFORM === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
    return path.join(local, 'DwarfAI', 'host')
  }
  if (PLATFORM === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'DwarfAI', 'host')
  }
  const xdg = process.env.XDG_DATA_HOME
  const dataHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.local', 'share')
  return path.join(dataHome, 'dwarfai', 'host')
}

/** The app data folders a DwarfAI build made: each child of the app data root holding `host/`. */
export function dwarfaiDataDirs() {
  const root = appDataRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /dwarfai/i.test(entry.name))
    .map((entry) => path.join(root, entry.name))
}

/** The running Host's `host.identity` (ADR-002 D3) under any DwarfAI app data folder, or null. */
export function readHostIdentity() {
  for (const dir of dwarfaiDataDirs()) {
    const file = path.join(dir, 'host', 'run', 'host.identity')
    try {
      return { file, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch {
      // Not written (yet), or being replaced.
    }
  }
  return null
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Every process of the machine: `{ pid, ppid, executable, commandLine }`. */
export function processes() {
  if (PLATFORM === 'win32') {
    const json = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    )
    return [JSON.parse(json)].flat().map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      executable: p.ExecutablePath ?? '',
      commandLine: p.CommandLine ?? ''
    }))
  }
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      executable: command.split(' ')[0],
      commandLine: command
    }))
}

/** Ends a process and its children: `taskkill /T /F` on Windows, SIGKILL elsewhere. */
export function killTree(pid) {
  if (!pid || !isAlive(pid)) return
  try {
    if (PLATFORM === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      for (const child of processes().filter((p) => p.ppid === pid)) killTree(child.pid)
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // Already gone.
  }
}

/**
 * Whether a process runs from under one of `roots` (lower-cased, resolved). The command line is read too: on macOS
 * `ps` gives no separate executable path, and the one taken from the command line stops at the first space
 * (`~/Library/Application Support/...`).
 */
function runsUnder(p, roots) {
  const candidates = [p.executable, (p.commandLine || '').replace(/^"/, '')].map((value) =>
    (value || '').toLowerCase()
  )
  return roots.some((root) => candidates.some((value) => value.startsWith(root)))
}

/**
 * Ends every process running from under `dirs`, each one alone (never its tree): the UI and its helpers of an
 * installed app, while the Host, which runs from the copy root, lives on. Returns the pids it ended.
 */
export function endProcessesUnder(dirs) {
  const roots = dirs.map((dir) => path.resolve(dir).toLowerCase())
  const ended = []
  for (const p of processes()) {
    if (p.pid === process.pid || !runsUnder(p, roots)) continue
    try {
      if (PLATFORM === 'win32') {
        execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { stdio: 'ignore' })
      } else process.kill(p.pid, 'SIGKILL')
      ended.push(p.pid)
    } catch {
      // Already gone.
    }
  }
  return ended
}

/**
 * Copies the last `maxLines` lines of every product log file (ADR-026: `<app data>/logs/`, written by the UI and
 * the Host, allowlisted fields only) into `<outDir>/product-logs/<label>/`, scrubbed, so a run that ends before the
 * Host starts still shows why. Returns the files written (relative to `outDir`).
 */
export function saveProductLogs(outDir, label, maxLines = 400) {
  const written = []
  // `logs/` sits in the UI's data folder, or one level down (`<userData>/host/logs`): look up to three levels deep.
  const logDirs = []
  const walk = (root, dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === 'logs') logDirs.push({ root, logs: full })
      else walk(root, full, depth + 1)
    }
  }
  for (const dir of [...dwarfaiDataDirs(), path.dirname(copyRoot())]) walk(dir, dir, 0)
  for (const { root, logs } of logDirs) {
    const prefix = path.relative(path.dirname(root), logs).split(path.sep).join('_')
    for (const name of readdirSync(logs).sort()) {
      const file = path.join(logs, name)
      if (!statSync(file).isFile()) continue
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      const target = path.join(outDir, 'product-logs', label, `${prefix}_${name}`)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, scrub(lines.slice(-maxLines).join('\n')))
      written.push(path.relative(outDir, target).split(path.sep).join('/'))
    }
  }
  return written
}

/**
 * Ends every DwarfAI process (the Host by its identity file, then any process running from `appDirs` or the copy
 * root), then deletes the app data folders and the Host copy root. With `logsTo: { outDir, label }` it first saves
 * the product logs (`saveProductLogs`). Returns what it removed.
 */
export async function clearState({ appDirs = [], logsTo = null } = {}) {
  const identity = readHostIdentity()
  if (identity) killTree(identity.pid)
  const roots = [...appDirs, copyRoot()].map((dir) => path.resolve(dir).toLowerCase())
  for (const p of processes()) {
    if (p.pid !== process.pid && runsUnder(p, roots)) killTree(p.pid)
  }
  await sleep(1000)
  if (logsTo) saveProductLogs(logsTo.outDir, logsTo.label)
  const removed = []
  for (const dir of [...dwarfaiDataDirs(), path.dirname(copyRoot())]) {
    if (!existsSync(dir)) continue
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    removed.push(dir)
  }
  return removed
}

/** `{ files, bytes }` of a folder tree (0 when it does not exist). */
export function treeStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(full).size
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { files, bytes }
}

/** The top-level entries of a folder, or null when it does not exist. */
export function listing(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : null
}

/**
 * Starts an app executable detached from this process's console, its output into `logFile`. On Linux a missing
 * DISPLAY is the caller's to provide (the workflow runs the harness under `xvfb-run`).
 */
export function launch(executable, args, { logFile, env = process.env } = {}) {
  mkdirSync(path.dirname(logFile), { recursive: true })
  const out = []
  const child = spawn(executable, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: PLATFORM !== 'win32'
  })
  child.stdout.on('data', (chunk) => out.push(chunk))
  child.stderr.on('data', (chunk) => out.push(chunk))
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal }))
  )
  child.on('error', (error) => out.push(Buffer.from(`spawn error: ${error.message}\n`)))
  return {
    child,
    exited,
    flushLog: () => writeFileSync(logFile, scrub(Buffer.concat(out).toString('utf8')))
  }
}

/** Evidence text without the runner's home folder, user name or host name. */
export function scrub(text) {
  const user = userInfo().username
  return scrubText(text, [
    // Windows keeps TEMP in its 8.3 short form (`C:\Users\DWARFA~1\...`), which the home folder does not match.
    [process.env.TEMP, '<temp>'],
    [process.env.TMP, '<temp>'],
    [homedir(), '<home>'],
    [process.env.LOCALAPPDATA, '<localappdata>'],
    [process.env.APPDATA, '<appdata>'],
    [hostname(), '<host>', { word: true }],
    [user.length >= 4 ? user : '', '<user>', { word: true }]
  ])
}

/** Writes `value` as scrubbed JSON to `<outDir>/<name>.json` and returns it. */
export function writeEvidence(outDir, name, value) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, `${name}.json`), `${scrub(JSON.stringify(value, null, 2))}\n`)
  return value
}

/** The tool and OS facts every record states (NFR-OBS-04). */
export function environmentFacts() {
  return {
    date: new Date().toISOString(),
    platform: PLATFORM,
    arch: process.arch,
    node: process.version,
    runnerOs: process.env.RUNNER_OS ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null
  }
}
