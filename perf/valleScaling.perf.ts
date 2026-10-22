import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { buildControlRoomPage } from './fixtures/controlRoom/buildPage.ts'
import { rendererAndAppCpu } from './_harness/appMetrics.mjs'
import { frameTimeSummary } from './_harness/frameStats.mjs'

/**
 * L11 perf case (ISSUE-298; spike S-034-1; NFR-PERF-10; ADR-034 item 5; testing strategy `17` §1.11, §4): how many
 * live mine columns the Control room can carry, before any Valle UI is built. Appended to
 * `perf-results/<os>/<date>.json` by the runner (`perf/_harness/runPerf.mjs`). Recorded without a gate: the lead sets
 * the supported column count and the degradation rule in `17` §1.11 from the S-034-1 record.
 *
 * Case titles (the case fails by throwing, naming the title that failed):
 * - [S-034-1, NFR-PERF-10] the Control-room mosaic with 4, 8, 12 and 16 live columns records frame time and CPU on
 *   this OS.
 * - [S-034-1, ADR-034] with the default degradation, columns outside the viewport request no sprite frame and paint
 *   their last frame, and scrolling one into view shows its current frame within one frame.
 * - [S-034-1, ADR-034] the mosaic keeps every column in the DOM at every N (no virtualization).
 *
 * - The page. `perf/fixtures/controlRoom/`, a perf-only renderer entry built here with Vite into `out/perf/` and opened
 *   in a bare Electron window (`electronMain.cjs`, sandboxed, no Host, no provider). N columns side by side, each the
 *   Panel's own mine column (MineColumn.vue) fed a fixture crew of three (working, idle, asleep), each on a sprite frame
 *   clock of its own. The window is sized to four columns across; past four the mosaic scrolls sideways. The default
 *   degradation (ADR-034 item 5): a column outside the viewport pauses its clock (`pause()`, ISSUE-282) and paints its
 *   last frame; nothing is virtualized. `degradation=off` lets every clock run.
 * - The scenes, for N in 4, 8, 12, 16 and the degradation on and off: `idle` (the first four columns in view),
 *   `scrolled` (scrolled to the last four) and `sustained-scroll` (scrolled sideways back and forth without a pause).
 * - The measure. After a settle, the CPU of the page's renderer and of the whole app (`app.getAppMetrics()`, read in
 *   the main process through Playwright's `evaluate`, `_harness/appMetrics.mjs`), one read a second; and the frame time,
 *   the interval between consecutive animation frames, summarized as p50, p95, p99 and maximum
 *   (`_harness/frameStats.mjs`). For `idle` and `scrolled` the CPU window runs first with no frame loop of the probe's
 *   own, then the frame window; `sustained-scroll` scrolls on every animation frame, so its CPU and frames share one
 *   window.
 * - Bounded: one Electron app for the whole case, one page load per N and switch, about five minutes, no load generated
 *   beyond the page itself; the app is closed (and killed if it does not close) and its profile removed, whatever
 *   happens.
 */

const COLUMN_COUNTS = [4, 8, 12, 16] as const
const SWITCHES = ['on', 'off'] as const
const MOTIONS = ['idle', 'scrolled', 'sustained-scroll'] as const
/** Columns across the window. */
const ACROSS = 4
/** The window's content height, so every OS draws the same column width. */
const CONTENT_HEIGHT = 720

/** Lets the page load, decode its art and its columns settle into their clocks' state. */
const SETTLE_MS = 2_000
const CPU_SAMPLES = 5
const SAMPLE_EVERY_MS = 1_000
const FRAME_WINDOW_MS = 3_000
/** The sideways scroll's speed: about 480 CSS pixels a second at 60 Hz. */
const SWEEP_PX_PER_FRAME = 8
/** How long a check watches the columns' clocks. */
const WATCH_MS = 2_000

type Degradation = (typeof SWITCHES)[number]
type Motion = (typeof MOTIONS)[number]
const API = 'app.getAppMetrics().cpu.percentCPUUsage'

/** One CPU sample: the page's renderer or the whole app, over the second before it, as a percentage of one core. */
interface CpuSample {
  readonly scene: string
  readonly columns: number
  readonly degradation: Degradation
  readonly motion: Motion
  readonly process: 'renderer' | 'app'
  readonly api: typeof API
  readonly cpu: number
}

/** One frame-time summary of a scene's window, in milliseconds. */
interface FrameSample {
  readonly scene: string
  readonly columns: number
  readonly degradation: Degradation
  readonly motion: Motion
  readonly process: 'renderer'
  readonly metric: 'frame-time'
  readonly frameMs: { count: number; p50: number; p95: number; p99: number; max: number }
  readonly window: { width: number; height: number; devicePixelRatio: number }
}

type Sample = CpuSample | FrameSample

interface ColumnReading {
  index: number
  inDom: boolean
  sprites: number
  painted: boolean
  requests: number
  frames: number
  running: boolean
}

const TITLE_RECORDS =
  '[S-034-1, NFR-PERF-10] the Control-room mosaic with 4, 8, 12 and 16 live columns records frame time and CPU on this OS'
const TITLE_DEGRADATION =
  '[S-034-1, ADR-034] with the default degradation, columns outside the viewport request no sprite frame and paint ' +
  'their last frame, and scrolling one into view shows its current frame within one frame'
const TITLE_NO_VIRTUALIZATION =
  '[S-034-1, ADR-034] the mosaic keeps every column in the DOM at every N (no virtualization)'

const sceneName = (columns: number, degradation: Degradation, motion: Motion): string =>
  `control-room-${columns}-degradation-${degradation}-${motion}`

const columnsOf = (page: Page): Promise<ColumnReading[]> =>
  page.evaluate('window.controlRoom.columns()') as Promise<ColumnReading[]>

/** Checks every column is in the DOM with its crew drawn: none virtualized away, none emptied. */
async function checkEveryColumnInDom(
  page: Page,
  columns: number,
  degradation: Degradation
): Promise<string[]> {
  const inDom = (await page.evaluate('window.controlRoom.columnsInDom()')) as number
  const readings = await columnsOf(page)
  const missing = readings.filter((column) => !column.inDom || column.sprites === 0)
  if (inDom === columns && readings.length === columns && missing.length === 0) return []
  return [
    `${TITLE_NO_VIRTUALIZATION}: at N=${columns}, degradation ${degradation}, the DOM holds ${inDom} mine column(s) ` +
      `and the page ${readings.length}, ${missing.length} without its crew drawn (${JSON.stringify(missing)})`
  ]
}

/**
 * With the default degradation on and columns past four: the columns outside the viewport ask their clock for no tick
 * and paint no frame while their strips still show a frame, the columns in view do (or the check could not fail);
 * then the last column is scrolled into view and must resume within one animation frame, on the frame it held, and
 * move again.
 */
async function checkDegradation(page: Page, columns: number): Promise<string[]> {
  await page.evaluate('window.controlRoom.scrollToStart()')
  await sleep(SETTLE_MS)
  await page.evaluate('window.controlRoom.resetCounts()')
  await sleep(WATCH_MS)
  const readings = await columnsOf(page)
  const failures: string[] = []
  const inView = readings.filter((column) => column.index < ACROSS)
  const outside = readings.filter((column) => column.index >= ACROSS)
  const idleInView = inView.filter((column) => !column.running || column.frames === 0)
  if (idleInView.length > 0) {
    failures.push(
      `${TITLE_DEGRADATION}: at N=${columns} a column in view painted no sprite frame, so the check proves nothing ` +
        `(${JSON.stringify(idleInView)})`
    )
  }
  const busyOutside = outside.filter(
    (column) => column.running || column.requests !== 0 || column.frames !== 0 || !column.painted
  )
  if (busyOutside.length > 0) {
    failures.push(
      `${TITLE_DEGRADATION}: at N=${columns} a column outside the viewport requested or painted a sprite frame, or ` +
        `shows none (${JSON.stringify(busyOutside)})`
    )
  }
  const last = columns - 1
  const revealed = (await page.evaluate(`window.controlRoom.reveal(${last})`)) as {
    framesToResume: number | null
    heldFramesShown: boolean
  }
  if (
    revealed.framesToResume === null ||
    revealed.framesToResume > 1 ||
    !revealed.heldFramesShown
  ) {
    failures.push(
      `${TITLE_DEGRADATION}: at N=${columns} column ${last + 1}, scrolled into view, did not show its current frame ` +
        `within one frame (${JSON.stringify(revealed)})`
    )
  }
  await page.evaluate('window.controlRoom.resetCounts()')
  await sleep(WATCH_MS)
  const after = (await columnsOf(page)).find((column) => column.index === last)
  if (after === undefined || !after.running || after.frames === 0) {
    failures.push(
      `${TITLE_DEGRADATION}: at N=${columns} column ${last + 1}, back in view, did not move again ` +
        `(${JSON.stringify(after)})`
    )
  }
  await page.evaluate('window.controlRoom.scrollToStart()')
  return failures
}

/** Measures one scene of the page as it stands. */
async function measureScene(
  app: ElectronApplication,
  page: Page,
  pid: number,
  columns: number,
  degradation: Degradation,
  motion: Motion,
  window: FrameSample['window']
): Promise<Sample[]> {
  const scene = sceneName(columns, degradation, motion)
  const read = async (): Promise<{ renderer: number; app: number }> =>
    rendererAndAppCpu(
      await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()),
      pid
    )
  const cpuSample = (process: 'renderer' | 'app', cpu: number): CpuSample => ({
    scene,
    columns,
    degradation,
    motion,
    process,
    api: API,
    cpu
  })
  if (motion === 'scrolled') await page.evaluate('window.controlRoom.scrollToEnd()')
  else await page.evaluate('window.controlRoom.scrollToStart()')
  await sleep(SETTLE_MS)

  const samples: Sample[] = []
  const sampleCpu = async (): Promise<void> => {
    await read() // primes the "since the previous call" window
    for (let taken = 0; taken < CPU_SAMPLES; taken++) {
      await sleep(SAMPLE_EVERY_MS)
      const cpu = await read()
      samples.push(cpuSample('renderer', cpu.renderer), cpuSample('app', cpu.app))
    }
  }

  let frames: number[]
  if (motion === 'sustained-scroll') {
    const sweep = page.evaluate(
      `window.controlRoom.sweep(${CPU_SAMPLES * SAMPLE_EVERY_MS + 500}, ${SWEEP_PX_PER_FRAME})`
    ) as Promise<number[]>
    await sampleCpu()
    frames = await sweep
  } else {
    await sampleCpu()
    frames = (await page.evaluate(`window.controlRoom.frameTimes(${FRAME_WINDOW_MS})`)) as number[]
  }
  samples.push({
    scene,
    columns,
    degradation,
    motion,
    process: 'renderer',
    metric: 'frame-time',
    frameMs: frameTimeSummary(frames),
    window
  })
  return samples
}

/** Loads the page with `columns` and the switch, and waits until it is mounted. */
async function load(
  page: Page,
  pageFile: string,
  columns: number,
  degradation: Degradation
): Promise<{ columns: number; columnWidth: number; devicePixelRatio: number }> {
  const url = `${pathToFileURL(pageFile).href}?columns=${columns}&degradation=${degradation}`
  await page.goto(url)
  await page.waitForFunction('window.controlRoom !== undefined')
  return (await page.evaluate('window.controlRoom.ready')) as {
    columns: number
    columnWidth: number
    devicePixelRatio: number
  }
}

/**
 * A failed check. Once some scene was measured the error carries its samples, so the runner records them beside the
 * failure (perf/README.md, "A check that fails after measuring"); before that, nothing is recorded.
 */
function failure(message: string, samples: Sample[]): Error {
  const error = new Error(message)
  return samples.length === 0 ? error : Object.assign(error, { samples })
}

/** Closes the app, and kills its process if it has not ended within a few seconds. */
async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process()
  await Promise.race([app.close().catch(() => undefined), sleep(10_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

export default async function run(): Promise<Sample[]> {
  const pageFile = await buildControlRoomPage()
  const here = path.dirname(fileURLToPath(import.meta.url))
  const profile = mkdtempSync(path.join(tmpdir(), 'dwarfai-perf-'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'].includes(key.toUpperCase())
    )
      env[key] = value
  }
  env.DWARFAI_E2E_MAIN_ERRORS = path.join(profile, 'main-errors.log')
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      args: [
        '-r',
        path.join(here, '..', 'e2e', '_harness', 'mainErrorGuard.cjs'),
        path.join(here, 'fixtures', 'controlRoom', 'electronMain.cjs'),
        `--user-data-dir=${path.join(profile, 'userData')}`
      ],
      env
    })
    const page = await app.firstWindow()
    const owner = await app.browserWindow(page)
    const pid = await owner.evaluate((window) => window.webContents.getOSProcessId())

    const samples: Sample[] = []
    const failures: string[] = []
    let sized = false
    for (const columns of COLUMN_COUNTS) {
      for (const degradation of SWITCHES) {
        let shown = await load(page, pageFile, columns, degradation)
        if (!sized && shown.columnWidth > 0) {
          // Four columns across, whatever the OS's frame: the content area is set, not the window.
          const width = Math.ceil(shown.columnWidth * ACROSS)
          await owner.evaluate((window, size) => window.setContentSize(size.width, size.height), {
            width,
            height: CONTENT_HEIGHT
          })
          sized = true
          shown = await load(page, pageFile, columns, degradation)
        }
        failures.push(...(await checkEveryColumnInDom(page, columns, degradation)))
        if (degradation === 'on' && columns > ACROSS && failures.length === 0) {
          failures.push(...(await checkDegradation(page, columns)))
        }
        if (failures.length > 0) throw failure(failures.join('; '), samples)
        const viewport = (await page.evaluate(
          '({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })'
        )) as FrameSample['window']
        for (const motion of MOTIONS) {
          samples.push(
            ...(await measureScene(app, page, pid, columns, degradation, motion, viewport))
          )
        }
      }
    }

    const measured = new Set(
      samples.filter((sample) => 'metric' in sample).map((sample) => sample.scene)
    )
    const expected = COLUMN_COUNTS.flatMap((columns) =>
      SWITCHES.flatMap((degradation) =>
        MOTIONS.map((motion) => sceneName(columns, degradation, motion))
      )
    )
    const unmeasured = expected.filter((scene) => !measured.has(scene))
    if (unmeasured.length > 0) {
      throw failure(`${TITLE_RECORDS}: no frame time for ${unmeasured.join(', ')}`, samples)
    }
    return samples
  } finally {
    if (app !== undefined) await closeApp(app)
    rmSync(profile, { recursive: true, force: true })
  }
}
