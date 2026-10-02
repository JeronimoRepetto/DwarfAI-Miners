// layer: L3
// The Node copy preparer over a per-test temporary folder (17 §1.3: real disk in the adapter's own test): an app
// directory with its executable and a `resources` folder, this build's manifest of it, and a copy root.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
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
      uiEnv: {},
      copyRoot,
      log: new RecordingUiLog()
    }),
    sourceDir,
    copyDir: path.join(copyRoot, VERSION),
    breakCopy: () => rmSync(hostManifest)
  }
})
