import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseManifest, verifyManifest } from '../../src/ui-main/hostLauncher/hostManifest.ts'
import afterPack from './afterPack.mjs'
import afterSign from './afterSign.mjs'
import writePackagedManifest, {
  packedCopySourceOf,
  verifyPackagedHostManifest
} from './write-packaged-host-manifest.mjs'

/**
 * The packaged `host-manifest.json` (ADR-002 D5; the packaged-layout piece of ISSUE-270): electron-builder's
 * afterPack hook writes it into the resources folder of the packed app, where the packaged UI reads it
 * (hostManifestPathOf), describing the directory the Host's versioned copy is made from (copySourceOf), with the
 * same buildManifest the launcher verifies with. Real file system over a temporary folder: the hook's whole job is
 * files electron-builder already wrote to disk.
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PRODUCT = 'DwarfAI-Miners'
const X64 = 1 // electron-builder's Arch enum

function write(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}

/** A packed app as electron-builder leaves it in `appOutDir` before the installer is made. */
function packedApp(
  platform,
  base = mkdtempSync(path.join(tmpdir(), 'dwarfai-packaged-manifest-'))
) {
  dirs.push(base)
  const appOutDir = path.join(base, `${platform}-unpacked`)
  if (platform === 'darwin') {
    const contents = path.join(appOutDir, `${PRODUCT}.app`, 'Contents')
    write(path.join(contents, 'MacOS', PRODUCT), 'executable bytes')
    write(path.join(contents, 'Info.plist'), 'plist bytes')
    write(path.join(contents, 'Resources', 'app.asar'), 'archive bytes')
    write(
      path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
      'fw'
    )
    return {
      appOutDir,
      sourceDir: path.join(appOutDir, `${PRODUCT}.app`),
      resourcesDir: path.join(contents, 'Resources'),
      relative: 'Contents/Resources/host-manifest.json'
    }
  }
  write(path.join(appOutDir, platform === 'win32' ? `${PRODUCT}.exe` : 'dwarfai-miners'), 'exe')
  write(path.join(appOutDir, 'resources', 'app.asar'), 'archive bytes')
  write(path.join(appOutDir, 'resources', 'app.asar.unpacked', 'prebuilds', 'helper.node'), 'node')
  write(path.join(appOutDir, 'locales', 'en-US.pak'), 'pak')
  return {
    appOutDir,
    sourceDir: appOutDir,
    resourcesDir: path.join(appOutDir, 'resources'),
    relative: 'resources/host-manifest.json'
  }
}

function contextOf(appOutDir, electronPlatformName) {
  return {
    appOutDir,
    electronPlatformName,
    arch: X64,
    packager: { appInfo: { productFilename: PRODUCT } }
  }
}

describe('write-packaged-host-manifest.mjs (ADR-002 D5)', () => {
  it.each(['win32', 'linux', 'darwin'])(
    '[ADR-002] on %s the packaging hook writes host-manifest.json into the resources folder the packaged app reads, listing the copy source but not itself',
    async (platform) => {
      const app = packedApp(platform)

      // Twice: a second run finds the first manifest in the folder it lists, and must still leave it out.
      await writePackagedManifest(contextOf(app.appOutDir, platform))
      await writePackagedManifest(contextOf(app.appOutDir, platform))

      const manifestPath = path.join(app.resourcesDir, 'host-manifest.json')
      expect(existsSync(manifestPath), 'the manifest is where the packaged app reads it').toBe(true)
      const parsed = parseManifest(readFileSync(manifestPath, 'utf8'))
      expect(parsed.ok).toBe(true)
      const paths = parsed.value.entries.map((entry) => entry.path)
      expect(paths).not.toContain(app.relative)
      expect(paths).toContain(
        platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar'
      )
      expect(
        await verifyManifest(app.sourceDir, parsed.value, { exclude: [app.relative] }),
        'the manifest describes the copy source byte for byte'
      ).toEqual({ ok: true })
    }
  )

  it('[ADR-002] the copy source of a packed app is its output folder, and the .app bundle inside it on macOS', () => {
    expect(packedCopySourceOf(contextOf(path.join('r', 'win-unpacked'), 'win32'))).toEqual({
      sourceDir: path.join('r', 'win-unpacked'),
      platform: 'win32'
    })
    expect(packedCopySourceOf(contextOf(path.join('r', 'linux-unpacked'), 'linux'))).toEqual({
      sourceDir: path.join('r', 'linux-unpacked'),
      platform: 'linux'
    })
    expect(packedCopySourceOf(contextOf(path.join('r', 'mac-arm64'), 'darwin'))).toEqual({
      sourceDir: path.join('r', 'mac-arm64', `${PRODUCT}.app`),
      platform: 'darwin'
    })
  })

  it('[ADR-002, FM-129] the check of a packed app fails when its manifest is missing or no longer matches it', async () => {
    const app = packedApp('win32')
    expect(await verifyPackagedHostManifest(app.sourceDir, 'win32')).toEqual({
      ok: false,
      reason: 'missing'
    })

    await writePackagedManifest(contextOf(app.appOutDir, 'win32'))
    expect(await verifyPackagedHostManifest(app.sourceDir, 'win32')).toEqual({ ok: true })

    // A step after the hook changed the app (a signature, a fuse flip): the manifest is stale.
    writeFileSync(path.join(app.appOutDir, `${PRODUCT}.exe`), 'signed exe')
    expect(await verifyPackagedHostManifest(app.sourceDir, 'win32')).toEqual({
      ok: false,
      reason: 'mismatch'
    })

    writeFileSync(path.join(app.resourcesDir, 'host-manifest.json'), '{"format":9}')
    expect(await verifyPackagedHostManifest(app.sourceDir, 'win32')).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })
})

describe('afterPack.mjs (electron-builder afterPack)', () => {
  it('[ADR-002] the SDK runtimes are pruned first, then the manifest is written, so it lists only what ships', async () => {
    const app = packedApp('win32')
    const scope = path.join(app.resourcesDir, 'app.asar.unpacked', 'node_modules', '@anthropic-ai')
    write(path.join(scope, 'claude-agent-sdk-win32-x64', 'marker.txt'), 'kept')
    write(path.join(scope, 'claude-agent-sdk-linux-x64', 'marker.txt'), 'pruned')

    await afterPack(contextOf(app.appOutDir, 'win32'))

    expect(existsSync(path.join(scope, 'claude-agent-sdk-linux-x64'))).toBe(false)
    expect(await verifyPackagedHostManifest(app.sourceDir, 'win32')).toEqual({ ok: true })
  })

  it('[ADR-002] package.json runs it as the afterPack hook', () => {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    expect(pkg.build.afterPack).toBe('scripts/build/afterPack.mjs')
  })
})

describe('afterSign.mjs (electron-builder afterSign)', () => {
  it('[ADR-002] on Windows the manifest is written again after electron-builder edits and signs the executable', async () => {
    const app = packedApp('win32')
    await afterPack(contextOf(app.appOutDir, 'win32'))
    // What electron-builder's WinPackager.signApp does after afterPack: it edits the executable's
    // resources (icon, version) and signs it when a certificate is configured.
    writeFileSync(path.join(app.appOutDir, `${PRODUCT}.exe`), 'exe with its icon and version')

    await afterSign(contextOf(app.appOutDir, 'win32'))

    expect(await verifyPackagedHostManifest(app.sourceDir, 'win32')).toEqual({ ok: true })
  })

  it('[ADR-002] on macOS the signed bundle is left untouched: no file is added to it after signing', async () => {
    const app = packedApp('darwin')
    await afterPack(contextOf(app.appOutDir, 'darwin'))
    const manifestPath = path.join(app.resourcesDir, 'host-manifest.json')
    const written = readFileSync(manifestPath, 'utf8')
    writeFileSync(path.join(app.sourceDir, 'Contents', 'MacOS', PRODUCT), 'signed executable')

    await afterSign(contextOf(app.appOutDir, 'darwin'))

    expect(readFileSync(manifestPath, 'utf8')).toBe(written)
  })

  it('[ADR-002] package.json runs it as the afterSign hook', () => {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    expect(pkg.build.afterSign).toBe('scripts/build/afterSign.mjs')
  })
})

describe('verify-packaged-host-manifest.mjs (CI check after packaging)', () => {
  const cli = path.join(rootDir, 'scripts', 'build', 'verify-packaged-host-manifest.mjs')
  const run = (releaseDir) => {
    try {
      const stdout = execFileSync(process.execPath, [cli, releaseDir], {
        cwd: rootDir,
        stdio: 'pipe'
      })
      return { code: 0, output: stdout.toString() }
    } catch (error) {
      return { code: error.status, output: `${error.stdout}${error.stderr}` }
    }
  }

  it('[ADR-002] every packed app in the release folder must carry a manifest that verifies against it', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'dwarfai-packaged-release-'))
    dirs.push(base)
    const win = packedApp('win32', path.join(base, 'w'))
    const mac = packedApp('darwin', path.join(base, 'm'))
    const release = path.join(base, 'release')
    mkdirSync(release)
    // electron-builder's output folder names: win-unpacked, linux-unpacked, mac / mac-arm64.
    const winOut = path.join(release, 'win-unpacked')
    const macOut = path.join(release, 'mac-arm64')
    await import('node:fs/promises').then(({ cp }) =>
      Promise.all([
        cp(win.appOutDir, winOut, { recursive: true }),
        cp(mac.appOutDir, macOut, { recursive: true })
      ])
    )
    write(path.join(release, 'DwarfAI-Miners-Setup-0.13.1-x64.exe'), 'installer')

    expect(run(release).code, 'no manifest yet').toBe(1)

    await writePackagedManifest(contextOf(winOut, 'win32'))
    await writePackagedManifest(contextOf(macOut, 'darwin'))
    const ok = run(release)
    expect(ok.code, ok.output).toBe(0)
    expect(ok.output).toContain('win-unpacked')
    expect(ok.output).toContain(`mac-arm64/${PRODUCT}.app`)

    writeFileSync(path.join(winOut, 'resources', 'app.asar'), 'changed after the hook')
    expect(run(release).code, 'a stale manifest').toBe(1)
  })

  it('[ADR-002] a release folder without any packed app fails the check instead of passing empty', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'dwarfai-packaged-release-'))
    dirs.push(base)
    expect(run(base).code).toBe(1)
  })

  it('[ADR-002] the internal build runs the check after packaging, on every OS', () => {
    const workflow = readFileSync(
      path.join(rootDir, '.github', 'workflows', 'internal-build.yml'),
      'utf8'
    )
    const jobs = workflow.split(/\n {2}(?=[a-z-]+:\n)/).filter((job) => job.includes('runs-on:'))
    expect(jobs).toHaveLength(2)
    for (const job of jobs) {
      const packaging = job.indexOf('- name: Package installers')
      const check = job.indexOf('node scripts/build/verify-packaged-host-manifest.mjs release')
      expect(packaging, job.slice(0, 40)).toBeGreaterThan(-1)
      expect(check, job.slice(0, 40)).toBeGreaterThan(packaging)
    }
  })
})
