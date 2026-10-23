// layer: L7
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppProfile, removeProfile } from './apps.mjs'
import { writeAsar } from './asarFixture.mjs'
import checkHostCopy, { copyDirOf, id } from './p05-host-copy.packaged.mjs'

/**
 * The packaged check P-05 (`20` §2.3; ADR-027 items 1-2; ISSUE-270) over fixture artifact trees, one `mkdtemp` folder
 * per case: a packed app laid out as electron-builder lays it out, whose `app.asar` holds the app's `package.json`.
 * The app is never started here: `run` stands for the start and answers the path the Host's executable runs from. The
 * real artifacts are checked by `pnpm test:packaged` on the runner of each OS.
 */

const VERSION = '1.4.0'
const WIN = { platform: 'win32', arch: 'x64' }
const LINUX = { platform: 'linux', arch: 'x64' }
const MAC = { platform: 'darwin', arch: 'arm64' }

const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-p05-'))
  dirs.push(dir)
  return dir
}

function put(file, content = 'x') {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** A packed app folder `folder` of `artifactDir`: its executable and `resources/app.asar`. */
function packedApp(artifactDir, folder, executable) {
  put(path.join(artifactDir, folder, executable), 'the executable')
  writeAsar(path.join(artifactDir, folder, 'resources', 'app.asar'), {
    'package.json': JSON.stringify({ name: 'dwarfai-miners', version: VERSION })
  })
}

function windowsArtifacts() {
  const artifactDir = tempDir()
  packedApp(artifactDir, 'win-unpacked', 'DwarfAI-Miners.exe')
  put(path.join(artifactDir, `DwarfAI-Miners-${VERSION}-win-x64.zip`))
  put(path.join(artifactDir, `DwarfAI-Miners-${VERSION}-setup.exe`))
  return artifactDir
}

function linuxArtifacts() {
  const artifactDir = tempDir()
  packedApp(artifactDir, 'linux-unpacked', 'dwarfai-miners')
  put(path.join(artifactDir, `DwarfAI-Miners-${VERSION}-x86_64.AppImage`))
  put(path.join(artifactDir, `dwarfai-miners_${VERSION}_amd64.deb`))
  return artifactDir
}

/** Stands for `dpkg-deb -x`: the deb's payload, the app under `opt/DwarfAI-Miners/`. */
async function debPayload(_deb, intoDir) {
  packedApp(intoDir, path.join('opt', 'DwarfAI-Miners'), 'dwarfai-miners')
}

/** A macOS artifact folder: `mac-arm64/DwarfAI-Miners.app` with its executable and `Contents/Resources/app.asar`. */
function macArtifacts() {
  const artifactDir = tempDir()
  const contents = path.join(artifactDir, 'mac-arm64', 'DwarfAI-Miners.app', 'Contents')
  put(path.join(contents, 'MacOS', 'DwarfAI-Miners'), 'the executable')
  writeAsar(path.join(contents, 'Resources', 'app.asar'), {
    'package.json': JSON.stringify({ name: 'dwarfai-miners', version: VERSION })
  })
  return artifactDir
}

/** A start that made `host/<version>/` at the documented path and runs the Host from inside it. */
const hostFromCopy = async ({ executable, profile, platform }) => {
  const copyDir = copyDirOf({ platform, dataRoot: profile.dataRoot, version: VERSION })
  const copied = path.join(copyDir, path.basename(executable))
  put(copied, 'the copied executable')
  return { hostExecPath: copied }
}

describe('P-05 the Host runs from its versioned copy (ADR-027 items 1-2; 20 §2.3)', () => {
  it('[ADR-027] P-05 passes when the Host runs from host/<version>/ at the documented per-OS path', async () => {
    // The check runs on the OS that built the artifact, so the path is joined with that OS's separators.
    const dataRoot = tempDir()
    expect(copyDirOf({ platform: 'win32', dataRoot, version: VERSION })).toBe(
      path.join(dataRoot, 'DwarfAI', 'host', '1.4.0')
    )
    expect(copyDirOf({ platform: 'darwin', dataRoot, version: VERSION })).toBe(
      path.join(dataRoot, 'Library', 'Application Support', 'DwarfAI', 'host', '1.4.0')
    )
    expect(copyDirOf({ platform: 'linux', dataRoot, version: VERSION })).toBe(
      path.join(dataRoot, 'dwarfai', 'host', '1.4.0')
    )

    let started
    const result = await checkHostCopy({
      artifactDir: windowsArtifacts(),
      ...WIN,
      run: async (input) => {
        started = input
        return hostFromCopy(input)
      }
    })

    expect(id).toBe('P-05')
    expect(path.basename(started.executable)).toBe('DwarfAI-Miners.exe')
    expect(result.ok, result.detail).toBe(true)
    expect(result.detail).toMatch(/win-unpacked/)
    expect(result.detail).toContain(path.join('DwarfAI', 'host', VERSION))
  })

  it('[ADR-027] P-05 fails when the Host runs from the install directory or no copy was made', async () => {
    const fromInstall = await checkHostCopy({
      artifactDir: windowsArtifacts(),
      ...WIN,
      run: async (input) => {
        await hostFromCopy(input)
        return { hostExecPath: input.executable }
      }
    })
    expect(fromInstall.ok).toBe(false)
    expect(fromInstall.detail).toMatch(/win-unpacked.*not inside/)

    const noCopy = await checkHostCopy({
      artifactDir: windowsArtifacts(),
      ...WIN,
      run: async ({ profile }) => ({
        hostExecPath: path.join(profile.root, 'elsewhere', 'DwarfAI-Miners.exe')
      })
    })
    expect(noCopy.ok).toBe(false)
    expect(noCopy.detail).toMatch(/win-unpacked.*no host\/1\.4\.0\//)
  })

  it('[ADR-027, SP-03] on Linux P-05 runs the unpacked app, the deb payload and the AppImage for real', async () => {
    const linuxDir = linuxArtifacts()
    const started = []
    const linux = await checkHostCopy({
      artifactDir: linuxDir,
      ...LINUX,
      extractDeb: debPayload,
      run: async (input) => {
        started.push(path.basename(input.executable))
        return hostFromCopy(input)
      }
    })

    expect(linux.ok, linux.detail).toBe(true)
    expect(linux.blocked).toBeUndefined()
    expect(linux.detail).toMatch(/linux-unpacked ok/)
    expect(linux.detail).toMatch(/dwarfai-miners_1\.4\.0_amd64\.deb ok/)
    expect(linux.detail).toMatch(/DwarfAI-Miners-1\.4\.0-x86_64\.AppImage ok/)
    expect(started).toEqual([
      'dwarfai-miners',
      'dwarfai-miners',
      `DwarfAI-Miners-${VERSION}-x86_64.AppImage`
    ])
  })

  it('[ADR-027, SP-03] an AppImage that cannot mount without FUSE runs extracted, and the line says so', async () => {
    const attempts = []
    const result = await checkHostCopy({
      artifactDir: linuxArtifacts(),
      ...LINUX,
      extractDeb: debPayload,
      run: async (input) => {
        if (!input.executable.endsWith('.AppImage')) return hostFromCopy(input)
        attempts.push(input.env?.APPIMAGE_EXTRACT_AND_RUN ?? 'mount')
        if (input.env?.APPIMAGE_EXTRACT_AND_RUN !== '1') {
          throw new Error('the app exited; stderr: dlopen(): error loading libfuse.so.2')
        }
        return hostFromCopy(input)
      }
    })

    expect(result.ok, result.detail).toBe(true)
    expect(attempts).toEqual(['mount', '1'])
    expect(result.detail).toMatch(/AppImage ok \(extract-and-run: no FUSE on this runner\)/)
  })

  it('[ADR-027, SP-03] P-05 runs an unsigned .app for real and reports a signed or unreadable .app as blocked by SP-03, never green', async () => {
    const started = []
    const run = async (input) => {
      started.push(path.basename(input.executable))
      return hostFromCopy(input)
    }

    const unsigned = await checkHostCopy({
      artifactDir: macArtifacts(),
      ...MAC,
      signatureOf: () => 'adhoc',
      run
    })
    expect(unsigned.ok, unsigned.detail).toBe(true)
    expect(unsigned.detail).toMatch(/mac-arm64\/DwarfAI-Miners\.app ok/)
    expect(started).toEqual(['DwarfAI-Miners'])

    for (const signature of ['signed', 'unknown']) {
      started.length = 0
      const blocked = await checkHostCopy({
        artifactDir: macArtifacts(),
        ...MAC,
        signatureOf: () => signature,
        run
      })
      expect(blocked.ok, signature).toBe(false)
      expect(blocked.blocked).toMatchObject({ by: 'SP-03' })
      expect(blocked.detail).toBe(
        'mac-arm64/DwarfAI-Miners.app — SP-03 (signed/notarized .app) not recorded'
      )
      expect(started, 'a blocked .app is never started').toEqual([])
    }
  })

  it('[ADR-027] a macOS profile takes its short /tmp data root only on a macOS host, so a simulated darwin run stays under the temp folder', async () => {
    const simulated = createAppProfile('dwarfai-p05', 'darwin', 'win32')
    try {
      const relative = path.relative(tmpdir(), simulated.dataRoot)
      expect(relative.startsWith('..') || path.isAbsolute(relative), simulated.dataRoot).toBe(false)
      expect(simulated.home, 'HOME is the data root on macOS').toBe(simulated.dataRoot)
    } finally {
      await removeProfile(simulated)
    }
  })

  it('[ADR-027] P-05 fails a folder with no packed app or an app whose Host never started', async () => {
    const noApp = await checkHostCopy({ artifactDir: tempDir(), ...WIN, run: hostFromCopy })
    expect(noApp.ok).toBe(false)
    expect(noApp.detail).toMatch(/no packed app/)

    const broken = await checkHostCopy({
      artifactDir: windowsArtifacts(),
      ...WIN,
      run: async () => {
        throw new Error('no Host identity within 90000 ms')
      }
    })
    expect(broken.ok).toBe(false)
    expect(broken.detail).toMatch(/win-unpacked.*no Host identity within 90000 ms/)
  })
})
