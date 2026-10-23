// P-05 (`20` §2.3, §3.2 column "Host runs from"; ADR-027 items 1-2; ADR-002 D5; ISSUE-270): in every packaged
// artifact the Host runs from the DwarfAI-owned versioned copy, never from the install location. For each target the
// check starts the packed app under a temp profile (apps.mjs: `--user-data-dir`, the home folders and the copy root's
// base inside the profile, `--background` so no window opens), waits until the Host wrote `host/run/host.identity`,
// reads the path of the executable that Host process runs, and ends the app and its Host. It then asserts that
// `host/<version>/` exists at the ADR-027 item 2 path under the profile and that the Host's executable is inside it.
// One line per target, joined into the check's detail.
//
// Targets per OS (`20` §3.2):
// - Windows: `win-*unpacked`, the files the Scoop zip holds and the `nsis` installer writes to its install directory.
// - Linux: `linux-*unpacked`; each `.deb`'s payload, extracted with `dpkg-deb -x` (no install, no root); each
//   `.AppImage`, run through its FUSE mount, or with `APPIMAGE_EXTRACT_AND_RUN=1` when the runner has no FUSE (the
//   line says so).
// - macOS: each `.app` of this runner's CPU (`mac-arm64` or `mac`), when it is unsigned or ad-hoc signed.
//
// SP-03 gate (`21` §9; ISSUE-270 "Gates"), a package gap resolved in development (ISSUE-270, 2026-10-23): the SP-03
// record (verdict `partial`) measured the AppImage, the deb and the unsigned `.app` green on hosted runners (the Host
// ran from the copy, packaging lane runs 39134423991 and 39205769685), so those run for real. The signed and notarized
// `.app` is unmeasured (owner step 1): a signed `.app`, or one whose signature cannot be read, is never started and
// never green. P-05 then answers `blocked` (SP-03 and its owner), which the runner prints as `P-05 blocked: …`
// without failing a default run, and fails under `--release` (run.mjs).
//
// It starts the app, so it runs only where the artifact was built (`pnpm test:packaged` on that OS's runner); Linux
// needs a display (xvfb). Its fixtures live in temp folders, which it removes.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { integrityRid, isElevatedRid } from '../../ci/unelevated.mjs'
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
const UNELEVATED_WAIT_MS = 300_000
const LOG_TAIL_LINES = 3
const LOG_LINE_CHARS = 400
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..', '..')
const RUN_UNELEVATED = path.join(REPO_ROOT, 'scripts', 'ci', 'run-unelevated.mjs')
/** The line a standard-user start prints with its result (`--one-target`), read back by the elevated check. */
const TARGET_RESULT = 'P-05-TARGET '
const UNELEVATED_NOTE = 'as a standard user: the Host refuses an elevated start, ADR-002 D6'
/** Who records the signed and notarized `.app` half of SP-03 (its owner step 1). */
const SP03 = { by: 'SP-03', owner: 'the owner (SP-03 owner step 1)' }
/** The `.app` signature states SP-03 measured: ad-hoc (`pnpm package` with no identity writes it) or none. */
const MEASURED_SIGNATURES = new Set(['adhoc', 'unsigned'])

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

/** The app version: `version` of the `package.json` packed in `<resourcesDir>/app.asar`. */
async function versionIn(resourcesDir) {
  const asar = await openAsar(path.join(resourcesDir, 'app.asar'))
  const version = JSON.parse(asar.text('package.json')).version
  if (typeof version !== 'string' || version === '') {
    throw new Error('app.asar package.json has no version')
  }
  return version
}

/** The largest regular file of `dir` whose name `accepts`, or null. */
function largestFile(dir, accepts) {
  let best = null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !accepts(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (best === null || statSync(file).size > statSync(best).size) best = file
  }
  return best
}

/** The Electron binary of a Linux app folder: the largest extension-less file that is not `chrome-sandbox`. */
const linuxBinaryIn = (dir) =>
  largestFile(dir, (name) => !name.includes('.') && !name.startsWith('chrome'))

/** Extracts a deb's payload into `intoDir` without installing it. */
export function extractDebPayload(deb, intoDir) {
  execFileSync('dpkg-deb', ['-x', deb, intoDir], { stdio: 'ignore' })
}

/**
 * The signature state of a `.app`, from `codesign -dv`: `adhoc`, `unsigned`, `signed` (an identity signed it), or
 * `unknown` when it cannot be read.
 */
export function macSignature(bundle) {
  const read = spawnSync('codesign', ['-dv', bundle], { encoding: 'utf8' })
  const text = `${read.stdout ?? ''}${read.stderr ?? ''}`
  if (/Signature=adhoc/.test(text)) return 'adhoc'
  if (/not signed at all/.test(text)) return 'unsigned'
  if (/Authority=/.test(text)) return 'signed'
  return 'unknown'
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

/**
 * What the profile holds after a start that did not reach the Host's identity: the copy root's version folders and
 * their first entries, the Host's `host/run/` folder, and the last lines of each log segment in `<userData>/logs/`.
 */
export function profileEvidence(profile, platform) {
  const names = (dir) => {
    try {
      return readdirSync(dir).sort()
    } catch {
      return null
    }
  }
  const parts = []
  const copyRoot = path.join(profile.dataRoot, ...(COPY_ROOT[platform] ?? COPY_ROOT.linux))
  const versions = names(copyRoot)
  if (versions === null) parts.push('host/: missing')
  else if (versions.length === 0) parts.push('host/: empty')
  for (const version of versions ?? []) {
    const inside = names(path.join(copyRoot, version)) ?? []
    parts.push(`host/${version}/ holds ${inside.slice(0, 6).join(', ') || 'nothing'}`)
  }
  const run = names(path.join(profile.userDataDir, 'host', 'run'))
  parts.push(`host/run/: ${run === null ? 'missing' : run.length === 0 ? 'empty' : run.join(', ')}`)
  const logsDir = path.join(profile.userDataDir, 'logs')
  const segments = names(logsDir)
  if (segments === null || segments.length === 0) parts.push('logs/: no segment')
  for (const segment of segments ?? []) {
    let lines = []
    try {
      lines = readFileSync(path.join(logsDir, segment), 'utf8').trim().split(/\r?\n/)
    } catch {
      // Unreadable: listed with no lines.
    }
    const tail = lines.slice(-LOG_TAIL_LINES).map((line) => line.slice(0, LOG_LINE_CHARS))
    parts.push(`${segment}: ${tail.join(' | ') || '(empty)'}`)
  }
  return parts.join('; ')
}

const spawnApp = ({ command, args, env, platform }) =>
  spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true
  })

/**
 * Starts the packed app under `profile` (with `env` added to its environment), waits for its Host's identity, and
 * answers the path of the executable that Host runs; always ends the app and its Host. A failure names the app's exit
 * code and the tail of its stderr.
 */
export async function runPackagedHost({
  executable,
  profile,
  platform,
  env: extraEnv = {},
  hostWaitMs = HOST_WAIT_MS,
  start = spawnApp,
  executableOf = processExecutable
}) {
  const args = [`--user-data-dir=${profile.userDataDir}`, '--background']
  // The Chromium sandbox helper of an unpacked Linux build is not setuid in a CI checkout.
  if (platform === 'linux') args.push('--no-sandbox')
  const env = { ...appEnvironment(profile, platform), ...extraEnv }
  const child = start({ ...launchCommand({ executable, args, platform, env }), env, platform })
  // Both streams: an AppImage runtime writes its own errors to either, depending on the runtime.
  const output = { stdout: '', stderr: '' }
  for (const stream of ['stdout', 'stderr']) {
    child[stream]?.on('data', (chunk) => {
      output[stream] = (output[stream] + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
  }
  let spawnError = null
  child.once('error', (error) => (spawnError = error))
  const shown = (text) => (text.trim() === '' ? '(empty)' : text.trim())
  const why = (message) =>
    new Error(
      `${message}; exit code ${child.exitCode ?? child.signalCode ?? 'none (still running)'}; ` +
        `stdout: ${shown(output.stdout)}; stderr: ${shown(output.stderr)}; ` +
        `profile: ${profileEvidence(profile, platform)}`
    )
  try {
    const deadline = Date.now() + hostWaitMs
    for (;;) {
      if (spawnError !== null) throw why(`the app could not start: ${spawnError.message}`)
      const pid = hostPidOf(profile.userDataDir)
      if (pid !== null && isAlive(pid)) return { hostExecPath: executableOf(pid, platform) }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw why('the app exited before its Host wrote host.identity')
      }
      if (Date.now() >= deadline) throw why(`no Host identity within ${hostWaitMs} ms`)
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

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * One runnable target: start it (`start` wraps `run`, for the AppImage fallback), then check the copy and where its
 * Host runs. `version` may be a promise, read inside so a failure is this target's line.
 */
async function checkTarget({ label, executable, version, platform, start }) {
  const profile = createAppProfile('dwarfai-p05', platform)
  try {
    const appVersion = await version
    const { hostExecPath, note } = await start({ executable, profile, platform })
    const suffix = note === undefined ? '' : ` (${note})`
    const copyDir = copyDirOf({ platform, dataRoot: profile.dataRoot, version: appVersion })
    if (!existsSync(copyDir)) {
      return { ok: false, line: `${label} FAIL: no host/${appVersion}/ at ${copyDir}${suffix}` }
    }
    if (!isInside(hostExecPath, copyDir, platform)) {
      return {
        ok: false,
        line: `${label} FAIL: the Host runs ${hostExecPath}, not inside host/${appVersion}/ at ${copyDir}${suffix}`
      }
    }
    return {
      ok: true,
      line: `${label} ok${suffix}: host/${appVersion}/ at ${copyDir}, the Host runs ${hostExecPath}`
    }
  } catch (error) {
    return { ok: false, line: `${label} FAIL: ${messageOf(error)}` }
  } finally {
    await removeProfile(profile).catch(() => {})
  }
}

/**
 * Runs an AppImage through its FUSE mount; when that start fails before the Host's identity (no FUSE on the runner,
 * an early exit, a timeout), once more with `APPIMAGE_EXTRACT_AND_RUN=1` under the same profile, the line naming why.
 */
function appImageStart(run) {
  return async (input) => {
    let mounted
    try {
      return await run(input)
    } catch (error) {
      mounted = messageOf(error)
    }
    try {
      const extracted = await run({ ...input, env: { APPIMAGE_EXTRACT_AND_RUN: '1' } })
      return {
        ...extracted,
        note: `extract-and-run, after the mounted start failed: ${mounted.slice(0, 600)}`
      }
    } catch (error) {
      throw new Error(`mounted start: ${mounted}; extract-and-run start: ${messageOf(error)}`)
    }
  }
}

/**
 * Whether this process runs elevated (high integrity or above), read from System32's `whoami.exe` by its path: a
 * `whoami` found on PATH may be another tool's (Git for Windows ships one that has no `/groups`). A level that cannot
 * be read counts as not elevated here, so a start is never rerouted on a guess; an elevated Host start then fails with
 * the refusal in its log lines.
 */
export function isElevatedProcess() {
  const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
  try {
    const csv = execFileSync(whoami, ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000
    })
    const rid = integrityRid(csv)
    return rid !== null && isElevatedRid(rid)
  } catch {
    return false
  }
}

/**
 * Runs one target as a standard local user through scripts/ci/run-unelevated.mjs (ISSUE-051), which reruns this
 * file with `--one-target`; answers its exit code and merged output.
 */
export function runUnelevatedTarget({ label, executable }) {
  const command = [
    'node',
    `"${SELF}"`,
    '--one-target',
    `"${path.resolve(executable)}"`,
    '--label',
    label
  ]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_UNELEVATED, '--', ...command], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    const collect = (chunk) => (output = (output + chunk.toString('utf8')).slice(-20_000))
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill(), UNELEVATED_WAIT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${error.message}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** A target's check through a standard-user start: its printed result, with the line saying how it ran. */
function unelevatedCheck(runUnelevated) {
  return async ({ label, executable }) => {
    const { code, output } = await runUnelevated({ label, executable })
    const lines = output.split(/\r?\n/).filter((line) => line.startsWith(TARGET_RESULT))
    let result = null
    try {
      result = lines.length === 0 ? null : JSON.parse(lines.at(-1).slice(TARGET_RESULT.length))
    } catch {
      result = null
    }
    if (typeof result?.ok !== 'boolean' || typeof result?.line !== 'string') {
      return {
        ok: false,
        line:
          `${label} FAIL: the standard-user start gave no result (exit code ${code ?? 'none'}): ` +
          output.trim().slice(-1_500)
      }
    }
    return {
      ok: result.ok,
      line: result.line.replace(/^(\S+ (?:ok|FAIL))/, `$1 (${UNELEVATED_NOTE})`)
    }
  }
}

async function windowsTargets({ artifactDir, arch, run, isElevated, inCi, runUnelevated }) {
  const executable = await findExecutable({ artifactDir, platform: 'win32', arch })
  if (executable === null) return { targets: [], blocked: [] }
  const label = relativeTo(artifactDir, path.dirname(executable))
  const version = versionIn(path.join(path.dirname(executable), 'resources'))
  version.catch(() => {})
  // The hosted Windows runner runs every step elevated, and the Host refuses an elevated start (ADR-002 D6). In CI
  // the target runs as the standard CI user (run-unelevated.mjs creates it); elsewhere nothing creates a user, and the
  // target fails naming the elevation.
  let checkWith
  if (await isElevated()) {
    checkWith = inCi
      ? unelevatedCheck(runUnelevated)
      : async () => ({
          ok: false,
          line:
            `${label} FAIL: this check runs elevated and the Host refuses an elevated start (ADR-002 D6); ` +
            'run it from a standard user'
        })
  }
  return { targets: [{ label, executable, version, start: run, checkWith }], blocked: [] }
}

async function linuxTargets({ artifactDir, arch, run, extractDeb, scratch }) {
  const targets = []
  const executable = await findExecutable({ artifactDir, platform: 'linux', arch })
  const unpackedVersion =
    executable === null ? null : versionIn(path.join(path.dirname(executable), 'resources'))
  unpackedVersion?.catch(() => {})
  if (executable !== null) {
    const label = relativeTo(artifactDir, path.dirname(executable))
    targets.push({ label, executable, version: unpackedVersion, start: run })
  }
  const files = readdirSync(artifactDir, { withFileTypes: true }).filter((entry) => entry.isFile())
  for (const deb of files.filter((entry) => entry.name.endsWith('.deb'))) {
    const intoDir = path.join(scratch(), 'deb')
    try {
      await extractDeb(path.join(artifactDir, deb.name), intoDir)
    } catch (error) {
      const failed = Promise.reject(new Error(`dpkg-deb -x failed: ${messageOf(error)}`))
      targets.push({ label: deb.name, executable: '', version: failed, start: run })
      continue
    }
    const optDir = path.join(intoDir, 'opt')
    const appDir = existsSync(optDir)
      ? readdirSync(optDir)
          .map((name) => path.join(optDir, name))
          .find((dir) => existsSync(path.join(dir, 'resources', 'app.asar')))
      : undefined
    const binary = appDir === undefined ? null : linuxBinaryIn(appDir)
    targets.push({
      label: deb.name,
      executable: binary,
      version:
        binary === null
          ? Promise.reject(new Error('no app under opt/ in the deb payload'))
          : versionIn(path.join(appDir, 'resources')),
      start: run
    })
  }
  for (const appImage of files.filter((entry) => entry.name.endsWith('.AppImage'))) {
    targets.push({
      label: appImage.name,
      executable: path.join(artifactDir, appImage.name),
      // The AppImage packs the same build as the unpacked folder beside it.
      version:
        unpackedVersion ??
        Promise.reject(new Error('no linux-unpacked app to read the version from')),
      start: appImageStart(run)
    })
  }
  for (const target of targets) target.version.catch(() => {})
  return { targets, blocked: [] }
}

async function macTargets({ artifactDir, arch, run, signatureOf }) {
  const targets = []
  const blocked = []
  const ownFolder = arch === 'arm64' ? 'mac-arm64' : 'mac'
  for (const folder of readdirSync(artifactDir, { withFileTypes: true })) {
    if (!folder.isDirectory() || !/^mac(?:-[\w]+)?$/.test(folder.name)) continue
    const dir = path.join(artifactDir, folder.name)
    for (const bundle of readdirSync(dir, { withFileTypes: true })) {
      if (!bundle.isDirectory() || !bundle.name.endsWith('.app')) continue
      const bundleDir = path.join(dir, bundle.name)
      const label = `${folder.name}/${bundle.name}`
      if (!MEASURED_SIGNATURES.has(await signatureOf(bundleDir))) {
        blocked.push(`${label} — SP-03 (signed/notarized .app) not recorded`)
        continue
      }
      // A bundle for the other CPU cannot start on this runner; its own runner checks it.
      if (folder.name !== ownFolder) continue
      const executable = largestFile(path.join(bundleDir, 'Contents', 'MacOS'), () => true)
      if (executable === null) continue
      const version = versionIn(path.join(bundleDir, 'Contents', 'Resources'))
      version.catch(() => {})
      targets.push({ label, executable, version, start: run })
    }
  }
  return { targets, blocked }
}

export default async function check({
  artifactDir,
  run = runPackagedHost,
  platform = process.platform,
  arch = process.arch,
  extractDeb = extractDebPayload,
  signatureOf = macSignature,
  isElevated = isElevatedProcess,
  inCi = process.env.CI === 'true',
  runUnelevated = runUnelevatedTarget
}) {
  const scratchDirs = []
  const scratch = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-p05-deb-'))
    scratchDirs.push(dir)
    return dir
  }
  try {
    const { targets, blocked } =
      platform === 'win32'
        ? await windowsTargets({ artifactDir, arch, run, isElevated, inCi, runUnelevated })
        : platform === 'darwin'
          ? await macTargets({ artifactDir, arch, run, signatureOf })
          : await linuxTargets({ artifactDir, arch, run, extractDeb, scratch })
    if (targets.length === 0 && blocked.length === 0) {
      return { ok: false, detail: `no packed app for ${platform}-${arch} in ${artifactDir}` }
    }
    const results = []
    for (const target of targets) {
      if (target.executable === null) {
        results.push({ ok: false, line: `${target.label} FAIL: no app executable` })
      } else {
        results.push(await (target.checkWith ?? checkTarget)({ ...target, platform }))
      }
    }
    const failed = results.some((result) => !result.ok)
    const detail = [...blocked, ...results.map((result) => result.line)].join('; ')
    if (!failed && blocked.length > 0) return { ok: false, blocked: SP03, detail }
    return { ok: !failed, detail }
  } finally {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `--one-target <executable> --label <label>`: checks that one Windows target in this process and prints its result as
 * one `P-05-TARGET <json>` line; the elevated check runs it as a standard user (runUnelevatedTarget).
 */
async function oneTarget(argv) {
  const at = (flag) => argv[argv.indexOf(flag) + 1]
  const executable = at('--one-target')
  const version = versionIn(path.join(path.dirname(executable), 'resources'))
  version.catch(() => {})
  const result = await checkTarget({
    label: at('--label'),
    executable,
    version,
    platform: process.platform,
    start: runPackagedHost
  })
  console.log(`${TARGET_RESULT}${JSON.stringify(result)}`)
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === SELF &&
  process.argv.includes('--one-target')
) {
  await oneTarget(process.argv.slice(2))
}
