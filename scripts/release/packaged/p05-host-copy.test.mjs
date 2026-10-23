// layer: L7
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('[ADR-027, SP-03] P-05 reports the AppImage and the .app as blocked by SP-03, never green', async () => {
    const linuxDir = tempDir()
    packedApp(linuxDir, 'linux-unpacked', 'dwarfai-miners')
    put(path.join(linuxDir, `DwarfAI-Miners-${VERSION}-x86_64.AppImage`))
    put(path.join(linuxDir, `dwarfai-miners_${VERSION}_amd64.deb`))
    const started = []
    const linux = await checkHostCopy({
      artifactDir: linuxDir,
      ...LINUX,
      run: async (input) => {
        started.push(input.executable)
        return hostFromCopy(input)
      }
    })
    expect(linux.ok).toBe(false)
    expect(linux.detail).toMatch(/linux-unpacked ok/)
    expect(linux.detail).toMatch(/AppImage blocked by SP-03/)
    expect(started.map((file) => path.basename(file))).toEqual(['dwarfai-miners'])

    const macDir = tempDir()
    put(path.join(macDir, 'mac-arm64', 'DwarfAI-Miners.app', 'Contents', 'MacOS', 'DwarfAI-Miners'))
    let macStarted = false
    const mac = await checkHostCopy({
      artifactDir: macDir,
      ...MAC,
      run: async (input) => {
        macStarted = true
        return hostFromCopy(input)
      }
    })
    expect(mac.ok).toBe(false)
    expect(mac.detail).toMatch(/DwarfAI-Miners\.app blocked by SP-03/)
    expect(macStarted, 'a blocked target is not reported from a run').toBe(false)
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
