import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  TRAY_ITEMS,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../e2e/_harness/launchApp.ts'
import { answerFirstRunStep } from '../e2e/_harness/firstRunStep.ts'
import { STUB_BIN } from '../e2e/_harness/stubs.ts'

/**
 * L11 perf case (ISSUE-283; NFR-PERF-04, NFR-OBS-03; testing strategy `17` §1.11): the idle scene's
 * renderer CPU on this OS, appended to `perf-results/<os>/<date>.json` by the runner
 * (`perf/_harness/runPerf.mjs`). Recorded without a gate: no number is read or applied until each OS
 * has a baseline (`17` §1.11).
 *
 * Case title: [NFR-PERF-04, NFR-OBS-03] the idle scene's renderer CPU is sampled on this OS and
 * appended to perf-results.
 *
 * - The scene. Veta is not built yet (its cases come with ISSUE-297), so this measures the idle Panel:
 *   the built app on an isolated profile (`17` §1.9, through the E2E launch harness), the Claude stub
 *   on PATH and no session, the first-run step answered, the Panel shown on its Map page with nothing
 *   working. Nothing is seeded, so no sprite is on the frame clock.
 * - The measure. Electron's `app.getAppMetrics()`, read in the main process through Playwright's own
 *   `evaluate` (no test hook in production code, R14). Its `cpu.percentCPUUsage` is the process's CPU
 *   since the previous call, as a percentage of one core, on every OS (Electron `CPUUsage`); the
 *   renderer is the Panel window's own process (`webContents.getOSProcessId()`). One priming read,
 *   then one sample a second over a fixed window, after a settle period so start-up work is over.
 * - Bounded: one launch, about 40 s in all, no load generated; the app and its Host are ended through
 *   the app's own Stop everything and quit, and the profile is removed, whatever happens.
 */

/** Lets start-up work (first paint, the Host's first snapshot, image decodes) finish first. */
const SETTLE_MS = 10_000
/** One sample a second over this window. */
const SAMPLE_EVERY_MS = 1_000
const SAMPLES = 20

/** One sample: the Panel renderer's CPU over the second before it, as a percentage of one core. */
interface IdleSceneSample {
  readonly scene: 'panel-idle'
  readonly process: 'renderer'
  readonly api: 'app.getAppMetrics().cpu.percentCPUUsage'
  readonly cpu: number
}

export default async function run(): Promise<IdleSceneSample[]> {
  const profile: IsolatedProfile = createIsolatedProfile()
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp({
      profile,
      stubs: path.join(STUB_BIN, 'claude'),
      trayProbe: true
    })
    const { app, window } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await window.locator('.dm-nav .dm-slot[data-label="Map"]').waitFor({ timeout: 60_000 })

    const owner = await app.browserWindow(window)
    const rendererPid = await owner.evaluate((panel) => panel.webContents.getOSProcessId())
    const rendererCpu = async (): Promise<number> => {
      const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics())
      const renderer = metrics.find((metric) => metric.pid === rendererPid)
      if (renderer === undefined) throw new Error('the Panel renderer is not in the app metrics')
      return renderer.cpu.percentCPUUsage
    }

    await sleep(SETTLE_MS)
    await rendererCpu() // primes the "since the previous call" window
    const samples: IdleSceneSample[] = []
    for (let taken = 0; taken < SAMPLES; taken++) {
      await sleep(SAMPLE_EVERY_MS)
      samples.push({
        scene: 'panel-idle',
        process: 'renderer',
        api: 'app.getAppMetrics().cpu.percentCPUUsage',
        cpu: await rendererCpu()
      })
    }
    return samples
  } finally {
    await launched?.teardown({ stopEverything: true })
    await disposeProfile(profile)
  }
}
