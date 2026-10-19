import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../../../scripts/os-lane/electronProcess'
import { APP_USER_MODEL_ID } from './appUserModelId'

/**
 * OS lane, L8 (17 §1.8; ADR-018 item 7; S-018-1 "AUMID reuse"): the real `ElectronNotificationDisplay` in a real
 * Electron process on Windows, with Electron's own `app.setAppUserModelId` and `Notification.isSupported()`. The
 * Application User Model ID is set, and accepted by Electron, before the first notification is built.
 *
 * Nothing is ever shown: the constructor handed to the adapter records that it was called and builds no OS
 * notification, so the run never puts a toast on the desktop of the machine running the suite. Whether a toast from
 * a windowless process reaches the person is the S-018-1 spike's question (its record, ISSUE-318), not this test's.
 * The app is a throwaway one written to a temp folder, with its own `userData` folder, so it never meets a
 * DwarfAI-Miners running on this machine. The adapter is the repository's own file, compiled to JavaScript for the run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCES = {
  'display.mjs': path.join(HERE, 'ElectronNotificationDisplay.ts'),
  'appUserModelId.mjs': path.join(HERE, 'appUserModelId.ts')
}
const WATCHDOG_MS = 20_000
const START_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 120_000

/**
 * The entry Electron loads: CommonJS, so a failure to load the test body is caught here instead of reaching Electron's
 * own handler, which shows a modal error dialog. Any failure, and a run that hangs, prints one `error:` line and exits
 * non-zero; the test then fails on that line.
 */
const BOOTSTRAP = `const { app } = require('electron')
const fail = (error) => {
  console.log('error: ' + String((error && error.stack) || error).replace(/\\s+/g, ' '))
  app.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
setTimeout(() => fail(new Error('no result within ${WATCHDOG_MS} ms')), ${WATCHDOG_MS})
import('./body.mjs').catch(fail)
`

const BODY = `import { app, Notification } from 'electron'
import { ElectronNotificationDisplay } from './display.mjs'

app.setPath('userData', process.env.DWARFAI_OS_TEST_USER_DATA)

app.whenReady().then(() => {
  const calls = []
  // Builds no OS notification: it records the call and hands back an inert object (nothing reaches the desktop).
  class RecordingConstructor {
    constructor() {
      calls.push('construct')
    }
    show() {}
    close() {}
    on() {}
    static isSupported() {
      return Notification.isSupported()
    }
  }
  const records = []
  const display = new ElectronNotificationDisplay({
    notification: RecordingConstructor,
    platform: 'win32',
    setAppUserModelId: (id) => {
      app.setAppUserModelId(id)
      calls.push('aumid:' + id)
    },
    log: { record: (entry) => records.push(entry.event + ':' + (entry.errCode ?? entry.outcome)) }
  })
  display.show({ key: 'k1', title: 't', body: 'b' }, () => {})
  display.show({ key: 'k2', title: 't', body: 'b' }, () => {})
  console.log(JSON.stringify({ supported: Notification.isSupported(), calls, records }))
  app.quit()
})
`

async function writeApp(appDir: string): Promise<void> {
  mkdirSync(appDir, { recursive: true })
  for (const [name, source] of Object.entries(SOURCES)) {
    const compiled = await transformWithEsbuild(readFileSync(source, 'utf8'), source, {
      loader: 'ts',
      format: 'esm'
    })
    // The compiled modules import each other by their emitted names.
    writeFileSync(
      path.join(appDir, name),
      compiled.code.replace(/from\s+(['"])\.\/appUserModelId\1/g, "from './appUserModelId.mjs'")
    )
  }
  writeFileSync(path.join(appDir, 'body.mjs'), BODY)
  writeFileSync(path.join(appDir, 'main.cjs'), BOOTSTRAP)
  // Written last: Electron reads the entry from it, so the app is complete before anything names it.
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-notification-os-test', main: 'main.cjs' })
  )
}

describe.runIf(process.platform === 'win32')('notification display on Windows', () => {
  it(
    '[S-018-1] the AUMID is set before the first notification',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-notification-'))
      const appDir = path.join(root, 'app')
      let instance: ElectronProcess | undefined
      try {
        await writeApp(appDir)
        instance = ElectronProcess.start(appDir, {
          DWARFAI_OS_TEST_USER_DATA: path.join(root, 'user-data')
        })
        const line = await instance.firstLine(START_TIMEOUT_MS)
        expect(line, 'the app printed its result').not.toBeNull()
        expect(line?.startsWith('error:'), line ?? '').toBe(false)
        expect(JSON.parse(line ?? 'null')).toEqual({
          supported: true,
          calls: [`aumid:${APP_USER_MODEL_ID}`, 'construct', 'construct'],
          records: ['notification.display:ok', 'notification.display:ok']
        })
        expect(await instance.exited).toBe(0)
      } finally {
        await instance?.stop()
        rmSync(root, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS
  )
})
