import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, release, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginEntryFor, type EntryCommand, type LoginEntry, type ReadBack } from './loginEntry.ts'

/**
 * Spike S-027-4, L8 on each OS (testing strategy `17` §4; ADR-027 item 7, AMENDMENT-5 and AMENDMENT-6; spike register
 * S-027-4). The packaged builds and the real sign-out and sign-in are the manual half, `clean-vm.md`.
 *
 * Question, scripted half: can the candidate per-user login entry of each OS (Windows: a value under the per-user
 * `Run` key; macOS: a per-user LaunchAgent; Linux: an XDG autostart entry) be written without elevation, read back
 * (present, its command, and whether the person disabled it in the OS's own startup list), start the app with
 * `--background` (tray, no window), and be removed when "Start with the system" turns OFF?
 *
 * The entry has a throwaway name (`…S0274…<random>`) and points at a throwaway Electron app (`backgroundApp.cjs`), so
 * the person's real login entries are never read, changed or removed; it is removed in `finally`. "Starts the app" is
 * proven by running exactly the command the entry stores, the way the OS reads it; that the OS runs it at a real
 * login is the manual half.
 *
 * Kept afterwards as the per-OS login test of ADR-027 item 7 (later: ISSUE-060 `ElectronAutostart.os.test.ts`).
 * Set `S0274_REPORT=<file>`, or `SPIKE_REPORT_DIR=<dir>` (writes `<dir>/S-027-4-<platform>.json`), to write the
 * measurements as JSON. Paths and names in the report are scrubbed (privacy guard).
 */

interface AppEvent {
  readonly event: string
  readonly [key: string]: unknown
}

interface Elevation {
  readonly elevated: boolean
  readonly evidence: string
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const START_TIMEOUT_MS = 60_000
const SUFFIX = randomBytes(4).toString('hex')

let root = ''
let appDir = ''
const report: Record<string, unknown> = {
  spike: 'S-027-4',
  platform: process.platform,
  osRelease: release()
}

/** Replaces machine-specific values, also in their JSON-escaped spelling (privacy guard). */
function scrub(text: string): string {
  let out = text
  for (const [value, placeholder] of [
    [tmpdir(), '<tmp>'],
    [process.cwd(), '<repo>'],
    [homedir(), '<home>'],
    [userInfo().username, '<user>'],
    [SUFFIX, '<suffix>']
  ] as const) {
    if (value === '') continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = out.split(spelling).join(placeholder)
    }
  }
  return out
}

function windowsTool(name: string): string {
  return path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', name)
}

/** Whether this process runs elevated: the Windows integrity level, or root on macOS and Linux. */
function readElevation(): Elevation {
  if (process.platform === 'win32') {
    const csv = execFileSync(windowsTool('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true
    })
    const rid = /"S-1-16-(\d+)"/.exec(csv)?.[1]
    // High integrity (0x3000) or above, or an unreadable level, counts as elevated.
    const elevated = rid === undefined || Number(rid) >= 0x3000
    return { elevated, evidence: `integrity level S-1-16-${rid ?? 'unreadable'}` }
  }
  const uid = process.getuid?.() ?? -1
  return { elevated: uid === 0, evidence: `uid ${uid === 0 ? '0 (root)' : 'not 0'}` }
}

/** Linux runners have no setuid sandbox helper; the throwaway app needs none. */
function platformFlags(): string[] {
  return process.platform === 'linux' ? ['--no-sandbox'] : []
}

/** Runs exactly the command an entry stores, and collects what the app printed. */
async function startStored(
  command: EntryCommand
): Promise<{ code: number | null; events: AppEvent[] }> {
  const env: NodeJS.ProcessEnv = { ...process.env, S0274_USER_DATA: path.join(root, 'user-data') }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(command.executable, [...command.args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.resume()
  const exited = new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code))
  )
  const timer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), START_TIMEOUT_MS)
  )
  try {
    const outcome = await Promise.race([exited, timer])
    const events = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as AppEvent)
    return { code: outcome === 'timeout' ? null : outcome, events }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

function describeRead(back: ReadBack): string {
  return scrub(JSON.stringify(back))
}

function reportFile(): string | null {
  const explicit = process.env['S0274_REPORT']
  if (explicit) return path.resolve(explicit)
  const dir = process.env['SPIKE_REPORT_DIR']
  return dir ? path.resolve(dir, `S-027-4-${process.platform}.json`) : null
}

describe('S-027-4: login autostart entry per OS (ADR-027 item 7)', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0274-'))
    appDir = path.join(root, 'app')
    mkdirSync(appDir)
    copyFileSync(path.join(HERE, 'backgroundApp.cjs'), path.join(appDir, 'main.cjs'))
    writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'dwarfai-s0274-login-spike', main: 'main.cjs' })
    )
    // A syntax error in an Electron main file opens a modal: Node checks it first.
    execFileSync(process.execPath, ['--check', path.join(appDir, 'main.cjs')])
  })

  afterAll(() => {
    const file = reportFile()
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${scrub(JSON.stringify(report, null, 2))}\n`)
    }
    rmSync(root, { recursive: true, force: true })
  })

  it(
    '[S-027-4, ADR-027] the login entry is written without elevation, read back, starts the app with --background and is removed when turned off',
    async () => {
      const elevation = readElevation()
      report['elevation'] = elevation
      expect(
        elevation.elevated,
        `this check proves "without elevation" only when not elevated: ${elevation.evidence}`
      ).toBe(false)
      const command: EntryCommand = {
        executable: ELECTRON,
        args: [appDir, ...platformFlags(), '--background']
      }
      const entry: LoginEntry = loginEntryFor(process.platform, SUFFIX)
      report['entry'] = { kind: entry.kind, location: entry.location }
      try {
        const writeStarted = performance.now()
        expect(
          () => entry.write(command),
          `the entry is written without elevation at ${scrub(entry.location)}`
        ).not.toThrow()
        report['writeMs'] = Math.round(performance.now() - writeStarted)
        const back = entry.read()
        report['readBack'] = back
        expect(back.present, `the entry reads back: ${describeRead(back)}`).toBe(true)
        expect(back.command, `the entry holds the command written: ${describeRead(back)}`).toEqual(
          command
        )
        expect(back.disabledByPerson, `a fresh entry is not disabled: ${describeRead(back)}`).toBe(
          false
        )

        const started = await startStored(back.command ?? command)
        report['started'] = started
        const event = started.events.find((candidate) => candidate.event === 'started')
        const described = JSON.stringify(started)
        expect(
          event?.['background'],
          `the stored command starts the app with --background: ${described}`
        ).toBe(true)
        expect(event?.['windows'], `no window is opened: ${described}`).toBe(0)
        expect(started.code, described).toBe(0)

        entry.remove()
        const removed = entry.read()
        report['afterRemove'] = removed
        expect(removed.present, `turning it off removes the entry: ${describeRead(removed)}`).toBe(
          false
        )
      } finally {
        entry.remove()
      }
    },
    START_TIMEOUT_MS * 2
  )

  it.runIf(process.platform !== 'darwin')(
    '[S-027-4] an entry the person disabled in the OS startup list reads back as not starting',
    () => {
      const entry = loginEntryFor(process.platform, `${SUFFIX}d`)
      try {
        entry.write({ executable: ELECTRON, args: [appDir, '--background'] })
        expect(entry.disableAsPerson(), 'the OS-level switch was set the way the OS sets it').toBe(
          true
        )
        const back = entry.read()
        report['disabledReadBack'] = back
        expect(back.present, describeRead(back)).toBe(true)
        expect(back.disabledByPerson, describeRead(back)).toBe(true)
      } finally {
        entry.remove()
      }
      expect(entry.read().present).toBe(false)
    }
  )
})
