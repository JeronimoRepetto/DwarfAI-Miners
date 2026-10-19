import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * A launch of a newer build (AMENDMENT-25, 16 §4.14 as amended): the running instance, with the real second-launch
 * use case, replaces itself with it — the newer launch is turned away and quits, the running instance quits, and the
 * newer launch's own program, started again by Electron's relaunch, takes the lock.
 *
 * The app is a throwaway one written to a temp folder, with its own `userData` folder (Electron
 * ties the lock to it), so it never meets a DwarfAI-Miners running on this machine. The adapter, the second-launch
 * use case and the version rule are the repository's own files, compiled to JavaScript for the run; nothing else of
 * the app is loaded.
 */

const WINDOW = path.join(path.dirname(fileURLToPath(import.meta.url)), 'window')
const SOURCES = [
  { from: path.join(WINDOW, 'adapters', 'ElectronSingleInstanceLock.ts'), to: 'lock.mjs' },
  { from: path.join(WINDOW, 'application', 'secondLaunch.ts'), to: 'secondLaunch.mjs' },
  { from: path.join(WINDOW, 'domain', 'appVersion.ts'), to: 'appVersion.mjs' }
] as const
/** The one import between the compiled files that is not a type: the use case's version rule. */
const IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ['../domain/appVersion', './appVersion.mjs']
]
const LAUNCHES = 3
const START_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 180_000

// Flags carry what a run needs, so a program Electron starts again with the same arguments gets it too: the
// version the launch is of, the file each process reports its lock answer to, and when a process ends on its own.
const MAIN = `import { app } from 'electron'
import { appendFileSync } from 'node:fs'
import { ElectronSingleInstanceLock } from './lock.mjs'
import { wireSecondLaunch } from './secondLaunch.mjs'

const flag = (name) => process.argv.find((arg) => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
const version = flag('test-version')
const report = flag('test-report')
const exitAfter = Number(flag('test-exit-after-ms') ?? 120000)
app.setPath('userData', flag('test-user-data') ?? process.env.DWARFAI_OS_TEST_USER_DATA)
const lock = new ElectronSingleInstanceLock(app)
const acquired = version === undefined ? lock.acquire() : lock.acquire({ appVersion: version })
if (report !== undefined) appendFileSync(report, (acquired ? 'acquired ' : 'denied ') + version + ' ' + process.pid + '\\n')
if (!acquired) {
  console.log('denied')
  app.quit()
} else {
  if (version === undefined) lock.onSecondLaunch(() => console.log('second-instance'))
  else wireSecondLaunch(lock, { appVersion: version }).attach({ show: () => console.log('shown') })
  console.log('acquired')
  // Never outlives the run: a process Electron started again is not one the test holds.
  setTimeout(() => app.exit(0), exitAfter)
}
`

async function writeApp(appDir: string): Promise<void> {
  mkdirSync(appDir, { recursive: true })
  for (const source of SOURCES) {
    const compiled = await transformWithEsbuild(readFileSync(source.from, 'utf8'), source.from, {
      loader: 'ts',
      format: 'esm'
    })
    let code = compiled.code
    // esbuild prints string literals with either quote; the specifier is rewritten in both.
    for (const [from, to] of IMPORTS) {
      code = code.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`)
    }
    writeFileSync(path.join(appDir, source.to), code)
  }
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

/** The lock answers the processes of a run reported, in order: `acquired|denied <version> <pid>`. */
function reported(file: string): string[][] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => line.split(' '))
}

async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const RUNNING = '0.13.1'
const NEWER = '0.13.2'

async function aNewerLaunchReplacesTheRunningInstance(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-single-instance-'))
  const appDir = path.join(root, 'app')
  const report = path.join(root, 'lock-answers.txt')
  const flagsOf = (version: string, extra: readonly string[] = []): string[] => [
    `--test-user-data=${path.join(root, 'user-data')}`,
    `--test-report=${report}`,
    `--test-version=${version}`,
    ...extra,
    ...platformFlags()
  ]
  const started: ElectronProcess[] = []
  const start = (flags: string[]): ElectronProcess => {
    const instance = ElectronProcess.start(appDir, {}, flags)
    started.push(instance)
    return instance
  }
  let relaunched: number | undefined
  try {
    await writeApp(appDir)
    const running = start(flagsOf(RUNNING))
    expect(await running.firstLine(START_TIMEOUT_MS), running.describe()).toBe('acquired')

    // A launch of the same build only brings the running instance forward (ADR-002 D3).
    const same = start(flagsOf(RUNNING))
    expect(await same.firstLine(START_TIMEOUT_MS), same.describe()).toBe('denied')
    expect(await same.exited).toBe(0)
    expect(await running.count('shown', 1, START_TIMEOUT_MS), running.describe()).toBe(1)
    expect(running.running).toBe(true)

    // A launch of a newer build is turned away and quits, the running instance quits, and the newer launch's own
    // program, started again, takes the lock (AMENDMENT-25).
    const newer = start(flagsOf(NEWER, ['--test-exit-after-ms=2000']))
    expect(await newer.firstLine(START_TIMEOUT_MS), newer.describe()).toBe('denied')
    expect(await newer.exited).toBe(0)
    expect(await running.exited, running.describe()).toBe(0)
    expect(running.lines.filter((line) => line === 'shown')).toEqual(['shown'])
    const taken = await until(
      () =>
        reported(report).find(([answer, version]) => answer === 'acquired' && version === NEWER),
      START_TIMEOUT_MS
    )
    relaunched = taken === undefined ? undefined : Number(taken[2])
    expect(reported(report).map(([answer, version]) => `${answer} ${version}`)).toEqual([
      `acquired ${RUNNING}`,
      `denied ${RUNNING}`,
      `denied ${NEWER}`,
      `acquired ${NEWER}`
    ])
    // The one holding the lock now is a new process, not the newer launch that was turned away.
    const turnedAway = reported(report).find(
      ([answer, version]) => answer === 'denied' && version === NEWER
    )
    expect(relaunched).not.toBe(Number(turnedAway?.[2]))
  } finally {
    for (const instance of started) await instance.stop()
    // The program Electron started again ends on its own (--test-exit-after-ms); it is ended here only if it did not.
    if (relaunched !== undefined) {
      const pid = relaunched
      if ((await until(() => (alive(pid) ? undefined : true), START_TIMEOUT_MS)) === undefined) {
        process.kill(pid)
      }
    }
    // Its helper processes may still be closing their files in the folder for a moment.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}

describe.runIf(process.platform === 'win32')('single instance on Windows', () => {
  it(
    '[US-RES-008.AC03, FM-138, NFR-PLAT-07] a real second process exits at once and the first instance receives second-instance each time',
    secondProcessesAreTurnedAway,
    TEST_TIMEOUT_MS
  )

  it(
    '[ADR-002, US-RES-008.AC03, NFR-PLAT-07] a real launch of a newer build makes the running instance quit and its own program take the lock, while a launch of the same build only brings it forward',
    aNewerLaunchReplacesTheRunningInstance,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'darwin')('single instance on macOS', () => {
  it(
    '[US-RES-008.AC03, FM-138, NFR-PLAT-07] a real second process exits at once and the first instance receives second-instance each time',
    secondProcessesAreTurnedAway,
    TEST_TIMEOUT_MS
  )

  it(
    '[ADR-002, US-RES-008.AC03, NFR-PLAT-07] a real launch of a newer build makes the running instance quit and its own program take the lock, while a launch of the same build only brings it forward',
    aNewerLaunchReplacesTheRunningInstance,
    TEST_TIMEOUT_MS
  )
})

describe.runIf(process.platform === 'linux')('single instance on Linux', () => {
  it(
    '[US-RES-008.AC03, FM-138, NFR-PLAT-07] a real second process exits at once and the first instance receives second-instance each time',
    secondProcessesAreTurnedAway,
    TEST_TIMEOUT_MS
  )

  it(
    '[ADR-002, US-RES-008.AC03, NFR-PLAT-07] a real launch of a newer build makes the running instance quit and its own program take the lock, while a launch of the same build only brings it forward',
    aNewerLaunchReplacesTheRunningInstance,
    TEST_TIMEOUT_MS
  )
})
