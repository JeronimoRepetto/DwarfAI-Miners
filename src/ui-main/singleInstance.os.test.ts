import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../scripts/os-lane/electronProcess'

/**
 * OS lane, L8 (17 §1.8): the real `ElectronSingleInstanceLock` in real Electron processes of this
 * platform (NFR-PLAT-07). A first instance takes the lock; each further process started with the
 * same app identity cannot take it and quits at once, and the first instance receives
 * `second-instance` every time (US-RES-008.AC03, FM-138, UC-033).
 *
 * The app is a throwaway one written to a temp folder, with its own `userData` folder (Electron
 * ties the lock to it), so it never meets a DwarfAI-Miners running on this machine. The adapter is
 * the repository's own file, compiled to JavaScript for the run; nothing else of the app is loaded.
 */

const ADAPTER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'window',
  'adapters',
  'ElectronSingleInstanceLock.ts'
)
const LAUNCHES = 3
const START_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 180_000

const MAIN = `import { app } from 'electron'
import { ElectronSingleInstanceLock } from './lock.mjs'

app.setPath('userData', process.env.DWARFAI_OS_TEST_USER_DATA)
const lock = new ElectronSingleInstanceLock(app)
if (!lock.acquire()) {
  console.log('denied')
  app.quit()
} else {
  lock.onSecondLaunch(() => console.log('second-instance'))
  console.log('acquired')
}
`

async function writeApp(appDir: string): Promise<void> {
  mkdirSync(appDir, { recursive: true })
  const compiled = await transformWithEsbuild(readFileSync(ADAPTER, 'utf8'), ADAPTER, {
    loader: 'ts',
    format: 'esm'
  })
  writeFileSync(path.join(appDir, 'lock.mjs'), compiled.code)
  writeFileSync(path.join(appDir, 'main.mjs'), MAIN)
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-single-instance-os-test', type: 'module', main: 'main.mjs' })
  )
}

/** Linux runners have no display and no setuid sandbox helper; the lock needs neither. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []
}

async function secondProcessesAreTurnedAway(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-single-instance-'))
  const appDir = path.join(root, 'app')
  const env = { DWARFAI_OS_TEST_USER_DATA: path.join(root, 'user-data') }
  const started: ElectronProcess[] = []
  const start = (): ElectronProcess => {
    const instance = ElectronProcess.start(appDir, env, platformFlags())
    started.push(instance)
    return instance
  }
  try {
    await writeApp(appDir)
    const first = start()
    expect(await first.firstLine(START_TIMEOUT_MS)).toBe('acquired')

    for (let launch = 1; launch <= LAUNCHES; launch += 1) {
      const second = start()
      expect(await second.firstLine(START_TIMEOUT_MS)).toBe('denied')
      expect(await second.exited).toBe(0)
      expect(await first.count('second-instance', launch, START_TIMEOUT_MS)).toBe(launch)
    }

    expect(first.running).toBe(true)
  } finally {
    for (const instance of started) await instance.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

describe.runIf(process.platform === 'win32')('single instance on Windows', () => {
  it(
    '[US-RES-008.AC03, FM-138, NFR-PLAT-07] a real second process exits at once and the first instance receives second-instance each time',
    secondProcessesAreTurnedAway,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'darwin')('single instance on macOS', () => {
  it(
    '[US-RES-008.AC03, FM-138, NFR-PLAT-07] a real second process exits at once and the first instance receives second-instance each time',
    secondProcessesAreTurnedAway,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'linux')('single instance on Linux', () => {
  it(
    '[US-RES-008.AC03, FM-138, NFR-PLAT-07] a real second process exits at once and the first instance receives second-instance each time',
    secondProcessesAreTurnedAway,
    TEST_TIMEOUT_MS
  )
})
