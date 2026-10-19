import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { homedir, release, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  detectVolumeCase,
  type Detection,
  type FileIdentity,
  type VolumeCase
} from './caseFolding.ts'

/**
 * Spike S-030-1, L8 on each OS (testing strategy `17` §4; ADR-030 item 1; spike register S-030-1).
 *
 * Question: how does the Host tell, cheaply, whether a folder's file system compares names without case, so that mine
 * identity folds case only where the file system does?
 *
 * The harness builds, without asking anyone for anything, one folder whose file system folds case and one whose file
 * system does not, and runs the candidate method of `caseFolding.ts` on each:
 * - Windows (the control): an NTFS temp folder (folds), and an NTFS temp folder with the per-directory case-sensitive
 *   flag set by `fsutil.exe file setCaseSensitiveInfo` (does not fold; no elevation needed);
 * - macOS: two temporary disk images attached with `hdiutil` (no elevation): `APFS` (folds) and
 *   `Case-sensitive APFS` (does not);
 * - Linux: one temporary ext4 image created with the `casefold` feature and loop-mounted through `sudo -n` (the CI
 *   runner's passwordless sudo; `-n` never prompts, so a machine without it fails fast with a clear message): a
 *   folder with the `+F` attribute (folds) and a plain folder on the same volume (does not).
 * The OS's own temp folder is measured too, as an observation with no expected answer.
 *
 * Kept afterwards as the real half of the `normalizePathKey` contract (later: ISSUE-064, `volumeCase.ts`).
 * Set `S0301_REPORT=<file>`, or `SPIKE_REPORT_DIR=<dir>` (writes `<dir>/S-030-1-<platform>.json`), to write the
 * measurements as JSON (the spike record's raw output). Paths in the report are scrubbed (privacy guard).
 */

interface Volume {
  readonly label: string
  readonly how: string
  /** The folder the probe folder is created in. */
  readonly dir: string
  /** What the file system is known to do, or null for an observation (the OS's own temp folder). */
  readonly expected: VolumeCase | null
}

interface Measurement {
  readonly label: string
  readonly how: string
  readonly expected: VolumeCase | null
  readonly verdict: VolumeCase
  readonly reads: number
  readonly latencyMs: { readonly min: number; readonly median: number; readonly max: number }
  /** What `fs.realpathSync.native` returns for the swapped spelling of the probe folder. */
  readonly realpathOfSwappedSpelling: string
}

const PROBE = 'Probe-S0301'
const ROUNDS = 20
const SETUP_TIMEOUT_MS = 120_000

const volumes: Volume[] = []
const measurements: Measurement[] = []
const setupNotes: string[] = []
const cleanups: (() => void)[] = []
let root = ''

function run(file: string, args: readonly string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true
    })
    return { ok: true, output: output.trim() }
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string }
    return {
      ok: false,
      output: `${failure.stderr ?? ''}${failure.stdout ?? ''}`.trim() || failure.message
    }
  }
}

function note(text: string): void {
  setupNotes.push(scrub(text))
}

/** Replaces machine-specific values, also in their JSON-escaped spelling (privacy guard). */
function scrub(text: string): string {
  let out = text
  for (const [value, placeholder] of [
    [root, '<work>'],
    [tmpdir(), '<tmp>'],
    [process.cwd(), '<repo>'],
    [homedir(), '<home>'],
    [userInfo().username, '<user>']
  ] as const) {
    if (value === '') continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = out.split(spelling).join(placeholder)
    }
  }
  return out
}

function windowsTool(name: string): string {
  return path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', name)
}

function prepareWindows(): void {
  const folding = path.join(root, 'ntfs')
  mkdirSync(folding)
  volumes.push({
    label: 'ntfs',
    how: 'NTFS temp folder, default',
    dir: folding,
    expected: 'case-insensitive'
  })
  const exact = path.join(root, 'ntfs-case-sensitive')
  mkdirSync(exact)
  const flag = run(windowsTool('fsutil.exe'), ['file', 'setCaseSensitiveInfo', exact, 'enable'])
  if (flag.ok) {
    volumes.push({
      label: 'ntfs-case-sensitive',
      how: 'NTFS temp folder with the per-directory case-sensitive flag (fsutil, not elevated)',
      dir: exact,
      expected: 'case-sensitive'
    })
  } else {
    note(`fsutil setCaseSensitiveInfo failed: ${flag.output}`)
  }
}

function prepareMac(): void {
  for (const [label, fs, expected] of [
    ['apfs', 'APFS', 'case-insensitive'],
    ['apfs-case-sensitive', 'Case-sensitive APFS', 'case-sensitive']
  ] as const) {
    const image = path.join(root, `${label}.dmg`)
    const mount = path.join(root, `${label}-mnt`)
    mkdirSync(mount)
    const created = run('/usr/bin/hdiutil', [
      'create',
      '-quiet',
      '-size',
      '32m',
      '-fs',
      fs,
      '-volname',
      `S0301-${label}`,
      image
    ])
    if (!created.ok) {
      note(`hdiutil create (${fs}) failed: ${created.output}`)
      continue
    }
    const attached = run('/usr/bin/hdiutil', [
      'attach',
      '-quiet',
      '-nobrowse',
      '-noverify',
      '-noautoopen',
      '-mountpoint',
      mount,
      image
    ])
    if (!attached.ok) {
      note(`hdiutil attach (${fs}) failed: ${attached.output}`)
      continue
    }
    cleanups.push(() => {
      run('/usr/bin/hdiutil', ['detach', mount, '-force'])
    })
    volumes.push({ label, how: `disk image, ${fs} (hdiutil, not elevated)`, dir: mount, expected })
  }
}

/** A sparse 64 MiB image file, formatted with `mkfs`, loop-mounted through `sudo -n`; its mount point, or null. */
function loopMount(name: string, mkfs: readonly string[], options: string): string | null {
  const image = path.join(root, `${name}.img`)
  const mount = path.join(root, `${name}-mnt`)
  mkdirSync(mount)
  writeFileSync(image, '')
  truncateSync(image, 64 * 1024 * 1024)
  const [mkfsTool = 'mkfs', ...mkfsArgs] = mkfs
  const made = run(mkfsTool, [...mkfsArgs, image])
  if (!made.ok) {
    note(`${mkfs.join(' ')} failed: ${made.output}`)
    return null
  }
  const mounted = run('sudo', ['-n', 'mount', '-o', options, image, mount])
  if (!mounted.ok) {
    note(`sudo -n mount -o ${options} (${name}) failed: ${mounted.output}`)
    return null
  }
  cleanups.push(() => {
    run('sudo', ['-n', 'umount', mount])
  })
  return mount
}

function prepareLinux(): void {
  if (!run('sudo', ['-n', 'true']).ok) {
    note('sudo -n is not available: no loop-mounted image')
    return
  }
  const uid = String(process.getuid?.() ?? 0)
  const gid = String(process.getgid?.() ?? 0)
  // First choice: ext4 with the casefold feature, where folding is a per-directory attribute (+F).
  const ext4 = loopMount('casefold-ext4', ['mkfs.ext4', '-q', '-F', '-O', 'casefold'], 'loop')
  if (ext4 !== null) {
    run('sudo', ['-n', 'chown', `${uid}:${gid}`, ext4])
    const folding = path.join(ext4, 'folding')
    const exact = path.join(ext4, 'exact')
    mkdirSync(folding)
    mkdirSync(exact)
    let flag = run('chattr', ['+F', folding])
    if (!flag.ok) flag = run('sudo', ['-n', 'chattr', '+F', folding])
    if (flag.ok) {
      volumes.push({
        label: 'ext4-casefold-dir',
        how: 'ext4 image with the casefold feature, folder with the +F attribute (loop mount through sudo -n)',
        dir: folding,
        expected: 'case-insensitive'
      })
    } else {
      note(`chattr +F failed: ${flag.output}`)
    }
    volumes.push({
      label: 'ext4-plain-dir',
      how: 'the same ext4 casefold image, folder without +F',
      dir: exact,
      expected: 'case-sensitive'
    })
  }
  if (!volumes.some((volume) => volume.expected === 'case-insensitive')) {
    // Second choice: a FAT image, case-insensitive as a whole volume.
    const vfat = loopMount('vfat', ['mkfs.vfat'], `loop,uid=${uid},gid=${gid}`)
    if (vfat !== null) {
      volumes.push({
        label: 'vfat',
        how: 'FAT image (mkfs.vfat), loop mount through sudo -n',
        dir: vfat,
        expected: 'case-insensitive'
      })
    }
  }
  if (!volumes.some((volume) => volume.expected === 'case-sensitive')) {
    const plain = loopMount('ext4', ['mkfs.ext4', '-q', '-F'], 'loop')
    if (plain !== null) {
      run('sudo', ['-n', 'chown', `${uid}:${gid}`, plain])
      volumes.push({
        label: 'ext4',
        how: 'plain ext4 image, loop mount through sudo -n',
        dir: plain,
        expected: 'case-sensitive'
      })
    }
  }
}

/** What the real path of the swapped spelling of `probe` comes to. */
function realpathOfSwapped(probe: string): string {
  const swapped = path.join(path.dirname(probe), PROBE.toLowerCase())
  try {
    const resolved = path.basename(realpathSync.native(swapped))
    return resolved === PROBE ? 'the on-disk spelling' : `the spelling given (${resolved})`
  } catch (error) {
    return `not found (${(error as NodeJS.ErrnoException).code ?? 'error'})`
  }
}

async function measure(volume: Volume): Promise<Measurement> {
  const probe = path.join(volume.dir, PROBE)
  mkdirSync(probe, { recursive: true })
  const real = realpathSync.native(probe)
  let last: Detection | null = null
  const times: number[] = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const started = performance.now()
    last = await detectVolumeCase(real)
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  const rounded = (value: number): number => Math.round(value * 1000) / 1000
  return {
    label: volume.label,
    how: volume.how,
    expected: volume.expected,
    verdict: last?.verdict ?? 'unknown',
    reads: last?.reads ?? 0,
    latencyMs: {
      min: rounded(times[0] ?? 0),
      median: rounded(times[Math.floor(times.length / 2)] ?? 0),
      max: rounded(times[times.length - 1] ?? 0)
    },
    realpathOfSwappedSpelling: realpathOfSwapped(probe)
  }
}

function reportFile(): string | null {
  const explicit = process.env['S0301_REPORT']
  if (explicit) return path.resolve(explicit)
  const dir = process.env['SPIKE_REPORT_DIR']
  return dir ? path.resolve(dir, `S-030-1-${process.platform}.json`) : null
}

describe('S-030-1: case-insensitive volume detection (ADR-030 item 1)', () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0301-'))
    if (process.platform === 'win32') prepareWindows()
    else if (process.platform === 'darwin') prepareMac()
    else prepareLinux()
    const observed = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0301-os-temp-'))
    cleanups.push(() => rmSync(observed, { recursive: true, force: true }))
    volumes.push({
      label: 'os-temp',
      how: "the OS's own temp folder",
      dir: observed,
      expected: null
    })
    for (const volume of volumes) measurements.push(await measure(volume))
  }, SETUP_TIMEOUT_MS)

  afterAll(() => {
    const file = reportFile()
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true })
      const report = {
        spike: 'S-030-1',
        platform: process.platform,
        osRelease: release(),
        node: process.version,
        rounds: ROUNDS,
        measurements,
        setupNotes
      }
      writeFileSync(file, `${scrub(JSON.stringify(report, null, 2))}\n`)
    }
    for (const cleanup of cleanups.reverse()) cleanup()
    rmSync(root, { recursive: true, force: true })
  }, SETUP_TIMEOUT_MS)

  it('[S-030-1, ADR-030] the detection method reports a case-insensitive volume as folding and a case-sensitive one as not', () => {
    const known = measurements.filter((measured) => measured.expected !== null)
    const kinds = new Set(known.map((measured) => measured.expected))
    // Windows is the control: NTFS folds, and the per-directory case-sensitive flag, where the OS supports it, is
    // extra evidence. macOS and Linux are the question, so both kinds are required there.
    const required: VolumeCase[] =
      process.platform === 'win32' ? ['case-insensitive'] : ['case-insensitive', 'case-sensitive']
    for (const kind of required) {
      expect(
        kinds.has(kind),
        `a ${kind} volume was prepared on ${process.platform} (setup notes: ${setupNotes.join('; ') || 'none'})`
      ).toBe(true)
    }
    for (const measured of known) {
      expect(measured.verdict, `${measured.label}: ${measured.how}`).toBe(measured.expected)
    }
  })

  it('[S-030-1] the detection reads at most two paths, and answers unknown when no name has a cased letter', async () => {
    for (const measured of measurements) {
      expect(measured.reads, `${measured.label} identity reads`).toBeLessThanOrEqual(2)
    }
    const reads: string[] = []
    const fake = (file: string): Promise<FileIdentity | null> => {
      reads.push(file)
      return Promise.resolve({ dev: 1n, ino: 2n })
    }
    expect((await detectVolumeCase('/1/2', fake)).verdict).toBe('unknown')
    expect(reads, 'nothing to probe means nothing is read').toEqual([])
  })
})
