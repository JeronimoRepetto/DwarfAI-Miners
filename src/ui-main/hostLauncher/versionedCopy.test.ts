// The Host's versioned copy (ADR-002 D5; ADR-027 item 2; 13 FM-129; SP-03 decision table).
// L3-style over a temporary directory: the copy, the rename and the removal are real file
// operations; a fault (a copy killed mid-way) is injected through CopyOps.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeLauncherClock } from './fakes/FakeLauncherClock'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { buildManifest, serializeManifest, verifyManifest } from './hostManifest'
import {
  copySourceOf,
  ensureVersionedCopy,
  hostManifestPathOf,
  nodeCopyOps,
  packagedResourcesDirOf,
  versionedCopyRoot,
  type CopyOps,
  type VersionedCopyRequest
} from './versionedCopy'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const VERSION = '1.4.0'

/** A build: an app directory, its manifest file beside it, and an empty copy root. */
async function world(appName = 'app') {
  const base = mkdtempSync(path.join(tmpdir(), 'dwarfai-031-copy-'))
  dirs.push(base)
  const sourceDir = path.join(base, 'build', appName)
  mkdirSync(path.join(sourceDir, 'resources'), { recursive: true })
  writeFileSync(path.join(sourceDir, 'app.exe'), 'executable bytes')
  writeFileSync(path.join(sourceDir, 'resources', 'app.asar'), 'archive bytes v1')
  writeFileSync(path.join(sourceDir, 'resources', 'extra.pak'), 'pak bytes')
  const manifestPath = path.join(base, 'build', 'host-manifest.json')
  const root = path.join(base, 'DwarfAI', 'host')
  const writeManifest = async (): Promise<void> =>
    writeFileSync(manifestPath, serializeManifest(await buildManifest(sourceDir)))
  await writeManifest()
  const log = new RecordingUiLog()
  const request = (overrides: Partial<VersionedCopyRequest> = {}): VersionedCopyRequest => ({
    version: VERSION,
    sourceDir,
    manifestPath,
    root,
    platform: 'linux',
    pid: 4242,
    ops: nodeCopyOps,
    log,
    clock: new FakeLauncherClock(1_000),
    ...overrides
  })
  return { base, sourceDir, manifestPath, root, log, request, writeManifest }
}

/** CopyOps that record every call and pass it on to the real ones. */
function recordingOps(observe: (call: string, args: string[]) => void = () => {}): {
  ops: CopyOps
  calls: Array<[string, ...string[]]>
} {
  const calls: Array<[string, ...string[]]> = []
  const ops: CopyOps = {
    async copyTree(from, to, include) {
      calls.push(['copyTree', from, to])
      observe('copyTree', [from, to])
      await nodeCopyOps.copyTree(from, to, include)
    },
    async rename(from, to) {
      calls.push(['rename', from, to])
      observe('rename', [from, to])
      await nodeCopyOps.rename(from, to)
    },
    async removeTree(target) {
      calls.push(['removeTree', target])
      observe('removeTree', [target])
      await nodeCopyOps.removeTree(target)
    },
    async busyFile(dir) {
      calls.push(['busyFile', dir])
      observe('busyFile', [dir])
      return nodeCopyOps.busyFile(dir)
    }
  }
  return { ops, calls }
}

describe('ensureVersionedCopy (ADR-002 D5, ADR-027 item 2)', () => {
  it('[ADR-027, FM-129] a copy killed mid-way leaves only a .tmp- directory, which the next start removes before copying again', async () => {
    const w = await world()
    // The UI dies during the copy: one file reaches the destination, then nothing else runs
    // (no clean-up either, as after a kill).
    const killed: CopyOps = {
      async copyTree(_from, to) {
        mkdirSync(to, { recursive: true })
        writeFileSync(path.join(to, 'app.exe'), 'executable bytes')
        throw Object.assign(new Error('killed'), { code: 'KILLED' })
      },
      rename: () => Promise.reject(new Error('dead process')),
      removeTree: () => Promise.reject(new Error('dead process')),
      busyFile: () => Promise.reject(new Error('dead process'))
    }

    const first = await ensureVersionedCopy(w.request({ ops: killed, pid: 111 }))

    expect(first.ok).toBe(false)
    expect(readdirSync(w.root), 'only the temporary directory is left').toEqual([
      `${VERSION}.tmp-111`
    ])

    const { ops, calls } = recordingOps()
    const second = await ensureVersionedCopy(w.request({ ops, pid: 222 }))

    expect(second).toEqual({
      ok: true,
      reused: false,
      copyDir: path.join(w.root, VERSION),
      contentDir: path.join(w.root, VERSION)
    })
    expect(calls[0], 'the leftover is removed before copying again').toEqual([
      'removeTree',
      path.join(w.root, `${VERSION}.tmp-111`)
    ])
    expect(readdirSync(w.root)).toEqual([VERSION])
    const manifest = await buildManifest(w.sourceDir)
    expect(
      await verifyManifest(path.join(w.root, VERSION), manifest, {
        exclude: ['host-manifest.json']
      })
    ).toEqual({
      ok: true
    })
  })

  it('[ADR-027] a verified copy is reused; a copy whose manifest hash differs is rebuilt', async () => {
    const w = await world()
    expect((await ensureVersionedCopy(w.request())).ok).toBe(true)

    const reuse = recordingOps()
    const again = await ensureVersionedCopy(w.request({ ops: reuse.ops }))
    expect(again).toMatchObject({ ok: true, reused: true })
    expect(reuse.calls, 'nothing is copied, renamed or removed').toEqual([])

    // A new build of the same version: one file changed, so its manifest hash differs.
    writeFileSync(path.join(w.sourceDir, 'resources', 'app.asar'), 'archive bytes v2')
    await w.writeManifest()
    const rebuild = recordingOps()
    const rebuilt = await ensureVersionedCopy(w.request({ ops: rebuild.ops }))

    expect(rebuilt).toMatchObject({ ok: true, reused: false })
    expect(rebuild.calls.map(([call]) => call)).toContain('copyTree')
    expect(await readFile(path.join(w.root, VERSION, 'resources', 'app.asar'), 'utf8')).toBe(
      'archive bytes v2'
    )
    expect(readdirSync(w.root)).toEqual([VERSION])
    expect(
      w.log.byEvent('versioned-copy').map((entry) => [entry.outcome, entry.causeClass])
    ).toEqual([
      ['ok', 'copy'],
      ['ok', 'reuse'],
      ['ok', 'copy']
    ])
  })

  it('[ADR-027, FM-008] a reused copy with a listed file gone is rebuilt, not started', async () => {
    const w = await world()
    expect((await ensureVersionedCopy(w.request())).ok).toBe(true)
    // An antivirus removed a file from the copy.
    rmSync(path.join(w.root, VERSION, 'resources', 'extra.pak'))

    const outcome = await ensureVersionedCopy(w.request())

    expect(outcome).toMatchObject({ ok: true, reused: false })
    expect(existsSync(path.join(w.root, VERSION, 'resources', 'extra.pak'))).toBe(true)
  })

  it('[ADR-027] the final directory appears only by rename, never partially', async () => {
    const w = await world()
    const finalDir = path.join(w.root, VERSION)
    const temp = path.join(w.root, `${VERSION}.tmp-4242`)
    const seen: string[] = []
    const { ops, calls } = recordingOps((call, args) => {
      seen.push(`${call}: final ${existsSync(finalDir) ? 'exists' : 'absent'}`)
      if (call === 'copyTree') expect(args[1]).toBe(temp)
    })

    const outcome = await ensureVersionedCopy(w.request({ ops }))

    expect(outcome.ok).toBe(true)
    expect(calls.map(([call]) => call)).toEqual(['copyTree', 'rename'])
    expect(calls[1]).toEqual(['rename', temp, finalDir])
    expect(seen).toEqual(['copyTree: final absent', 'rename: final absent'])

    // A source that no longer matches its manifest: the copy is removed and never renamed.
    const other = await world()
    writeFileSync(path.join(other.sourceDir, 'resources', 'app.asar'), 'tampered')
    const tampered = recordingOps()
    const refused = await ensureVersionedCopy(other.request({ ops: tampered.ops }))

    expect(refused).toEqual({ ok: false, errCode: 'MANIFEST_MISMATCH' })
    expect(tampered.calls.map(([call]) => call)).toEqual(['copyTree', 'removeTree'])
    expect(readdirSync(other.root)).toEqual([])
    expect(other.log.byEvent('versioned-copy')).toMatchObject([
      { level: 'error', outcome: 'failed', causeClass: 'copy', errCode: 'MANIFEST_MISMATCH' }
    ])
  })

  it('[ADR-002, FM-129] a missing or unreadable manifest, or a version that is not a folder name, starts no copy', async () => {
    const w = await world()
    rmSync(w.manifestPath)
    expect(await ensureVersionedCopy(w.request())).toEqual({
      ok: false,
      errCode: 'MANIFEST_MISSING'
    })
    writeFileSync(w.manifestPath, '{"format":9}')
    expect(await ensureVersionedCopy(w.request())).toEqual({
      ok: false,
      errCode: 'MANIFEST_INVALID'
    })
    await w.writeManifest()
    for (const version of ['', '..', '1.0/2', '1.0\\2', '1.0.tmp-3']) {
      expect(await ensureVersionedCopy(w.request({ version })), version).toEqual({
        ok: false,
        errCode: 'VERSION_INVALID'
      })
    }
    expect(existsSync(w.root) ? readdirSync(w.root) : []).toEqual([])
  })

  it('[SP-03] on macOS the .app bundle is copied whole, under its own name, inside host/<version>/', async () => {
    const w = await world('DwarfAI-Miners.app')

    const outcome = await ensureVersionedCopy(w.request({ platform: 'darwin' }))

    expect(outcome).toEqual({
      ok: true,
      reused: false,
      copyDir: path.join(w.root, VERSION),
      contentDir: path.join(w.root, VERSION, 'DwarfAI-Miners.app')
    })
    expect(existsSync(path.join(w.root, VERSION, 'DwarfAI-Miners.app', 'app.exe'))).toBe(true)
  })

  it('[ADR-002, ADR-027] a file the installer put beside the app, outside the manifest, is left out of the copy and does not fail it', async () => {
    const w = await world()
    // The nsis installer writes its uninstaller into the install directory after the build
    // listed it (electron-builder installer.nsh), so the copy source holds one file more.
    writeFileSync(path.join(w.sourceDir, 'Uninstall DwarfAI-Miners.exe'), 'uninstaller bytes')

    const outcome = await ensureVersionedCopy(w.request())

    expect(outcome).toEqual({
      ok: true,
      reused: false,
      copyDir: path.join(w.root, VERSION),
      contentDir: path.join(w.root, VERSION)
    })
    expect(readdirSync(path.join(w.root, VERSION)).sort()).toEqual([
      'app.exe',
      'host-manifest.json',
      'resources'
    ])
  })

  it('[ADR-002, FM-129] a listed file missing from the copy source still fails the copy', async () => {
    const w = await world()
    rmSync(path.join(w.sourceDir, 'resources', 'extra.pak'))

    expect(await ensureVersionedCopy(w.request())).toEqual({
      ok: false,
      errCode: 'MANIFEST_MISMATCH'
    })
    expect(readdirSync(w.root)).toEqual([])
  })

  it('[ADR-027, FM-129] a copy that fails after its temporary directory was made removes that directory', async () => {
    const w = await world()
    // The final rename is refused (an antivirus holding the new folder, say).
    const refused: CopyOps = {
      ...nodeCopyOps,
      rename: () => Promise.reject(Object.assign(new Error('refused'), { code: 'EPERM' }))
    }

    const outcome = await ensureVersionedCopy(w.request({ ops: refused }))

    expect(outcome).toEqual({ ok: false, errCode: 'COPY_EPERM' })
    expect(readdirSync(w.root), 'no temporary directory is left behind').toEqual([])
  })

  it('[ADR-027, FM-129] an outdated copy of this version that a running Host holds is never deleted in place: the start fails COPY_IN_USE and that copy stays whole', async () => {
    const w = await world()
    expect((await ensureVersionedCopy(w.request())).ok).toBe(true)
    const copyDir = path.join(w.root, VERSION)
    const before = readdirSync(copyDir, { recursive: true }).map(String).sort()
    // Another build of the same version, so the copy there is outdated for this one.
    writeFileSync(path.join(w.sourceDir, 'resources', 'app.asar'), 'archive bytes v2')
    await w.writeManifest()
    // Windows, with a Host running from the copy (versionedCopyInUse.os.test.ts): its executable cannot be opened for
    // writing (EBUSY) nor removed, so a removal deletes every other file and then fails; the folder holding it can
    // still be renamed, and the executable goes with it.
    let held = copyDir
    const ops: CopyOps = {
      ...nodeCopyOps,
      busyFile: async (dir) => (dir === held ? 'EBUSY' : nodeCopyOps.busyFile(dir)),
      async rename(from, to) {
        await nodeCopyOps.rename(from, to)
        if (from === held) held = to
      },
      async removeTree(target) {
        if (target !== held) return nodeCopyOps.removeTree(target)
        rmSync(path.join(target, 'resources'), { recursive: true, force: true })
        rmSync(path.join(target, 'host-manifest.json'), { force: true })
        throw Object.assign(new Error('in use'), { code: 'EPERM' })
      }
    }

    const outcome = await ensureVersionedCopy(w.request({ ops, pid: 333 }))

    expect(outcome).toEqual({ ok: false, errCode: 'COPY_IN_USE' })
    expect(
      readdirSync(copyDir, { recursive: true }).map(String).sort(),
      'the copy in use is whole'
    ).toEqual(before)
    expect(readdirSync(w.root), 'and no temporary directory is left').toEqual([VERSION])
    expect(w.log.byEvent('versioned-copy').at(-1)).toMatchObject({
      level: 'error',
      outcome: 'failed',
      causeClass: 'copy',
      errCode: 'COPY_IN_USE'
    })
  })

  it('[ADR-027, FM-129] an outdated copy of this version that nothing holds is replaced by rename, and what it moved aside is removed', async () => {
    const w = await world()
    expect((await ensureVersionedCopy(w.request())).ok).toBe(true)
    writeFileSync(path.join(w.sourceDir, 'resources', 'app.asar'), 'archive bytes v2')
    await w.writeManifest()
    const copyDir = path.join(w.root, VERSION)
    const temp = path.join(w.root, `${VERSION}.tmp-444`)
    const aside = path.join(w.root, `${VERSION}.tmp-444-old`)
    const { ops, calls } = recordingOps()

    const outcome = await ensureVersionedCopy(w.request({ ops, pid: 444 }))

    expect(outcome).toMatchObject({ ok: true, reused: false })
    expect(calls).toEqual([
      ['copyTree', w.sourceDir, temp],
      ['busyFile', copyDir],
      ['rename', copyDir, aside],
      ['rename', temp, copyDir],
      ['removeTree', aside]
    ])
    expect(readdirSync(w.root)).toEqual([VERSION])
    expect(await readFile(path.join(copyDir, 'resources', 'app.asar'), 'utf8')).toBe(
      'archive bytes v2'
    )
  })
})

describe('where the copy lives and what it is made from (ADR-002 D5)', () => {
  it('[ADR-002, ADR-027] the copy root is %LOCALAPPDATA%\\DwarfAI\\host on Windows, ~/Library/Application Support/DwarfAI/host on macOS and $XDG_DATA_HOME/dwarfai/host on Linux', () => {
    expect(
      versionedCopyRoot({
        platform: 'win32',
        build: 'release',
        env: { LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local' },
        homeDir: 'C:\\Users\\j'
      })
    ).toEqual({ ok: true, value: 'C:\\Users\\j\\AppData\\Local\\DwarfAI\\host' })
    expect(
      versionedCopyRoot({ platform: 'darwin', build: 'release', env: {}, homeDir: '/Users/j' })
    ).toEqual({
      ok: true,
      value: '/Users/j/Library/Application Support/DwarfAI/host'
    })
    expect(
      versionedCopyRoot({
        platform: 'linux',
        build: 'release',
        env: { XDG_DATA_HOME: '/data/j' },
        homeDir: '/home/j'
      })
    ).toEqual({ ok: true, value: '/data/j/dwarfai/host' })
    // The XDG Base Directory default when XDG_DATA_HOME is unset, empty or relative.
    for (const XDG_DATA_HOME of [undefined, '', 'relative/share']) {
      expect(
        versionedCopyRoot({
          platform: 'linux',
          build: 'release',
          env: { XDG_DATA_HOME },
          homeDir: '/home/j'
        })
      ).toEqual({ ok: true, value: '/home/j/.local/share/dwarfai/host' })
    }
  })

  it('[ADR-002, ADR-005, FM-107] a development or preview build keeps its copies in host-dev beside the release root, never in it', () => {
    // A dev Host running from a copy under the release root kept an installed build from replacing that
    // copy (COPY_EPERM, 2026-10-02). `DwarfAI-dev/host` is not used: on macOS it is the dev hostDataDir.
    expect(
      versionedCopyRoot({
        platform: 'win32',
        build: 'dev',
        env: { LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local' },
        homeDir: 'C:\\Users\\j'
      })
    ).toEqual({ ok: true, value: 'C:\\Users\\j\\AppData\\Local\\DwarfAI\\host-dev' })
    expect(
      versionedCopyRoot({ platform: 'darwin', build: 'dev', env: {}, homeDir: '/Users/j' })
    ).toEqual({ ok: true, value: '/Users/j/Library/Application Support/DwarfAI/host-dev' })
    expect(
      versionedCopyRoot({
        platform: 'linux',
        build: 'dev',
        env: { XDG_DATA_HOME: '/data/j' },
        homeDir: '/home/j'
      })
    ).toEqual({ ok: true, value: '/data/j/dwarfai/host-dev' })
    // Without a LOCALAPPDATA or a home folder a dev build has no copy root either.
    expect(
      versionedCopyRoot({ platform: 'win32', build: 'dev', env: {}, homeDir: 'C:\\Users\\j' })
    ).toEqual({ ok: false, errCode: 'COPY_ROOT_UNKNOWN' })
  })

  it('[ADR-002, FM-129] without a LOCALAPPDATA or a home folder there is no copy root', () => {
    expect(
      versionedCopyRoot({ platform: 'win32', build: 'release', env: {}, homeDir: 'C:\\Users\\j' })
    ).toEqual({
      ok: false,
      errCode: 'COPY_ROOT_UNKNOWN'
    })
    expect(
      versionedCopyRoot({ platform: 'darwin', build: 'release', env: {}, homeDir: '' })
    ).toEqual({
      ok: false,
      errCode: 'COPY_ROOT_UNKNOWN'
    })
    expect(
      versionedCopyRoot({ platform: 'linux', build: 'release', env: {}, homeDir: '' })
    ).toEqual({
      ok: false,
      errCode: 'COPY_ROOT_UNKNOWN'
    })
  })

  it('[ADR-002, SP-03] the copy source is the directory holding the executable, and the whole .app bundle on macOS', () => {
    expect(copySourceOf('C:\\Apps\\DwarfAI-Miners\\DwarfAI-Miners.exe', 'win32')).toBe(
      'C:\\Apps\\DwarfAI-Miners'
    )
    expect(copySourceOf('/opt/DwarfAI-Miners/dwarfai-miners', 'linux')).toBe('/opt/DwarfAI-Miners')
    expect(
      copySourceOf('/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners', 'darwin')
    ).toBe('/Applications/DwarfAI-Miners.app')
    // An executable outside a bundle (a bare runtime) is copied by its own folder.
    expect(copySourceOf('/usr/local/lib/electron/electron', 'darwin')).toBe(
      '/usr/local/lib/electron'
    )
  })

  it('[ADR-002] a development build reads host-manifest.json beside its output; a packaged one reads it from its resources folder, outside app.asar and inside the copy source', () => {
    expect(
      hostManifestPathOf(
        {
          packaged: false,
          outDir: 'C:\\src\\dwarfai\\out',
          resourcesPath: 'C:\\src\\dwarfai\\node_modules\\electron\\dist\\resources'
        },
        'win32'
      )
    ).toBe('C:\\src\\dwarfai\\out\\host-manifest.json')
    expect(
      hostManifestPathOf(
        {
          packaged: true,
          outDir: 'C:\\Apps\\DwarfAI-Miners\\resources\\app.asar\\out',
          resourcesPath: 'C:\\Apps\\DwarfAI-Miners\\resources'
        },
        'win32'
      )
    ).toBe('C:\\Apps\\DwarfAI-Miners\\resources\\host-manifest.json')
    expect(
      hostManifestPathOf(
        {
          packaged: true,
          outDir: '/Applications/DwarfAI-Miners.app/Contents/Resources/app.asar/out',
          resourcesPath: '/Applications/DwarfAI-Miners.app/Contents/Resources'
        },
        'darwin'
      )
    ).toBe('/Applications/DwarfAI-Miners.app/Contents/Resources/host-manifest.json')
  })

  it('[ADR-002] the packaging hook writes the manifest where the packaged app reads it: the resources folder of the copy source', () => {
    expect(packagedResourcesDirOf('C:\\Apps\\DwarfAI-Miners', 'win32')).toBe(
      'C:\\Apps\\DwarfAI-Miners\\resources'
    )
    expect(packagedResourcesDirOf('/opt/DwarfAI-Miners', 'linux')).toBe(
      '/opt/DwarfAI-Miners/resources'
    )
    expect(packagedResourcesDirOf('/Applications/DwarfAI-Miners.app', 'darwin')).toBe(
      '/Applications/DwarfAI-Miners.app/Contents/Resources'
    )
    // The same folder the packaged app reads through process.resourcesPath.
    for (const [sourceDir, platform] of [
      ['C:\\Apps\\DwarfAI-Miners', 'win32'],
      ['/opt/DwarfAI-Miners', 'linux'],
      ['/Applications/DwarfAI-Miners.app', 'darwin']
    ] as const) {
      const resourcesPath = packagedResourcesDirOf(sourceDir, platform)
      expect(
        hostManifestPathOf(
          { packaged: true, outDir: `${resourcesPath}/app.asar/out`, resourcesPath },
          platform
        )
      ).toBe(
        platform === 'win32'
          ? `${resourcesPath}\\host-manifest.json`
          : `${resourcesPath}/host-manifest.json`
      )
    }
  })
})
