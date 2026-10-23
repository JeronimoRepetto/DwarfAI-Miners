// P-06 (`20` §2.3, §8 R-10; ADR-026 item 1; `19` §3; ISSUE-271): the packaged build writes its log segments to the
// documented `logs/` folder, `<userData>/logs/`. The check starts the packed app of this OS from the artifact folder
// under a temp profile (the same isolation as the E2E harness: `--user-data-dir`, the home folders and the Host's data
// root inside the profile, `--background` so no window opens), waits for its first log segment, ends the app and its
// Host, and then reads the whole profile: at least one segment (`host-`, `ui-` or `shim-<n>.jsonl`) must sit directly
// in `<userData>/logs/`, and none anywhere else. The observed path is printed for R-10's README text (the folder name
// per OS is open, OI-20-5). A folder with no packed app fails, so a broken build never passes.
//
// It starts the app, so it runs only where the artifact was built (`pnpm test:packaged` on that OS's runner); Linux
// needs a display (xvfb). Its fixtures live in the temp profile, which it removes.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const id = 'P-06'

const PRODUCT_NAME = 'DwarfAI-Miners'
const SEGMENT = /^(?:host|ui|shim)-\d+\.jsonl$/
const SEGMENT_WAIT_MS = 90_000
const SETTLE_MS = 2_000
const KILL_WAIT_MS = 10_000
const STDERR_TAIL_CHARS = 2_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function entries(dir) {
  return (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}

/** The size of the file at `file`, 0 when it cannot be read. */
function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** The largest regular file of `dir` whose name `accepts`, or null. */
async function largestFile(dir, accepts) {
  let best = null
  for (const entry of await entries(dir)) {
    if (!entry.isFile() || !accepts(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (best === null || sizeOf(file) > sizeOf(best)) best = file
  }
  return best
}

/**
 * The executable of the packed app this runner can start: Windows `win-*unpacked/DwarfAI-Miners.exe`, Linux the
 * largest extension-less file of `linux-*unpacked` (the Electron binary, not `chrome-sandbox`), macOS the largest
 * file in `Contents/MacOS` of the `.app` for this CPU (`mac-arm64` or `mac`, electron-builder's folder names).
 */
export async function findExecutable({ artifactDir, platform, arch }) {
  for (const folder of await entries(artifactDir)) {
    if (!folder.isDirectory()) continue
    const dir = path.join(artifactDir, folder.name)
    if (platform === 'win32' && /^win(?:-[\w]+)?-unpacked$/.test(folder.name)) {
      const exe = path.join(dir, `${PRODUCT_NAME}.exe`)
      if (existsSync(exe)) return exe
    }
    if (platform === 'linux' && /^linux(?:-[\w]+)?-unpacked$/.test(folder.name)) {
      const exe = await largestFile(
        dir,
        (name) => !name.includes('.') && !name.startsWith('chrome')
      )
      if (exe !== null) return exe
    }
    if (platform === 'darwin' && folder.name === (arch === 'arm64' ? 'mac-arm64' : 'mac')) {
      for (const bundle of await entries(dir)) {
        if (!bundle.isDirectory() || !bundle.name.endsWith('.app')) continue
        const exe = await largestFile(path.join(dir, bundle.name, 'Contents', 'MacOS'), () => true)
        if (exe !== null) return exe
      }
    }
  }
  return null
}

/** A temp profile: userData, home folders and the Host's data root all inside one folder this check removes. */
function createProfile(platform) {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-p06-'))
  const userDataDir = path.join(root, 'userData')
  // On macOS the Host's socket lives under HOME and a path under the per-user temp folder is too long for it.
  const dataRoot = platform === 'darwin' ? mkdtempSync('/tmp/dwp6-') : path.join(root, 'data')
  const home = platform === 'darwin' ? dataRoot : path.join(root, 'home')
  for (const dir of [userDataDir, dataRoot, path.join(home, 'AppData', 'Roaming')]) {
    mkdirSync(dir, { recursive: true })
  }
  return { root, userDataDir, dataRoot, home }
}

/** The app's environment: the runner's, with the per-user folders and the Host's data root in the profile. */
function appEnvironment(profile, platform) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'].includes(key.toUpperCase())) continue
    env[key] = value
  }
  const set = (key, value) => {
    for (const existing of Object.keys(env))
      if (existing.toUpperCase() === key.toUpperCase()) delete env[existing]
    env[key] = value
  }
  set('HOME', profile.home)
  set('USERPROFILE', profile.home)
  set('APPDATA', path.join(profile.home, 'AppData', 'Roaming'))
  set('XDG_CONFIG_HOME', path.join(profile.home, '.config'))
  set('XDG_STATE_HOME', path.join(profile.home, '.local', 'state'))
  set('CLAUDE_CONFIG_DIR', path.join(profile.root, 'claude'))
  set('CODEX_HOME', path.join(profile.root, 'codex'))
  set(
    platform === 'win32' ? 'LOCALAPPDATA' : platform === 'darwin' ? 'HOME' : 'XDG_DATA_HOME',
    profile.dataRoot
  )
  return env
}

/** The segments of `dir` and below, as absolute paths. */
async function segmentsUnder(dir) {
  const found = []
  for (const entry of await entries(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await segmentsUnder(full)))
    else if (entry.isFile() && SEGMENT.test(entry.name)) found.push(full)
  }
  return found
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The pid in the profile's `host/run/host.identity`, or null when the Host wrote none. */
function hostPidOf(userDataDir) {
  try {
    const pid = JSON.parse(
      readFileSync(path.join(userDataDir, 'host', 'run', 'host.identity'), 'utf8')
    ).pid
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Ends the app the check started with its process tree, then the temp profile's Host. */
async function endApp(child, userDataDir) {
  const hostPid = hostPidOf(userDataDir)
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: KILL_WAIT_MS
        })
      } else {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      child.kill('SIGKILL')
    }
  }
  const deadline = Date.now() + KILL_WAIT_MS
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(100)
  }
  // The Host never exits on its own (ADR-002 D7): this temp profile's one is ended by the pid it recorded.
  const host = hostPidOf(userDataDir) ?? hostPid
  if (host !== null && alive(host)) {
    try {
      process.kill(host)
    } catch {
      // Gone meanwhile.
    }
    while (alive(host) && Date.now() < deadline) await sleep(100)
  }
}

/**
 * The command that starts the app. A Linux runner with no display (a CI job, an SSH session) gives Electron nothing to
 * draw on, even for a `--background` start with no window, so there the app starts under `xvfb-run`, as the E2E,
 * OS and perf lanes do; with a display it starts directly, as it does on Windows and macOS.
 */
export function launchCommand({ executable, args, platform, env }) {
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { command: 'xvfb-run', args: ['--auto-servernum', executable, ...args] }
  }
  return { command: executable, args }
}

const spawnApp = ({ command, args, env, platform }) =>
  spawn(command, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true
  })

/**
 * Starts the packed app under `profile` and returns once its first log segment is written; always ends the app. A
 * failure names the app's exit code (null while it still runs) and the tail of what it wrote to stderr.
 */
export async function runPackagedApp({ executable, profile, platform, start = spawnApp }) {
  const args = [`--user-data-dir=${profile.userDataDir}`, '--background']
  // The Chromium sandbox helper of an unpacked Linux build is not setuid in a CI checkout.
  if (platform === 'linux') args.push('--no-sandbox')
  const env = appEnvironment(profile, platform)
  const child = start({ ...launchCommand({ executable, args, platform, env }), env, platform })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
  })
  let spawnError = null
  child.once('error', (error) => (spawnError = error))
  const why = (message) => {
    const tail = stderr.trim()
    return new Error(
      `${message}; exit code ${child.exitCode ?? child.signalCode ?? 'none (still running)'}; stderr: ` +
        (tail === '' ? '(empty)' : tail)
    )
  }
  try {
    const deadline = Date.now() + SEGMENT_WAIT_MS
    for (;;) {
      if (spawnError !== null) throw why(`the app could not start: ${spawnError.message}`)
      if ((await segmentsUnder(profile.userDataDir)).length > 0) break
      if (child.exitCode !== null || child.signalCode !== null)
        throw why('the app exited before writing a log segment')
      if (Date.now() >= deadline)
        throw why(`the app wrote no log segment within ${SEGMENT_WAIT_MS} ms`)
      await sleep(250)
    }
    // The Host and the shim write their first segments a moment after the UI's.
    await sleep(SETTLE_MS)
  } finally {
    await endApp(child, profile.userDataDir)
  }
}

async function removeProfile(profile) {
  for (const dir of [profile.root, profile.dataRoot]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch (error) {
        // Windows frees a killed tree's files a moment after it exits (EPERM, EBUSY).
        if (attempt >= 20) throw error
        await sleep(250)
      }
    }
  }
}

export default async function check({
  artifactDir,
  run = runPackagedApp,
  platform = process.platform,
  arch = process.arch
}) {
  const executable = await findExecutable({ artifactDir, platform, arch })
  if (executable === null) {
    return {
      ok: false,
      detail: `no packed app executable for ${platform}-${arch} in ${artifactDir}`
    }
  }
  const profile = createProfile(platform)
  try {
    await run({ executable, profile, platform })
    const logsDir = path.join(profile.userDataDir, 'logs')
    const segments = [
      ...(await segmentsUnder(profile.root)),
      ...(profile.dataRoot.startsWith(profile.root) ? [] : await segmentsUnder(profile.dataRoot))
    ]
    const inside = segments.filter((file) => path.dirname(file) === logsDir)
    const outside = segments.filter((file) => path.dirname(file) !== logsDir)
    if (outside.length > 0) {
      return {
        ok: false,
        detail:
          outside
            .map((file) => path.relative(profile.root, file).split(path.sep).join('/'))
            .join(', ') + ` written outside ${logsDir}`
      }
    }
    if (inside.length === 0) return { ok: false, detail: `no log segment in ${logsDir}` }
    return {
      ok: true,
      detail:
        `${inside.length} log segments, all in <userData>/logs/; observed ${logsDir} ` +
        `(userData ${profile.userDataDir}) for R-10's ${PRODUCT_NAME} path`
    }
  } catch (error) {
    return {
      ok: false,
      detail: `the packaged app did not run: ${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    await removeProfile(profile).catch(() => {})
  }
}
