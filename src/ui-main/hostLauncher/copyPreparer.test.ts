// layer: L3
// The Node copy preparer over a per-test temporary folder (17 §1.3: real disk in the adapter's own test): an app
// directory with its executable and a `resources` folder, this build's manifest of it, and a copy root.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCopyPreparer } from './copyPreparer'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { buildManifest, serializeManifest } from './hostManifest'
import { runCopyPreparerContract } from './testing/copyPreparer.contract'

const VERSION = '1.4.0'
const PLATFORM =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

runCopyPreparerContract('createCopyPreparer over a temporary folder', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-copy-preparer-'))
  roots.push(root)
  const sourceDir = path.join(root, 'install', 'DwarfAI-Miners')
  mkdirSync(path.join(sourceDir, 'resources'), { recursive: true })
  writeFileSync(path.join(sourceDir, 'dwarfai-miners'), 'the executable')
  writeFileSync(path.join(sourceDir, 'resources', 'app.asar'), 'the app')
  const hostManifest = path.join(root, 'host-manifest.json')
  writeFileSync(hostManifest, serializeManifest(await buildManifest(sourceDir)))
  const copyRoot = path.join(root, 'copies')
  return {
    prepare: createCopyPreparer({
      execPath: path.join(sourceDir, 'dwarfai-miners'),
      hostManifest,
      appVersion: VERSION,
      platform: PLATFORM,
      build: 'release',
      uiEnv: {},
      copyRoot,
      log: new RecordingUiLog()
    }),
    sourceDir,
    sourceRealDir: realpathSync.native(sourceDir),
    copyDir: path.join(copyRoot, VERSION),
    breakCopy: () => rmSync(hostManifest)
  }
})

describe('which copy root the preparer uses (ADR-002 D5; ADR-005 item 6)', () => {
  // The root follows the UI's environment: LOCALAPPDATA on Windows, XDG_DATA_HOME elsewhere (the Linux rule, so the
  // test never writes under the real home folder on macOS).
  const ROOT_PLATFORM = PLATFORM === 'win32' ? 'win32' : 'linux'
  const ROOT_ENV_NAME = ROOT_PLATFORM === 'win32' ? 'LOCALAPPDATA' : 'XDG_DATA_HOME'
  const PRODUCT_FOLDER = ROOT_PLATFORM === 'win32' ? 'DwarfAI' : 'dwarfai'

  async function preparedUnder(build: 'release' | 'dev'): Promise<{ local: string; copy: string }> {
    const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-copy-root-'))
    roots.push(root)
    const sourceDir = path.join(root, 'install', 'DwarfAI-Miners')
    mkdirSync(path.join(sourceDir, 'resources'), { recursive: true })
    writeFileSync(path.join(sourceDir, 'dwarfai-miners'), 'the executable')
    writeFileSync(path.join(sourceDir, 'resources', 'app.asar'), 'the app')
    const hostManifest = path.join(root, 'host-manifest.json')
    writeFileSync(hostManifest, serializeManifest(await buildManifest(sourceDir)))
    const local = path.join(root, 'local')
    mkdirSync(local)
    const prepared = await createCopyPreparer({
      execPath: path.join(sourceDir, 'dwarfai-miners'),
      hostManifest,
      appVersion: VERSION,
      platform: ROOT_PLATFORM,
      build,
      uiEnv: { [ROOT_ENV_NAME]: local },
      log: new RecordingUiLog()
    })()
    if (!prepared.ok) throw new Error(`not prepared: ${prepared.errCode}`)
    return { local, copy: prepared.contentDir }
  }

  it('[ADR-002, ADR-005, FM-107] a development build copies into host-dev and a release build into host, so neither holds the other copy', async () => {
    const dev = await preparedUnder('dev')
    const release = await preparedUnder('release')

    expect(dev.copy).toBe(path.join(dev.local, PRODUCT_FOLDER, 'host-dev', VERSION))
    expect(release.copy).toBe(path.join(release.local, PRODUCT_FOLDER, 'host', VERSION))
  })
})

// GitHub #1439 follow-up: a Scoop install starts the app through its `current` junction. Electron resolves the app
// archive's real path, so UI main names the Host entry under the real version folder while the executable keeps the
// junction's name; the launcher finds both inside the copy only when the preparer answers both names.
describe('an install reached through a link (a Scoop current junction)', () => {
  it('[ADR-002, SP-03] the preparer answers the linked app directory and its real folder', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-copy-link-'))
    roots.push(root)
    const realDir = path.join(root, 'apps', 'dwarfai-miners', VERSION)
    mkdirSync(path.join(realDir, 'resources'), { recursive: true })
    writeFileSync(path.join(realDir, 'dwarfai-miners'), 'the executable')
    writeFileSync(path.join(realDir, 'resources', 'app.asar'), 'the app')
    const hostManifest = path.join(root, 'host-manifest.json')
    writeFileSync(hostManifest, serializeManifest(await buildManifest(realDir)))
    // A junction on Windows (no privilege needed); the type is ignored on macOS and Linux.
    const linkedDir = path.join(root, 'apps', 'dwarfai-miners', 'current')
    symlinkSync(realDir, linkedDir, 'junction')

    const prepared = await createCopyPreparer({
      execPath: path.join(linkedDir, 'dwarfai-miners'),
      hostManifest,
      appVersion: VERSION,
      platform: PLATFORM,
      build: 'release',
      uiEnv: {},
      copyRoot: path.join(root, 'copies'),
      log: new RecordingUiLog()
    })()

    expect(prepared).toMatchObject({
      ok: true,
      sourceDir: linkedDir,
      sourceRealDir: realpathSync.native(realDir)
    })
  })
})
