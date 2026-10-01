import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../../../scripts/os-lane/electronProcess'

/**
 * OS lane, L8 (17 §1.8): the real `ElectronClipboard` behind the window module's `copyText` (A-22, 16 §4.14) in a
 * real Electron process of this platform. The text goes through the `ClipboardPort` to the OS clipboard and is read
 * back from it exactly as written, and `copyText` answers copied.
 *
 * The app is a throwaway one written to a temp folder, with its own `userData` folder, so it never meets a
 * DwarfAI-Miners running on this machine. The clipboard is the OS's, shared with everything else the person runs: the
 * app saves what is on it first, in every format, and puts that back before it quits; it reports only whether the text
 * arrived, never what the clipboard held. The adapter and the use case are the
 * repository's own files, compiled to JavaScript for the run; nothing else of the app is loaded.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCES = {
  'clipboard.mjs': path.join(HERE, 'ElectronClipboard.ts'),
  'actions.mjs': path.join(HERE, '..', 'application', 'nativeActions.ts')
}
const TEXT = 'DwarfAI clipboard check: ünïcode, tabs\tand\nlines'
const READ_BACK_MS = 5_000
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

const BODY = `import { app, clipboard, ClipboardItem } from 'electron'
import { ElectronClipboard } from './clipboard.mjs'
import { createNativeActions } from './actions.mjs'

app.setPath('userData', process.env.DWARFAI_OS_TEST_USER_DATA)
// Electron's clipboard is asynchronous (Electron 44: \`readText\` and \`writeText\` answer promises). The port's
// \`write\` hands the text over and returns, so the read polls until the OS clipboard holds it, or gives up.
async function readUntil(expected) {
  const deadline = Date.now() + ${READ_BACK_MS}
  let read = await clipboard.readText()
  while (read !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    read = await clipboard.readText()
  }
  return read
}

// Everything on the clipboard, in every format it offers, as new items: Electron writes no item read() returned.
async function snapshot() {
  const items = []
  for (const item of await clipboard.read()) {
    const data = {}
    for (const type of item.types) {
      try {
        data[type] = await item.getType(type)
      } catch {}
    }
    if (Object.keys(data).length > 0) items.push(new ClipboardItem(data))
  }
  return items
}

app.whenReady().then(async () => {
  const before = await snapshot()
  const actions = createNativeActions({
    files: { pickMany: async () => [] },
    clipboard: new ElectronClipboard(clipboard),
    opener: { openPath: async () => null, openExternal: async () => {} },
    parentWindow: () => ({ windowId: 0 })
  })
  const text = process.env.DWARFAI_OS_TEST_TEXT
  const answer = actions.copyText(text)
  const read = await readUntil(text)
  if (before.length > 0) await clipboard.write(before)
  else clipboard.clear()
  // Whether it arrived, never the text itself: a run that fails must not print what the person had copied.
  console.log(JSON.stringify({ answer, arrived: read === text }))
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
    writeFileSync(path.join(appDir, name), compiled.code)
  }
  writeFileSync(path.join(appDir, 'body.mjs'), BODY)
  writeFileSync(path.join(appDir, 'main.cjs'), BOOTSTRAP)
  // Written last: Electron reads the entry from it, so the app is complete before anything names it.
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-clipboard-os-test', main: 'main.cjs' })
  )
}

/** Linux runners have no display and no setuid sandbox helper. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []
}

async function copyReachesTheOsClipboard(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-clipboard-'))
  const appDir = path.join(root, 'app')
  const env = {
    DWARFAI_OS_TEST_USER_DATA: path.join(root, 'user-data'),
    DWARFAI_OS_TEST_TEXT: TEXT
  }
  let instance: ElectronProcess | undefined
  try {
    await writeApp(appDir)
    instance = ElectronProcess.start(appDir, env, platformFlags())
    const line = await instance.firstLine(START_TIMEOUT_MS)
    expect(line, 'the app printed its result').not.toBeNull()
    expect(line?.startsWith('error:'), line ?? '').toBe(false)
    expect(JSON.parse(line ?? 'null')).toEqual({ answer: { copied: true }, arrived: true })
    expect(await instance.exited).toBe(0)
  } finally {
    await instance?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

describe.runIf(process.platform === 'win32')('clipboard on Windows', () => {
  it(
    '[ADR-019] copyText through the ClipboardPort writes the text to the OS clipboard and answers copied',
    copyReachesTheOsClipboard,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'darwin')('clipboard on macOS', () => {
  it(
    '[ADR-019] copyText through the ClipboardPort writes the text to the OS clipboard and answers copied',
    copyReachesTheOsClipboard,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'linux')('clipboard on Linux', () => {
  it(
    '[ADR-019] copyText through the ClipboardPort writes the text to the OS clipboard and answers copied',
    copyReachesTheOsClipboard,
    TEST_TIMEOUT_MS
  )
})
