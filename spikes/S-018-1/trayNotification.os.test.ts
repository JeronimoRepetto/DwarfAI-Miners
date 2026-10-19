import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, release, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { ElectronProcess } from '../../scripts/os-lane/electronProcess'

/**
 * Spike S-018-1, L8 on each OS plus a manual run per Linux desktop (testing strategy `17` §4; ADR-018 item 5; spike
 * register S-018-1).
 *
 * Question: can the UI process, running in tray mode with no window open, show a level-3 notification and receive
 * its click, on Windows 11, macOS and the Linux desktops? Which Linux desktops have no tray?
 *
 * `trayApp.cjs` is a throwaway Electron app that never creates a window: it creates a tray icon, reports whether
 * notifications are supported, sits idle, and then, depending on `S0181_MODE`, shows one notification:
 * - unset or `none` (the default, and the only mode used on a person's desktop without them knowing): no notification
 *   is ever shown. The test proves the windowless tray process itself;
 * - `record` (the CI legs, whose desktop is nobody's): one notification is shown and its outcome (`show`, `failed`, or
 *   nothing before the timeout) is recorded, never asserted, since no one can click it;
 * - `click` (the manual guide `linux-desktops.md`, a person present): one notification is shown and the person clicks
 *   it; the test asserts the click reached the windowless tray process. `S0181_IDLE_MS` sets how long the process
 *   sits idle first (the register's "click activation after the process was idle").
 *
 * On Linux the harness also asks the session bus whether a StatusNotifier watcher (the tray host) and a notification
 * server are present (`gdbus`), and records the desktop.
 *
 * Kept afterwards as the regression test the register names (E2E tray notification, ADR-018; later: ISSUE-113).
 * Set `S0181_REPORT=<file>`, or `SPIKE_REPORT_DIR=<dir>` (writes `<dir>/S-018-1-<platform>-<mode>.json`), to write
 * what the app reported as JSON. Paths in the report are scrubbed (privacy guard).
 */

type Mode = 'none' | 'record' | 'click'

interface AppEvent {
  readonly event: string
  readonly [key: string]: unknown
}

interface AppRun {
  readonly mode: Mode
  readonly exitCode: number | null
  readonly events: readonly AppEvent[]
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODE: Mode = parseMode(process.env['S0181_MODE'])
const IDLE_MS = Number(process.env['S0181_IDLE_MS'] ?? 1500)
const WAIT_MS = Number(process.env['S0181_WAIT_MS'] ?? (MODE === 'click' ? 120_000 : 15_000))
const START_TIMEOUT_MS = 60_000
const runs: AppRun[] = []

function parseMode(value: string | undefined): Mode {
  if (value === 'record' || value === 'click') return value
  return 'none'
}

/** Replaces machine-specific values, also in their JSON-escaped spelling (privacy guard). */
function scrub(text: string): string {
  let out = text
  for (const [value, placeholder] of [
    [tmpdir(), '<tmp>'],
    [process.cwd(), '<repo>'],
    [homedir(), '<home>'],
    [userInfo().username, '<user>']
  ] as const) {
    if (value === '') continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = out.split(spelling).join(placeholder)
    }
  }
  return out
}

/** Linux runners have no setuid sandbox helper; the tray and notifications need none. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox'] : []
}

function parseEvents(lines: readonly string[]): AppEvent[] {
  const events: AppEvent[] = []
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line) as AppEvent)
    } catch {
      // Not one of the app's lines.
    }
  }
  return events
}

/** Writes the app to a temp folder, checks its syntax with Node first (a syntax error in main opens a modal), runs it. */
async function runApp(mode: Mode): Promise<AppRun> {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0181-'))
  const appDir = path.join(root, 'app')
  mkdirSync(appDir)
  copyFileSync(path.join(HERE, 'trayApp.cjs'), path.join(appDir, 'main.cjs'))
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dwarfai-s0181-tray-spike', main: 'main.cjs' })
  )
  execFileSync(process.execPath, ['--check', path.join(appDir, 'main.cjs')])
  const app = ElectronProcess.start(
    appDir,
    {
      S0181_MODE: mode,
      S0181_IDLE_MS: String(IDLE_MS),
      S0181_WAIT_MS: String(WAIT_MS),
      S0181_USER_DATA: path.join(root, 'user-data')
    },
    platformFlags()
  )
  try {
    const deadline = Date.now() + START_TIMEOUT_MS + IDLE_MS + WAIT_MS
    while (app.running && Date.now() < deadline) await sleep(100)
    const exitCode = app.running ? null : await app.exited
    const run: AppRun = { mode, exitCode, events: parseEvents(app.lines) }
    runs.push(run)
    if (exitCode === null) throw new Error(`the tray app did not finish in time\n${app.describe()}`)
    return run
  } finally {
    await app.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

function eventOf(run: AppRun, name: string): AppEvent | undefined {
  return run.events.find((event) => event.event === name)
}

/** One `gdbus` call on the session bus, or the reason it could not be made. */
function gdbus(args: readonly string[]): string {
  try {
    return execFileSync('gdbus', ['call', '--session', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000
    }).trim()
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    return `unavailable: ${(failure.stderr ?? failure.message).trim().split('\n')[0] ?? ''}`
  }
}

function linuxDesktop(): Record<string, string> {
  const hasOwner = (name: string): string =>
    gdbus([
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.NameHasOwner',
      name
    ])
  return {
    XDG_CURRENT_DESKTOP: process.env['XDG_CURRENT_DESKTOP'] ?? '(unset)',
    XDG_SESSION_TYPE: process.env['XDG_SESSION_TYPE'] ?? '(unset)',
    DESKTOP_SESSION: process.env['DESKTOP_SESSION'] ?? '(unset)',
    statusNotifierWatcher: hasOwner('org.kde.StatusNotifierWatcher'),
    notificationServer: hasOwner('org.freedesktop.Notifications'),
    notificationServerInformation: gdbus([
      '--dest',
      'org.freedesktop.Notifications',
      '--object-path',
      '/org/freedesktop/Notifications',
      '--method',
      'org.freedesktop.Notifications.GetServerInformation'
    ])
  }
}

function reportFile(): string | null {
  const explicit = process.env['S0181_REPORT']
  if (explicit) return path.resolve(explicit)
  const dir = process.env['SPIKE_REPORT_DIR']
  return dir ? path.resolve(dir, `S-018-1-${process.platform}-${MODE}.json`) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('S-018-1: notification from a windowless tray process (ADR-018 item 5)', () => {
  afterAll(() => {
    const file = reportFile()
    if (!file) return
    mkdirSync(path.dirname(file), { recursive: true })
    const report = {
      spike: 'S-018-1',
      platform: process.platform,
      osRelease: release(),
      mode: MODE,
      idleMs: IDLE_MS,
      waitMs: WAIT_MS,
      desktop: process.platform === 'linux' ? linuxDesktop() : null,
      runs
    }
    writeFileSync(file, `${scrub(JSON.stringify(report, null, 2))}\n`)
  })

  it(
    '[S-018-1, ADR-018] a windowless tray process stays up with no window and holds its tray icon',
    async () => {
      const run = await runApp('none')
      const described = JSON.stringify(run.events)
      expect(eventOf(run, 'tray')?.['ok'], `the tray icon was created: ${described}`).toBe(true)
      expect(
        eventOf(run, 'idle')?.['windows'],
        `no window after ${String(IDLE_MS)} ms idle: ${described}`
      ).toBe(0)
      expect(eventOf(run, 'done'), `the app ran to its end: ${described}`).toBeDefined()
      expect(run.exitCode, described).toBe(0)
    },
    START_TIMEOUT_MS * 2
  )

  it.runIf(MODE === 'record')(
    '[S-018-1] an unattended notification from the windowless tray process reaches a recorded outcome',
    async () => {
      const run = await runApp('record')
      const described = JSON.stringify(run.events)
      const outcome = run.events.find((event) =>
        ['show', 'failed', 'timeout'].includes(event.event)
      )
      expect(outcome, `show, failed or timeout was reported: ${described}`).toBeDefined()
      expect(eventOf(run, 'idle')?.['windows'], described).toBe(0)
      expect(run.exitCode, described).toBe(0)
    },
    START_TIMEOUT_MS * 2 + WAIT_MS
  )

  it.runIf(MODE === 'click')(
    '[S-018-1, ADR-018] with no window open the tray process shows a notification and its click reaches the tray process',
    async () => {
      const run = await runApp('click')
      const described = JSON.stringify(run.events)
      expect(eventOf(run, 'idle')?.['windows'], described).toBe(0)
      const click = eventOf(run, 'click')
      expect(
        click,
        `the click reached the tray process within ${String(WAIT_MS)} ms: ${described}`
      ).toBeDefined()
      expect(click?.['windows'], `still no window when the click arrived: ${described}`).toBe(0)
      expect(run.exitCode, described).toBe(0)
    },
    START_TIMEOUT_MS * 2 + IDLE_MS + WAIT_MS
  )
})
