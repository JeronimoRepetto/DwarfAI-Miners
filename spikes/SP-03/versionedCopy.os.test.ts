import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spike SP-03 (alias S-027-2), L8 per OS over packaged layouts (testing strategy `17` §4; ADR-002 D5; ADR-027
 * item 2; spike register SP-03).
 *
 * Question: what do the size and the time of the Host's versioned copy come to on each packaged layout, and does the
 * copy still start the Host and keep the bundle's signature state (the macOS `.app` signature and Gatekeeper
 * assessment; the AppImage runtime copied out of its FUSE mount)?
 *
 * The harness runs the ADR-002 D5 copy as written: the unpacked application directory (the one holding the executable
 * and its `resources`) is copied to `host/<version>.tmp-<pid>`, checked against a manifest (file list + SHA-256), and
 * renamed atomically to `host/<version>`; a verified copy is reused. It then starts the copied executable under
 * `ELECTRON_RUN_AS_NODE=1` (how the Host runs, ADR-002 D1) and compares the signature state before and after.
 *
 * Layouts:
 * - always: the Electron runtime the repository installs (`node_modules/electron/dist`, `Electron.app` on macOS), the
 *   same files electron-builder packs around the app;
 * - `SP03_LAYOUTS=<label>=<dir>[;<label>=<dir>…]`: packaged layouts of the real app (a `win-unpacked` directory from
 *   a throw-away `electron-builder --dir` build, an installed `nsis` directory, an extracted Scoop zip, a signed and
 *   notarized `.app`);
 * - `SP03_APPIMAGE=<file>` (Linux): an AppImage, mounted with `--appimage-mount`; the runtime is copied out of the
 *   mount and started after the mount is gone.
 *
 * Production code is ISSUE-031's (the versioned copy); this is the spike and, afterwards, the seed of the ADR-027
 * copy-atomic and GC tests. Set `SP03_REPORT=<file>` to write the measurements as JSON (the record's raw output).
 */

interface Layout {
  readonly label: string
  /** The directory copied: the unpacked app directory, or the `.app` bundle on macOS. */
  readonly dir: string
  /** Called after the copy, before the copied Host starts (the AppImage case unmounts here). */
  readonly afterCopy?: () => Promise<void>
}

interface ManifestEntry {
  readonly path: string
  readonly kind: 'file' | 'symlink'
  readonly size: number
  readonly sha256: string
}

interface CopyResult {
  readonly reused: boolean
  readonly finalDir: string
  readonly files: number
  readonly bytes: number
  readonly copyMs: number
  readonly verifyMs: number
  readonly renameMs: number
}

interface Measurement {
  readonly layout: string
  readonly files: number
  readonly bytes: number
  /** Hashing the source: build-time work in production (`host-manifest.json` ships with the app). */
  readonly manifestMs: number
  readonly copyMs: number
  readonly verifyMs: number
  readonly renameMs: number
  /** A second start of the same version: the verified copy is found and reused. */
  readonly reuseMs: number
  readonly reused: boolean
  readonly signatureBefore: string
  readonly signatureAfter: string
  readonly hostStarted: boolean
  readonly hostExecPathInsideCopy: boolean
  readonly hostElectron: string | null
  readonly appAsarName: string | null
  readonly startMs: number
  /** How "runs from the copy" was decided: the paths the Host reported and the harness compared. */
  readonly diagnostics: {
    readonly hostExecPath: string | null
    readonly copiedPath: string
    readonly workDirIsLink: boolean
  }
  readonly note: string | null
}

const VERSION = '0.0.0-sp03'

function hashFile(file: string): string {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1 << 20)
  const fd = openSync(file, 'r')
  try {
    let read = 0
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** The manifest of a directory tree: every file and symlink, relative path, size and SHA-256 (links: of the target). */
function manifestOf(root: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full)
        entries.push({
          path: relative,
          kind: 'symlink',
          size: 0,
          sha256: createHash('sha256').update(target).digest('hex')
        })
      } else if (stat.isDirectory()) {
        walk(full)
      } else {
        entries.push({ path: relative, kind: 'file', size: stat.size, sha256: hashFile(full) })
      }
    }
  }
  walk(root)
  return entries
}

function sameManifest(
  expected: readonly ManifestEntry[],
  actual: readonly ManifestEntry[]
): boolean {
  if (expected.length !== actual.length) return false
  return expected.every((entry, index) => {
    const other = actual[index]
    return (
      other !== undefined &&
      other.path === entry.path &&
      other.kind === entry.kind &&
      other.sha256 === entry.sha256
    )
  })
}

/**
 * ADR-002 D5 as written: reuse a verified `host/<version>`, otherwise copy to `host/<version>.tmp-<pid>`, verify
 * against the manifest and rename atomically. A copy that fails the check is removed and never renamed.
 */
function materializeCopy(
  source: string,
  hostRoot: string,
  manifest: readonly ManifestEntry[]
): CopyResult {
  const bundle = path.basename(source)
  const finalDir = path.join(hostRoot, VERSION)
  const bytes = manifest.reduce((sum, entry) => sum + entry.size, 0)
  if (existsSync(finalDir)) {
    const started = performance.now()
    const ok = sameManifest(manifest, manifestOf(path.join(finalDir, bundle)))
    const verifyMs = performance.now() - started
    if (ok) {
      return {
        reused: true,
        finalDir,
        files: manifest.length,
        bytes,
        copyMs: 0,
        verifyMs,
        renameMs: 0
      }
    }
    rmSync(finalDir, { recursive: true, force: true })
  }
  const tempDir = path.join(hostRoot, `${VERSION}.tmp-${process.pid}`)
  mkdirSync(tempDir, { recursive: true })
  let started = performance.now()
  cpSync(source, path.join(tempDir, bundle), {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true
  })
  const copyMs = performance.now() - started
  started = performance.now()
  const ok = sameManifest(manifest, manifestOf(path.join(tempDir, bundle)))
  const verifyMs = performance.now() - started
  if (!ok) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new Error('the copy does not match the manifest; it was removed and not renamed')
  }
  started = performance.now()
  renameSync(tempDir, finalDir)
  const renameMs = performance.now() - started
  return { reused: false, finalDir, files: manifest.length, bytes, copyMs, verifyMs, renameMs }
}

/** Whether a file starts with the ELF magic number. */
function isElf(file: string): boolean {
  const head = Buffer.alloc(4)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, head, 0, 4, 0)
  } finally {
    closeSync(fd)
  }
  return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
}

/** The executable of a layout: the root `.exe` (Windows), `Contents/MacOS/<name>` (macOS), the root ELF (Linux). */
function executableOf(dir: string): string {
  if (process.platform === 'darwin') {
    const macos = path.join(dir, 'Contents', 'MacOS')
    const name = readdirSync(macos).find((file) => statSync(path.join(macos, file)).isFile())
    if (!name) throw new Error('no executable in Contents/MacOS')
    return path.join(macos, name)
  }
  const helpers = new Set(['chrome-sandbox', 'chrome_crashpad_handler', 'elevate.exe'])
  const candidates = readdirSync(dir).filter((name) => {
    const full = path.join(dir, name)
    if (helpers.has(name) || !statSync(full).isFile()) return false
    if (process.platform === 'win32') return name.endsWith('.exe') && !/^uninstall/i.test(name)
    // An executable ELF that is not a shared library: zip extraction may mark data files executable too.
    return (statSync(full).mode & 0o111) !== 0 && !/\.so(\.|$)/.test(name) && isElf(full)
  })
  if (candidates.length !== 1) {
    throw new Error(`expected one executable in the layout root, found ${candidates.length}`)
  }
  return path.join(dir, candidates[0] as string)
}

/**
 * The environment for a Windows PowerShell 5.1 child: the parent's, without `PSModulePath`. A parent started from
 * PowerShell 7 (`pwsh`, the GitHub Actions default shell on Windows) passes its own module path down, and 5.1 then
 * fails to autoload its own modules (`CouldNotAutoloadMatchingModule`, observed on windows-latest). Without the
 * variable, 5.1 builds its default module path.
 */
export function windowsPowerShellEnv(
  env: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')
  return { ...Object.fromEntries(kept), ...extra }
}

/**
 * Whether the executable a Host reports runs from inside the copy. Both sides are resolved to their real paths
 * first: on macOS the temp directory `/var/folders/…` is a symlink to `/private/var/folders/…`, and the kernel
 * reports `process.execPath` resolved.
 */
export function runsFromCopy(execPath: string, copied: string): boolean {
  const real = (file: string): string => {
    try {
      return realpathSync.native(file)
    } catch {
      return path.resolve(file)
    }
  }
  const exe = real(execPath).toLowerCase()
  const root = real(copied).toLowerCase()
  return exe === root || exe.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/** Paths under the harness temp dir, written relative to it for the report (privacy guard). */
function reportPath(file: string, base: string): string {
  const real = (value: string): string => {
    try {
      return realpathSync.native(value)
    } catch {
      return value
    }
  }
  for (const root of [base, real(base)]) {
    if (file.toLowerCase().startsWith(root.toLowerCase())) return `<work>${file.slice(root.length)}`
  }
  return '<outside the work dir>'
}

/** The bundle's signature state, as the OS reports it; compared before and after the copy. */
function signatureState(dir: string): string {
  if (process.platform === 'win32') {
    const powershell = path.join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    let out: string
    try {
      out = execFileSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::Out.Write((Get-AuthenticodeSignature -LiteralPath $env:SP03_TARGET).Status.ToString())'
        ],
        {
          encoding: 'utf8',
          env: windowsPowerShellEnv(process.env, { SP03_TARGET: executableOf(dir) }),
          windowsHide: true
        }
      )
    } catch (error) {
      // A named result instead of aborting the measurement; the case then fails on it with this reason.
      const text = error instanceof Error ? error.message : String(error)
      // The first line names the command; the PowerShell error follows it.
      const line =
        text.split(/\r?\n/).find((part) => /Get-|could not|not recognized/i.test(part)) ?? text
      return `authenticode:unreadable(${line.slice(0, 160)})`
    }
    return `authenticode:${out.trim()}`
  }
  if (process.platform === 'darwin') {
    const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', dir], {
      encoding: 'utf8'
    })
    const spctl = spawnSync('spctl', ['--assess', '--type', 'execute', dir], { encoding: 'utf8' })
    const firstLine = (text: string): string =>
      text.trim().split(/\r?\n/)[0]?.replace(dir, '<app>') ?? ''
    const codesignState = codesign.status === 0 ? 'valid' : `invalid(${firstLine(codesign.stderr)})`
    const spctlState = spctl.status === 0 ? 'accepted' : `rejected(${firstLine(spctl.stderr)})`
    return `codesign:${codesignState} gatekeeper:${spctlState}`
  }
  const mode = statSync(executableOf(dir)).mode & 0o777
  return `no-os-signature executable-mode:${mode.toString(8)}`
}

const PROBE = `
const path = require('node:path')
const fs = require('node:fs')
let appAsarName = null
try {
  appAsarName = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'app.asar', 'package.json'), 'utf8')).name
} catch {}
process.stdout.write(JSON.stringify({
  execPath: process.execPath,
  electron: process.versions.electron ?? null,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
  appAsarName
}) + '\\n')
`

interface HostProbe {
  execPath: string
  electron: string | null
  runAsNode: boolean
  appAsarName: string | null
}

function startHost(exe: string, probeScript: string): { probe: HostProbe | null; ms: number } {
  const started = performance.now()
  const result = spawnSync(exe, [probeScript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true
  })
  const ms = performance.now() - started
  try {
    return { probe: JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? '') as HostProbe, ms }
  } catch {
    return { probe: null, ms }
  }
}

/** The Electron runtime the repository installs, as a layout. */
function electronDistLayout(): Layout {
  const electronExe = createRequire(import.meta.url)('electron') as unknown as string
  const dir =
    process.platform === 'darwin'
      ? path.resolve(electronExe, '..', '..', '..')
      : path.dirname(electronExe)
  return { label: `electron-dist-${process.platform}`, dir }
}

function envLayouts(): Layout[] {
  const spec = process.env['SP03_LAYOUTS']
  if (!spec) return []
  return spec
    .split(';')
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf('=')
      return { label: pair.slice(0, index), dir: pair.slice(index + 1) }
    })
}

/** Linux: an AppImage mounted with `--appimage-mount`; `afterCopy` ends the mount before the copy starts. */
async function appImageLayout(file: string): Promise<Layout> {
  const mounter = spawn(file, ['--appimage-mount'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const mountDir = await new Promise<string>((resolve, reject) => {
    mounter.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()))
    mounter.once('exit', (code) => reject(new Error(`--appimage-mount exited with ${code}`)))
  })
  return {
    label: 'appimage-mount',
    dir: mountDir,
    afterCopy: async () => {
      const exited = new Promise((resolve) => mounter.once('exit', resolve))
      mounter.kill('SIGTERM')
      await exited
      expect(existsSync(path.join(mountDir, 'resources')), 'the AppImage mount is gone').toBe(false)
    }
  }
}

const measurements: Measurement[] = []
let workDir = ''
let probeScript = ''

describe('SP-03: the Host versioned copy per packaged layout (ADR-002 D5, ADR-027 item 2)', () => {
  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp03-'))
    probeScript = path.join(workDir, 'host-probe.cjs')
    writeFileSync(probeScript, PROBE)
  })

  afterAll(async () => {
    const reportFile = process.env['SP03_REPORT']
    if (reportFile) writeFileSync(reportFile, `${JSON.stringify(measurements, null, 2)}\n`)
    for (let attempt = 0; attempt < 10 && workDir; attempt += 1) {
      try {
        rmSync(workDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  })

  it("[SP-03, ADR-027] the versioned copy of each packaged layout starts the Host and keeps the bundle's signature state", async () => {
    const layouts = [electronDistLayout(), ...envLayouts()]
    const appImage = process.env['SP03_APPIMAGE']
    if (process.platform === 'linux' && appImage) layouts.push(await appImageLayout(appImage))
    for (const layout of layouts) {
      const hostRoot = path.join(workDir, layout.label, 'host')
      const signatureBefore = signatureState(layout.dir)
      let started = performance.now()
      const manifest = manifestOf(layout.dir)
      const manifestMs = performance.now() - started
      const copy = materializeCopy(layout.dir, hostRoot, manifest)
      await layout.afterCopy?.()
      const copied = path.join(copy.finalDir, path.basename(layout.dir))
      expect(existsSync(copied), `${layout.label}: the copy is in place at host/<version>`).toBe(
        true
      )
      started = performance.now()
      const again = materializeCopy(layout.dir, hostRoot, manifest)
      const reuseMs = performance.now() - started
      const signatureAfter = signatureState(copied)
      const host = startHost(executableOf(copied), probeScript)
      const insideCopy = host.probe !== null && runsFromCopy(host.probe.execPath, copied)
      measurements.push({
        layout: layout.label,
        files: copy.files,
        bytes: copy.bytes,
        manifestMs: Math.round(manifestMs),
        copyMs: Math.round(copy.copyMs),
        verifyMs: Math.round(copy.verifyMs),
        renameMs: Math.round(copy.renameMs),
        reuseMs: Math.round(reuseMs),
        reused: again.reused,
        signatureBefore,
        signatureAfter,
        hostStarted: host.probe?.runAsNode === true,
        hostExecPathInsideCopy: insideCopy,
        hostElectron: host.probe?.electron ?? null,
        appAsarName: host.probe?.appAsarName ?? null,
        startMs: Math.round(host.ms),
        diagnostics: {
          hostExecPath: host.probe ? reportPath(host.probe.execPath, workDir) : null,
          copiedPath: reportPath(copied, workDir),
          workDirIsLink: realpathSync.native(workDir) !== workDir
        },
        note: null
      })
      expect(copy.reused, `${layout.label}: the first start copies`).toBe(false)
      expect(
        existsSync(`${copy.finalDir}.tmp-${process.pid}`),
        `${layout.label}: no temp dir left`
      ).toBe(false)
      expect(again.reused, `${layout.label}: a verified copy is reused`).toBe(true)
      expect(
        host.probe?.runAsNode,
        `${layout.label}: the copied Host starts under ELECTRON_RUN_AS_NODE`
      ).toBe(true)
      expect(insideCopy, `${layout.label}: the Host runs from the copy, not the source`).toBe(true)
      expect(signatureBefore, `${layout.label}: the signature state is readable`).not.toMatch(
        /unreadable/
      )
      expect(signatureAfter, `${layout.label}: the signature state is kept`).toBe(signatureBefore)
    }
  }, 600000)

  it('[SP-03] copy size and time are recorded per layout', () => {
    expect(
      measurements.length,
      'at least the Electron runtime layout was measured'
    ).toBeGreaterThan(0)
    for (const measurement of measurements) {
      expect(measurement.files, `${measurement.layout}: files`).toBeGreaterThan(0)
      expect(measurement.bytes, `${measurement.layout}: bytes`).toBeGreaterThan(0)
      for (const key of [
        'manifestMs',
        'copyMs',
        'verifyMs',
        'renameMs',
        'reuseMs',
        'startMs'
      ] as const) {
        expect(Number.isFinite(measurement[key]), `${measurement.layout}: ${key}`).toBe(true)
      }
    }
  })

  it('[SP-03] Windows PowerShell 5.1 is started without an inherited PSModulePath', () => {
    const env = windowsPowerShellEnv(
      { PATH: 'x', PSModulePath: 'C:/pwsh/7/Modules', psmodulepath: 'y' },
      { SP03_TARGET: 't' }
    )
    expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain('PSMODULEPATH')
    expect(env['PATH']).toBe('x')
    expect(env['SP03_TARGET']).toBe('t')
  })

  it('[SP-03] the Host counts as running from the copy when the copy is reached through a directory link', () => {
    // The macOS case (/var → /private/var) reproduced with a directory link: the Host reports the resolved path.
    const real = path.join(workDir, 'link-case', 'real', 'host')
    mkdirSync(real, { recursive: true })
    writeFileSync(path.join(real, 'electron'), '')
    const link = path.join(workDir, 'link-case', 'link')
    symlinkSync(path.join(workDir, 'link-case', 'real'), link, 'junction')
    const copiedThroughLink = path.join(link, 'host')
    expect(runsFromCopy(path.join(real, 'electron'), copiedThroughLink)).toBe(true)
    expect(runsFromCopy(path.join(workDir, 'elsewhere', 'electron'), copiedThroughLink)).toBe(false)
  })

  it('[SP-03, ADR-002] a copy that fails its manifest check is removed and never renamed into place', () => {
    const source = path.join(workDir, 'tamper-source', 'app')
    mkdirSync(path.join(source, 'resources'), { recursive: true })
    writeFileSync(path.join(source, 'resources', 'a.txt'), 'original')
    const manifest = manifestOf(source)
    writeFileSync(path.join(source, 'resources', 'a.txt'), 'changed after the manifest was built')
    const hostRoot = path.join(workDir, 'tamper-source', 'host')
    expect(() => materializeCopy(source, hostRoot, manifest)).toThrow(/does not match the manifest/)
    expect(existsSync(path.join(hostRoot, VERSION)), 'nothing renamed into place').toBe(false)
    expect(
      existsSync(path.join(hostRoot, `${VERSION}.tmp-${process.pid}`)),
      'temp copy removed'
    ).toBe(false)
  })
})
