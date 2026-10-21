import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ElectronApplication } from '@playwright/test'
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
import {
  createClaudeStreamWorld,
  dwarfsOf,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../e2e/cut-3a/claudeStreamWorld.ts'
import {
  declareMine,
  lifeOf,
  openMineColumn,
  rendererPidOf,
  showVeta,
  takeSpriteFrames,
  waitFor,
  watchSpriteFrames
} from '../e2e/support/vetaScene.ts'
import { rendererAndAppCpu } from './_harness/appMetrics.mjs'

/**
 * L11 perf case (ISSUE-297; NFR-PERF-04, NFR-OBS-03; ADR-025 item 7 and Verification; testing strategy `17` §1.11):
 * Veta's idle CPU on this OS in its two idle situations, appended to `perf-results/<os>/<date>.json` by the runner
 * (`perf/_harness/runPerf.mjs`) and read as release evidence by `perf/_harness/releaseEvidence.mjs` (ADR-034 item 4).
 * Recorded without a gate: no number is read or applied until each OS has a baseline (`17` §1.11).
 *
 * Case titles (the case fails by throwing, naming the title that failed):
 * - [NFR-PERF-04, NFR-OBS-03, ADR-025] Veta with every dwarf asleep: the renderer and app CPU are sampled on this OS
 *   and appended to perf-results.
 * - [ADR-025] while Veta is shown the hidden Panel renderer requests no sprite frame.
 * - [NFR-PERF-04, NFR-OBS-03] Veta with no sessions: the renderer and app CPU are sampled on this OS and appended to
 *   perf-results.
 *
 * - The scenes. The built app in the E2E build profile, whose built-modes list contains Veta
 *   (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, `17` §1.9), on an isolated profile through the E2E launch harness, with
 *   the interactive Claude stub alone on PATH (`e2e/cut-3a/claudeStreamWorld.ts`). One mine is declared and one stub
 *   dwarf launched; once its first turn ends it is idle (asleep) and drawn on its open mine column, the Panel is moved to Veta (A-N13 `moveToMode`, as
 *   ISSUE-294's lever will) and Veta shows `all-idle`: the first scene. Then the dwarf's session is ended (A-N29) and
 *   Veta contracts to the closed entrance, `no-sessions`: the second scene. One launch serves both.
 * - The measure. Exactly ISSUE-283's window (`perf/idleScene.perf.ts`): a 10 s settle, one priming read, then 20
 *   samples one a second of Electron's `app.getAppMetrics()`, read in the main process through Playwright's `evaluate`
 *   (no test hook in production code, R14). Each read gives two samples: the Veta renderer's `cpu.percentCPUUsage`
 *   (the Veta window's own process) and the app's, the sum over every process the metrics list
 *   (`_harness/appMetrics.mjs`; the detached Host is outside Electron's metrics).
 * - The hidden Panel. While the dwarf sleeps in the shown Panel, a watch counts its sprite frame changes (the one
 *   frame clock moving a sprite, `e2e/support/vetaScene.ts`); it must see frames there, or the check would prove
 *   nothing. Over the asleep scene's sampling window, with the Panel window hidden by the move to Veta
 *   (`BrowserWindow.isVisible()` false), it must count none (ADR-025 item 7: the hidden Panel renderer is idle). A
 *   failure is thrown after both scenes are sampled, carrying their samples, so the runner still records the CPU.
 * - Bounded: one launch, about two minutes, no load generated; the app and its Host are ended through the app's own
 *   Stop everything and quit, and the profile is removed, whatever happens.
 */

/** Lets start-up and transition work (first paint, the move to Veta, image decodes) finish first. */
const SETTLE_MS = 10_000
/** One sample a second over this window: the same fixed window as ISSUE-283. */
const SAMPLE_EVERY_MS = 1_000
const SAMPLES = 20
/** How long the shown Panel is watched to see that its sleeping dwarf moves on the frame clock. */
const SHOWN_PANEL_WATCH_MS = 3_000

type VetaIdleScene = 'veta-all-asleep' | 'veta-no-sessions'

/** One sample: the Veta renderer's or the whole app's CPU over the second before it, as a percentage of one core. */
interface VetaIdleSample {
  readonly scene: VetaIdleScene
  readonly process: 'renderer' | 'app'
  readonly api: 'app.getAppMetrics().cpu.percentCPUUsage'
  readonly cpu: number
}

const API = 'app.getAppMetrics().cpu.percentCPUUsage'

/** Samples `scene` over the fixed window: the Veta renderer and the app, one read a second. */
async function sampleScene(
  app: ElectronApplication,
  vetaPid: number,
  scene: VetaIdleScene
): Promise<VetaIdleSample[]> {
  const read = async (): Promise<{ renderer: number; app: number }> =>
    rendererAndAppCpu(
      await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()),
      vetaPid
    )
  await sleep(SETTLE_MS)
  await read() // primes the "since the previous call" window
  const samples: VetaIdleSample[] = []
  for (let taken = 0; taken < SAMPLES; taken++) {
    await sleep(SAMPLE_EVERY_MS)
    const cpu = await read()
    samples.push({ scene, process: 'renderer', api: API, cpu: cpu.renderer })
    samples.push({ scene, process: 'app', api: API, cpu: cpu.app })
  }
  return samples
}

export default async function run(): Promise<VetaIdleSample[]> {
  const profile: IsolatedProfile = createIsolatedProfile()
  let launched: LaunchedApp | undefined
  try {
    const world = createClaudeStreamWorld(profile)
    launched = await launchApp({
      profile,
      stubs: stubOnlyPath(world),
      pathOnly: true,
      trayProbe: true
    })
    const { app, window: panel } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(panel)
    await panel.locator('.dm-nav .dm-slot[data-label="Map"]').waitFor({ timeout: 60_000 })

    const folder = path.join(profile.root, 'moria')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, panel, folder)
    const { dwarfId } = await launchClaude(panel, mineId)
    await openMineColumn(panel)

    // The check has to be able to fail: the shown Panel's sleeping dwarf moves on the frame clock.
    await watchSpriteFrames(app, panel)
    await takeSpriteFrames(app, panel)
    await sleep(SHOWN_PANEL_WATCH_MS)
    const shown = await takeSpriteFrames(app, panel)
    if (!shown.visible || shown.sprites === 0 || shown.frames === 0) {
      throw new Error(
        '[ADR-025] while Veta is shown the hidden Panel renderer requests no sprite frame: the shown Panel drew no ' +
          `moving sprite to watch (${JSON.stringify(shown)})`
      )
    }

    // Scene 1: Veta shown, every dwarf asleep.
    const veta = await showVeta(app, panel)
    await waitFor(() => lifeOf(veta), 'all-idle', 'Veta shows every dwarf asleep')
    const vetaPid = await rendererPidOf(app, veta)
    await takeSpriteFrames(app, panel)
    const asleep = await sampleScene(app, vetaPid, 'veta-all-asleep')
    const hiddenPanel = await takeSpriteFrames(app, panel)

    // Scene 2: the session ends and Veta contracts to the closed entrance, no sessions.
    const stopped = (await panel.evaluate(
      `window.api.stopDwarf(${JSON.stringify({ dwarfId, requestId: uuidv7() })})`
    )) as { ok: boolean }
    if (!stopped.ok) throw new Error(`A-N29 did not end the session: ${JSON.stringify(stopped)}`)
    await waitFor(
      async () =>
        (await dwarfsOf(panel)).some((d) => d.id === dwarfId && d.presence !== 'walking-out'),
      false,
      'the dwarf leaves'
    )
    await waitFor(() => lifeOf(veta), 'no-sessions', 'Veta shows no sessions')
    const none = await sampleScene(app, vetaPid, 'veta-no-sessions')

    const samples = [...asleep, ...none]
    if (hiddenPanel.visible || hiddenPanel.frames !== 0) {
      // Both scenes are measured first: their CPU is evidence even when the Panel check fails (runPerf.mjs).
      throw Object.assign(
        new Error(
          '[ADR-025] while Veta is shown the hidden Panel renderer requests no sprite frame: over the asleep ' +
            `scene's window the Panel ${JSON.stringify(hiddenPanel)}`
        ),
        { samples }
      )
    }
    return samples
  } finally {
    await launched?.teardown({ stopEverything: true })
    await disposeProfile(profile)
  }
}
