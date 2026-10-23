// Shared by the packaged checks that read inside the app (P-02, P-04) or start it (P-05): where the packed apps of an
// artifact folder are and what their `app.asar` holds (files only), and the temp profile a started app runs under (the
// isolation P-06 uses too). Not a check: the runner discovers only `p<nn>-<name>.packaged.mjs`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listAsarFiles, parseAsarHeader, readAsarFile } from './asar.mjs'

/** Folders that never hold an app's own `app.asar`: the unpacked tree and the Chromium frameworks. */
const NOT_SEARCHED = new Set(['app.asar.unpacked', 'node_modules', 'Frameworks'])

/**
 * Every `app.asar` under `artifactDir` (each `win-*unpacked` and `linux-*unpacked` folder's `resources/`, each macOS
 * `.app`'s `Contents/Resources/`), sorted. Symbolic links are never followed.
 */
export async function findAppAsars(artifactDir) {
  const found = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && !NOT_SEARCHED.has(entry.name)) await walk(full)
      else if (entry.isFile() && entry.name === 'app.asar') found.push(full)
    }
  }
  await walk(artifactDir)
  return found.sort()
}

/** An archive read whole: its packed files' paths and a reader for one of them as UTF-8 text. */
export async function openAsar(file) {
  const buffer = await readFile(file)
  const parsed = parseAsarHeader(buffer)
  const files = listAsarFiles(parsed.header)
  return {
    files,
    paths: files.filter((entry) => !entry.unpacked).map((entry) => entry.path),
    text: (filePath) => readAsarFile(buffer, parsed, filePath).toString('utf8')
  }
}

/** `file` relative to `artifactDir`, with `/` separators, for a check's detail line. */
export function relativeTo(artifactDir, file) {
  return path.relative(artifactDir, file).split(path.sep).join('/')
}

// Starting a packed app in isolation (P-05; the same isolation P-06 uses): a temp profile holding userData, the home
// folders and the Host's data root, the app's environment pointed into it, and the end of the app and its Host.

/**
 * A temp profile for an app of `platform`: userData, home folders and the Host's data root all inside one folder
 * (`prefix` names it) that removeProfile removes. On a macOS host the data root is a short folder under `/tmp`, since
 * the Host's socket lives under HOME and a path under the per-user temp folder is too long for it; a darwin app checked
 * on another host (a test) keeps it inside the profile, as `/tmp` may not exist there.
 */
export function createAppProfile(prefix, platform, hostPlatform = process.platform) {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}-`))
  const userDataDir = path.join(root, 'userData')
  const dataRoot =
    platform === 'darwin' && hostPlatform === 'darwin'
      ? mkdtempSync(`/tmp/${prefix.slice(-4)}-`)
      : path.join(root, 'data')
  const home = platform === 'darwin' ? dataRoot : path.join(root, 'home')
  for (const dir of [userDataDir, dataRoot, path.join(home, 'AppData', 'Roaming')]) {
    mkdirSync(dir, { recursive: true })
  }
  return { root, userDataDir, dataRoot, home }
}

/**
 * The app's environment: the runner's, with the per-user folders and the Host's data root in the profile
 * (`LOCALAPPDATA` on Windows, `HOME` on macOS, `XDG_DATA_HOME` on Linux: the bases of the copy root, ADR-027 item 2).
 */
export function appEnvironment(profile, platform) {
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

const KILL_WAIT_MS = 10_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The pid in the profile's `host/run/host.identity`, or null while the Host wrote none. */
export function hostPidOf(userDataDir) {
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
export async function endApp(child, userDataDir) {
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
  if (host !== null && isAlive(host)) {
    try {
      process.kill(host)
    } catch {
      // Gone meanwhile.
    }
    while (isAlive(host) && Date.now() < deadline) await sleep(100)
  }
}

/** Removes the profile, retrying while Windows still holds a just-ended tree's files. */
export async function removeProfile(profile) {
  for (const dir of [profile.root, profile.dataRoot]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 20) throw error
        await sleep(250)
      }
    }
  }
}
