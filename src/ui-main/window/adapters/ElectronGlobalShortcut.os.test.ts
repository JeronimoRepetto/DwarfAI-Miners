import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../../../scripts/os-lane/electronProcess'

/**
 * OS lane, L8 (17 §1.8): the real `ElectronGlobalShortcut` over Electron's `globalShortcut` in real Electron processes
 * of this platform (NFR-PLAT-06; 16 §4.14 "`register` → `false` when taken"; TC-049-03). A combination another
 * registrant holds makes `register` answer `false`; once it is released, it registers.
 *
 * The other registrant is, on every OS, a second registrant of the same process (the shape of a double registration,
 * 21 §1 item 4). On Windows it is also another process: the OS refuses a hot key another application holds, while on
 * macOS a combination taken by another application is not reported to the caller (Electron `globalShortcut`
 * documentation: "this call will silently fail"), so only the in-process case is a fact there. Linux needs an X11 or
 * Wayland session for global shortcuts at all, so its leg runs only where one is present.
 *
 * The app is a throwaway one in a temp folder with its own `userData` folder, never a DwarfAI-Miners running here,
 * and the combination is an unusual one, not the app's default. The adapter is the repository's own file, compiled
 * to JavaScript for the run.
 */

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ElectronGlobalShortcut.ts')
const ACCELERATOR = 'Control+Alt+Shift+F11'
const START_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 120_000

const MAIN = `import { app, globalShortcut } from 'electron'
import { ElectronGlobalShortcut } from './adapter.mjs'

app.setPath('userData', process.env.DWARFAI_OS_TEST_USER_DATA)
const accel = process.env.DWARFAI_OS_TEST_ACCELERATOR
app.whenReady().then(() => {
  const holder = new ElectronGlobalShortcut(globalShortcut)
  if (process.env.DWARFAI_OS_TEST_MODE === 'hold') {
    console.log(holder.register(accel, () => {}) ? 'held' : 'not-held')
    return
  }
  if (process.env.DWARFAI_OS_TEST_MODE === 'try') {
    console.log(holder.register(accel, () => {}) ? 'registered' : 'refused')
    holder.unregister(accel)
    app.quit()
    return
  }
  const other = new ElectronGlobalShortcut(globalShortcut)
  const held = holder.register(accel, () => {})
  const second = other.register(accel, () => {})
  holder.unregister(accel)
  const afterRelease = other.register(accel, () => {})
  other.unregister(accel)
  console.log(JSON.stringify({ held, second, afterRelease }))
  app.quit()
})
`

async function writeApp(appDir: string): Promise<void> {
  mkdirSync(appDir, { recursive: true })
  const compiled = await transformWithEsbuild(readFileSync(ADAPTER, 'utf8'), ADAPTER, {
    loader: 'ts',
    format: 'esm'
  })
  writeFileSync(path.join(appDir, 'adapter.mjs'), compiled.code)
  writeFileSync(path.join(appDir, 'main.mjs'), MAIN)
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-global-shortcut-os-test', type: 'module', main: 'main.mjs' })
  )
}

/** Linux runners have no setuid sandbox helper; global shortcuts need the display session, not the sandbox. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox'] : []
}

/** Runs `work` with a throwaway app, starting each process with its own `userData` folder. */
async function withApp(
  work: (start: (mode: string) => ElectronProcess) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-global-shortcut-'))
  const appDir = path.join(root, 'app')
  const started: ElectronProcess[] = []
  const start = (mode: string): ElectronProcess => {
    const env = {
      DWARFAI_OS_TEST_USER_DATA: path.join(root, `user-data-${started.length}`),
      DWARFAI_OS_TEST_ACCELERATOR: ACCELERATOR,
      DWARFAI_OS_TEST_MODE: mode
    }
    const instance = ElectronProcess.start(appDir, env, platformFlags())
    started.push(instance)
    return instance
  }
  try {
    await writeApp(appDir)
    await work(start)
  } finally {
    for (const instance of started) await instance.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function anotherRegistrantInProcess(): Promise<void> {
  await withApp(async (start) => {
    const app = start('same-process')
    const line = await app.firstLine(START_TIMEOUT_MS)
    expect(JSON.parse(line ?? 'null')).toEqual({ held: true, second: false, afterRelease: true })
    expect(await app.exited).toBe(0)
  })
}

async function anotherProcessHoldsIt(): Promise<void> {
  await withApp(async (start) => {
    const holder = start('hold')
    expect(await holder.firstLine(START_TIMEOUT_MS)).toBe('held')

    const other = start('try')
    expect(await other.firstLine(START_TIMEOUT_MS)).toBe('refused')
    expect(await other.exited).toBe(0)

    await holder.stop()
    const afterRelease = start('try')
    expect(await afterRelease.firstLine(START_TIMEOUT_MS)).toBe('registered')
  })
}

const linuxSession = process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined

describe.runIf(process.platform === 'win32')('global shortcut on Windows', () => {
  it(
    '[NFR-PLAT-06] a combination held by another registrant makes register return false',
    anotherRegistrantInProcess,
    TEST_TIMEOUT_MS
  )
  it(
    '[NFR-PLAT-06] a combination another process holds makes register return false until it is released',
    anotherProcessHoldsIt,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'darwin')('global shortcut on macOS', () => {
  it(
    '[NFR-PLAT-06] a combination held by another registrant makes register return false',
    anotherRegistrantInProcess,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'linux' && linuxSession)('global shortcut on Linux', () => {
  it(
    '[NFR-PLAT-06] a combination held by another registrant makes register return false',
    anotherRegistrantInProcess,
    TEST_TIMEOUT_MS
  )
})
