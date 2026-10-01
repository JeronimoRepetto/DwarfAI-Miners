// The legacy seam-A replay (21 §2 note 1; ISSUE-056): one run of the scenario of every `legacy` row
// (`fixtures/ipc/seam-a-replay/<release>/scenario.json`) against the simulated fixture world, through the renderer's
// own `window.api` in the app's window, so each call crosses the whole seam A of the build: its preload, its main
// process (the router and `LegacyRuntimeRoute` on a cut build, today's handlers on the pre-cut build) and back.
//
// `record-seam-a.mjs` runs it on the pre-cut build and writes the recording; `e2e/cut-0/seam-a-replay.e2e.ts` runs it
// on the cut build and compares the canonical bytes. Shared here so both sides run exactly the same steps. Plain
// erasable TypeScript, so Node runs it as it is (type stripping) for the recorder.
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication, Page } from '@playwright/test'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** One call of the scenario: a `legacy` row's `window.api` member and its arguments. */
export interface ScenarioCall {
  row: string
  channel: string
  member: string
  args: unknown[]
}

/** One push row of the scenario, listened to through its `window.api` member. */
export interface ScenarioPush {
  row: string
  channel: string
  member: string
}

export interface Scenario {
  about: string
  /** The simulated fixture world (`DWARFAI_SIMULATE*`, docs/simulated-provider.md). */
  world: Record<string, string>
  calls: ScenarioCall[]
  pushes: ScenarioPush[]
}

/** What one run observed: each call's answer, and each push row's distinct payloads in the order first seen. */
export interface ScenarioRun {
  calls: Array<{ row: string; channel: string; member: string; answer: unknown }>
  pushes: Record<string, unknown[]>
}

/** The fixture folder of a release's replay. */
export function replayDir(release: string): string {
  return path.join(REPO_ROOT, 'fixtures', 'ipc', 'seam-a-replay', release)
}

/** The scenario of a release: the calls, the pushes listened to and the fixture world. */
export function readScenario(release: string): Scenario {
  return JSON.parse(
    readFileSync(path.join(replayDir(release), 'scenario.json'), 'utf8')
  ) as Scenario
}

/** How long the world is left alone before and after the calls, so the pushes it sends settle. */
const SETTLE_MS = 3_000

/**
 * The environment of a replay run: the simulated fixture world, and every per-user folder the app reads or writes
 * pointed into the profile, so no run reads the developer's own sessions, settings or provider data, and none writes
 * outside the profile (17 §1.4: a recording holds nothing of the machine it was made on).
 */
export function replayEnv(scenario: Scenario, profileRoot: string): Record<string, string> {
  const home = path.join(profileRoot, 'home')
  mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  return {
    ...scenario.world,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state')
  }
}

/** The stub CLIs every replay run has installed (ISSUE-313 kit), so each machine detects the same providers. */
export const REPLAY_STUBS = ['claude', 'codex', 'opencode'] as const

/**
 * The app's whole `PATH` in a replay run: the stub CLIs, the folder of the Node that runs them (the stubs are Node
 * scripts), and the OS's own folders, nothing of the person's, so provider detection answers the same everywhere.
 */
export function replayPath(stubDirs: string): string {
  const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`
  const os =
    process.platform === 'win32'
      ? [
          path.join(systemRoot, 'System32'),
          systemRoot,
          path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
        ]
      : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [stubDirs, path.dirname(process.execPath), ...os].join(path.delimiter)
}

/** The recording of a release made on this OS (the mine ids of the simulated world carry the OS's separator). */
export function recordingFile(release: string, platform: string = process.platform): string {
  return path.join(replayDir(release), `recording.${platform}.json`)
}

/**
 * The fields whose values are the wall clock of the run, not an answer of the seam (the simulated world dates its
 * mines by the time it started): each is compared as the marker `<wall-clock>`, and this list is recorded in
 * `docs/strangler/parity-cut-0.md`. Nothing else is masked.
 */
export const WALL_CLOCK_KEYS: readonly string[] = ['updatedAt']

function maskWallClock(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskWallClock)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      WALL_CLOCK_KEYS.includes(key) && typeof field === 'number'
        ? '<wall-clock>'
        : maskWallClock(field)
    ])
  )
}

/**
 * The part of a run the replay compares: every answer, and per push row its distinct payloads in the order first
 * seen, each with its wall-clock fields masked (a push the world repeats with only a newer time is the same push).
 */
export function comparableRun(run: ScenarioRun): ScenarioRun {
  const pushes: Record<string, unknown[]> = {}
  for (const [channel, payloads] of Object.entries(run.pushes)) {
    const distinct: unknown[] = []
    for (const payload of payloads.map(maskWallClock)) {
      const text = JSON.stringify(payload)
      if (!distinct.some((seen) => JSON.stringify(seen) === text)) distinct.push(payload)
    }
    pushes[channel] = distinct
  }
  return {
    calls: run.calls.map((call) => ({ ...call, answer: maskWallClock(call.answer) })),
    pushes
  }
}

/** The bytes the replay compares. */
export function comparable(run: ScenarioRun): string {
  return canonicalJson(comparableRun(run))
}

/**
 * Keeps the run off the desktop and off the network: the OS pickers answer "cancelled" (A-30's folder picker), and a
 * path or link is never opened. Installed in the main process through Playwright, never by production code (R14).
 * The same object every build's main process uses, so both sides are patched alike.
 */
export async function keepOffTheDesktop(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, shell }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    shell.openPath = async () => ''
    shell.openExternal = async () => {}
  })
}

/** The renderer's `window.api` as the scenario calls it: members by name. */
interface ReplayWindow {
  api: Record<string, (...args: unknown[]) => unknown>
  __seamAReplayPushes?: Record<string, string[]>
}

/**
 * Runs the scenario in `window` (a Playwright page of the app's window) and answers, per call, the answer as the
 * renderer received it (JSON; a one-way call answers `null`), and per push row the distinct payloads it was sent, in
 * the order first seen. A push is listened to from before the first call until the world settled after the last.
 */
export async function runScenario(window: Page, scenario: Scenario): Promise<ScenarioRun> {
  await window.evaluate((pushes) => {
    const page = globalThis as unknown as ReplayWindow
    const seen: Record<string, string[]> = {}
    for (const { channel, member } of pushes) {
      const payloads: string[] = []
      seen[channel] = payloads
      page.api[member]?.((payload: unknown) => {
        const text = JSON.stringify(payload ?? null)
        if (!payloads.includes(text)) payloads.push(text)
      })
    }
    page.__seamAReplayPushes = seen
  }, scenario.pushes)
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  const calls: ScenarioRun['calls'] = []
  for (const call of scenario.calls) {
    const answer = await window.evaluate(
      async ({ member, args }) => {
        const page = globalThis as unknown as ReplayWindow
        const run = page.api[member]
        if (run === undefined) throw new Error(`window.api has no member ${member}`)
        return JSON.stringify((await run(...args)) ?? null)
      },
      { member: call.member, args: call.args }
    )
    calls.push({
      row: call.row,
      channel: call.channel,
      member: call.member,
      answer: JSON.parse(answer)
    })
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  const seen: Record<string, string[]> = await window.evaluate(
    () => (globalThis as unknown as ReplayWindow).__seamAReplayPushes ?? {}
  )
  const pushes: Record<string, unknown[]> = {}
  for (const { channel } of scenario.pushes) {
    pushes[channel] = (seen[channel] ?? []).map((text) => JSON.parse(text) as unknown)
  }
  return { calls, pushes }
}

/** One JSON document with its keys sorted, so the bytes depend on the values only. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n'
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])])
  )
}
