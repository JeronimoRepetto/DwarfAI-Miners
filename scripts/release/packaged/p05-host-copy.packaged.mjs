// P-05 (`20` §2.3, §3.2 column "Host runs from"; ADR-027 items 1-2; ADR-002 D5; ISSUE-270): in every packaged artifact
// the Host runs from the DwarfAI-owned versioned copy, never from the install location. The check starts the packed app
// of this OS from the artifact folder under a temp profile (apps.mjs: `--user-data-dir`, the home folders and the
// copy root's base inside the profile, `--background` so no window opens), waits until the Host wrote
// `host/run/host.identity`, reads the path of the executable that Host process runs, and ends the app and its Host.
// It then asserts that `host/<version>/` exists at the ADR-027 item 2 path under the profile and that the Host's
// executable is inside it. One line per target, joined into the check's detail.
//
// Targets per OS (`20` §3.2):
// - Windows: `win-*unpacked`, the files the Scoop zip holds and the `nsis` installer writes to its install directory.
// - Linux: `linux-*unpacked`, the files the deb installs under `/opt`; the AppImage is blocked by SP-03.
// - macOS: the `.app` is blocked by SP-03.
// SP-03 gates the AppImage and the `.app` (`21` §9; ISSUE-270 "Gates"): its record's verdict is `partial` (the signed
// and notarized `.app` is unmeasured), so until it is `passed` those targets print "blocked by SP-03" and P-05 fails on
// the runner that built them: never green, and the release checklist cannot pass. The copy itself is the launcher's,
// for every layout.
//
// It starts the app, so it runs only where the artifact was built (`pnpm test:packaged` on that OS's runner); Linux
// needs a display (xvfb). Its fixtures live in the temp profile, which it removes.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  appEnvironment,
  createAppProfile,
  endApp,
  hostPidOf,
  isAlive,
  openAsar,
  relativeTo,
  removeProfile
} from './apps.mjs'
import { findExecutable, launchCommand } from './p06-log-location.packaged.mjs'

export const id = 'P-05'

const HOST_WAIT_MS = 90_000
const STDERR_TAIL_CHARS = 2_000
const BLOCKED =
  'blocked by SP-03 (record verdict partial: the signed and notarized .app is unmeasured)'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The copy root's segments under its per-OS base (ADR-027 item 2; `versionedCopyRoot` of a release build). */
const COPY_ROOT = {
  win32: ['DwarfAI', 'host'],
  darwin: ['Library', 'Application Support', 'DwarfAI', 'host'],
  linux: ['dwarfai', 'host']
}

/**
 * `host/<version>/` under `dataRoot`, the base the profile gives the app (`LOCALAPPDATA` on Windows, `HOME` on macOS,
 * `XDG_DATA_HOME` on Linux), joined with this OS's separators: the check runs on the OS that built the artifact.
 */
export function copyDirOf({ platform, dataRoot, version }) {
  return path.join(dataRoot, ...(COPY_ROOT[platform] ?? COPY_ROOT.linux), version)
}

/** The targets of `artifactDir` that SP-03 blocks on this OS: the AppImage files on Linux, the `.app` bundles on macOS. */
function blockedTargets(artifactDir, platform) {
  const names = readdirSync(artifactDir, { withFileTypes: true })
  if (platform === 'linux') {
    return names
      .filter((entry) => entry.isFile() && entry.name.endsWith('.AppImage'))
      .map((e) => e.name)
  }
  if (platform !== 'darwin') return []
  const bundles = []
  for (const folder of names) {
    if (!folder.isDirectory() || !/^mac(?:-[\w]+)?$/.test(folder.name)) continue
    for (const bundle of readdirSync(path.join(artifactDir, folder.name), {
      withFileTypes: true
    })) {
      if (bundle.isDirectory() && bundle.name.endsWith('.app'))
        bundles.push(`${folder.name}/${bundle.name}`)
    }
  }
  return bundles
}

/** The app version: `version` of the `package.json` packed in `resources/app.asar` beside the executable. */
async function versionOf(executable) {
  const asar = await openAsar(path.join(path.dirname(executable), 'resources', 'app.asar'))
  const version = JSON.parse(asar.text('package.json')).version
  if (typeof version !== 'string' || version === '')
    throw new Error('app.asar package.json has no version')
  return version
}

/** The path of the executable process `pid` runs, read from the OS. */
export function processExecutable(pid, platform) {
  if (platform === 'linux') return readlinkSync(`/proc/${pid}/exe`)
  if (platform === 'darwin') {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  }
  // Windows PowerShell 5.1 by its System32 path, without a PowerShell 7 module path (SP-03 "Windows signature read").
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key]
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  return execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`
    ],
    { encoding: 'utf8', env, windowsHide: true, timeout: 30_000 }
  ).trim()
}

const spawnApp = ({ command, args, env, platform }) =>
  spawn(command, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true
  })

/**
 * Starts the packed app under `profile`, waits for its Host's identity, and answers the path of the executable that
 * Host runs; always ends the app and its Host. A failure names the app's exit code and the tail of its stderr.
 */
export async function runPackagedHost({
  executable,
  profile,
  platform,
  start = spawnApp,
  executableOf = processExecutable
}) {
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
  const why = (message) =>
    new Error(
      `${message}; exit code ${child.exitCode ?? child.signalCode ?? 'none (still running)'}; stderr: ` +
        (stderr.trim() === '' ? '(empty)' : stderr.trim())
    )
  try {
    const deadline = Date.now() + HOST_WAIT_MS
    for (;;) {
      if (spawnError !== null) throw why(`the app could not start: ${spawnError.message}`)
      const pid = hostPidOf(profile.userDataDir)
      if (pid !== null && isAlive(pid)) return { hostExecPath: executableOf(pid, platform) }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw why('the app exited before its Host wrote host.identity')
      }
      if (Date.now() >= deadline) throw why(`no Host identity within ${HOST_WAIT_MS} ms`)
      await sleep(250)
    }
  } finally {
    await endApp(child, profile.userDataDir)
  }
}

/** Whether `file` is inside `folder`, compared by real paths (macOS `/var` is a link) and case-folded on Windows. */
function isInside(file, folder, platform) {
  const real = (target) => {
    try {
      return realpathSync.native(target)
    } catch {
      return path.resolve(target)
    }
  }
  const fold = (target) => (platform === 'win32' ? target.toLowerCase() : target)
  const relative = path.relative(fold(real(folder)), fold(real(file)))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** One runnable target: start it, then check the copy and where its Host runs. */
async function checkTarget({ artifactDir, executable, platform, run }) {
  const target = relativeTo(artifactDir, path.dirname(executable))
  const profile = createAppProfile('dwarfai-p05', platform)
  try {
    const version = await versionOf(executable)
    const { hostExecPath } = await run({ executable, profile, platform })
    const copyDir = copyDirOf({ platform, dataRoot: profile.dataRoot, version })
    if (!existsSync(copyDir)) {
      return { ok: false, line: `${target} FAIL: no host/${version}/ at ${copyDir}` }
    }
    if (!isInside(hostExecPath, copyDir, platform)) {
      return {
        ok: false,
        line: `${target} FAIL: the Host runs ${hostExecPath}, not inside host/${version}/ at ${copyDir}`
      }
    }
    return {
      ok: true,
      line: `${target} ok: host/${version}/ at ${copyDir}, the Host runs ${hostExecPath}`
    }
  } catch (error) {
    return {
      ok: false,
      line: `${target} FAIL: ${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    await removeProfile(profile).catch(() => {})
  }
}

export default async function check({
  artifactDir,
  run = runPackagedHost,
  platform = process.platform,
  arch = process.arch
}) {
  const blocked = blockedTargets(artifactDir, platform)
  // On macOS the only target is the blocked .app: it is never started, so no run is reported as its result.
  const executable =
    platform === 'darwin' ? null : await findExecutable({ artifactDir, platform, arch })
  if (executable === null && blocked.length === 0) {
    return { ok: false, detail: `no packed app for ${platform}-${arch} in ${artifactDir}` }
  }
  const results =
    executable === null ? [] : [await checkTarget({ artifactDir, executable, platform, run })]
  const lines = [
    ...results.map((result) => result.line),
    ...blocked.map((target) => `${target} ${BLOCKED}`)
  ]
  return {
    ok: blocked.length === 0 && results.length > 0 && results.every((result) => result.ok),
    detail: lines.join('; ')
  }
}
