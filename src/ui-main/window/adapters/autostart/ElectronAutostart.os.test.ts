import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../../../../scripts/os-lane/electronProcess'
import { loginEntryOffered } from '../../domain/loginEntryGate'
import { currentUiPlatform } from '../ElectronScreenArea'

/**
 * OS lane, L8 (17 §1.8; TC-060-04): the real `ElectronAutostart` in a real Electron process of this platform writes the
 * login entry, reads it back pointing at the launch path with `--background`, and removes it (ADR-027 item 7). The leg
 * runs on an OS once spike S-027-4 has passed there (`loginEntryGate.ts`); before that, only when
 * `DWARFAI_OS_TEST_LOGIN_ENTRY=1` asks for it by hand.
 *
 * The app is a throwaway one in a temp folder with its own `userData` folder, never a DwarfAI-Miners installed or
 * running here. Its entry has a name of its own, never the app's (`DwarfAI-OS-Test-<random>`): on Windows a per-user
 * Run value of that name, on Linux an XDG entry under a temporary `XDG_CONFIG_HOME`. The app removes it before it
 * exits, and the test starts it once more to remove it whatever happened (`finally`). The main script is CommonJS with
 * a bootstrap that prints any load error and exits non-zero, so nothing can open a dialog.
 */

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ElectronAutostart.ts')
const START_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 120_000

const MAIN = `'use strict'
process.on('uncaughtException', (error) => {
  console.log(JSON.stringify({ error: String((error && (error.code || error.name)) || error) }))
  process.exit(1)
})
const { app } = require('electron')
let ElectronAutostart
try {
  ElectronAutostart = require('./adapter.cjs').ElectronAutostart
} catch (error) {
  console.log(JSON.stringify({ error: 'adapter-load', detail: String(error) }))
  app.exit(1)
}
app.setPath('userData', process.env.DWARFAI_OS_TEST_USER_DATA)
app.whenReady().then(() => {
  const platform =
    process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
  const name = process.env.DWARFAI_OS_TEST_ENTRY_NAME
  const autostart = new ElectronAutostart({
    platform,
    app,
    launchPath: process.execPath,
    args: ['--background'],
    name,
    home: process.env.DWARFAI_OS_TEST_HOME,
    env: { XDG_CONFIG_HOME: process.env.DWARFAI_OS_TEST_XDG }
  })
  const result = {}
  try {
    if (process.env.DWARFAI_OS_TEST_MODE === 'remove') {
      autostart.set(false)
      result.removed = !autostart.get()
      return
    }
    autostart.set(true)
    result.afterOn = autostart.get()
    if (platform === 'win32') {
      const item = app
        .getLoginItemSettings({ path: process.execPath, args: ['--background'] })
        .launchItems.find((candidate) => candidate.name === name)
      result.entry = item && { path: item.path, args: item.args, enabled: item.enabled }
    }
    autostart.set(false)
    result.afterOff = autostart.get()
  } catch (error) {
    result.error = String((error && (error.code || error.name)) || error)
  } finally {
    try {
      autostart.set(false)
    } catch {}
    console.log(JSON.stringify(result))
    app.quit()
  }
})
`

async function writeApp(appDir: string): Promise<void> {
  mkdirSync(appDir, { recursive: true })
  const compiled = await transformWithEsbuild(readFileSync(ADAPTER, 'utf8'), ADAPTER, {
    loader: 'ts',
    format: 'cjs'
  })
  writeFileSync(path.join(appDir, 'adapter.cjs'), compiled.code)
  writeFileSync(path.join(appDir, 'main.cjs'), MAIN)
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-autostart-os-test', main: 'main.cjs' })
  )
}

/** Linux runners have no setuid sandbox helper; the entry needs files, not the sandbox. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox'] : []
}

async function writeReadRemove(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-autostart-'))
  const appDir = path.join(root, 'app')
  const xdg = path.join(root, 'config')
  const name = `DwarfAI-OS-Test-${randomBytes(4).toString('hex')}`
  const started: ElectronProcess[] = []
  const start = (mode: string): ElectronProcess => {
    const instance = ElectronProcess.start(
      appDir,
      {
        DWARFAI_OS_TEST_USER_DATA: path.join(root, `user-data-${started.length}`),
        DWARFAI_OS_TEST_ENTRY_NAME: name,
        DWARFAI_OS_TEST_HOME: root,
        DWARFAI_OS_TEST_XDG: xdg,
        DWARFAI_OS_TEST_MODE: mode
      },
      platformFlags()
    )
    started.push(instance)
    return instance
  }
  try {
    await writeApp(appDir)
    const run = start('write-read-remove')
    const result = JSON.parse((await run.firstLine(START_TIMEOUT_MS)) ?? 'null') as {
      afterOn?: boolean
      afterOff?: boolean
      entry?: { path: string; args: string[]; enabled: boolean }
      error?: string
    } | null
    expect(await run.exited).toBe(0)
    expect(result?.error).toBeUndefined()
    expect(result).toMatchObject({ afterOn: true, afterOff: false })
    if (process.platform === 'win32') {
      // Electron reads the Run value's arguments back without the first one, so `--background` is not readable here
      // (ElectronAutostart.ts); the value's name, launch path and Startup apps switch are.
      expect(result?.entry?.enabled).toBe(true)
      expect(result?.entry?.path.toLowerCase()).toContain('electron')
    }
  } finally {
    // Whatever happened above, the entry is removed before the folder goes.
    try {
      const cleanup = start('remove')
      await cleanup.firstLine(START_TIMEOUT_MS)
    } finally {
      for (const instance of started) await instance.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const legOpen =
  loginEntryOffered(currentUiPlatform()) || process.env.DWARFAI_OS_TEST_LOGIN_ENTRY === '1'

describe.runIf(legOpen)('the login entry on this OS (S-027-4)', () => {
  it(
    '[S-027-4] set true then get reads the entry back pointing at the channel launch path; set false removes it',
    writeReadRemove,
    TEST_TIMEOUT_MS
  )
})
