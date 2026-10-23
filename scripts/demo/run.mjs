import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  anyWindowVisible,
  appEnv,
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  isProcessAlive,
  launchApp,
  processesNaming,
  profileHostPid,
  TRAY_ITEMS,
  waitForHostAttached
} from '../../e2e/_harness/launchApp.ts'
import { isolatedStubPath } from '../../e2e/_harness/stubs.ts'
import { muteAppAudio } from '../../e2e/support/valle.ts'
import {
  answerFirstRunStep,
  declareMineFolder,
  dwarfsOf,
  launchDwarf,
  measuredMine,
  openMineColumn,
  poll,
  recordNotifications,
  renameDwarf,
  sendText,
  setPreference
} from './app.mjs'
import {
  DEMO_PROFILE_PREFIX,
  isolationProblems,
  mineFolderOf,
  pathProblems,
  resolutionProblems
} from './isolation.mjs'
import {
  assignWorkers,
  dwarfsOf as scenarioDwarfs,
  holdPlan,
  SCENARIOS,
  scriptedLengthMs,
  stubScriptOf,
  timelineOf
} from './scenario.mjs'
import { captureShots, shooter, shotsFolder, watchPanelWalk } from './shots.mjs'
import { installStub } from './stubs/install.mjs'
import { tierFilePlan, writeTierFiles } from './tierFiles.mjs'

/**
 * `pnpm demo` and `pnpm demo:shots` (docs/demo.md): the built app on an isolated profile, with the demo's stub CLIs as
 * the only providers it can find, and a scripted scenario played through the app's own `window.api`.
 *
 * 1. A fresh `dwarfai-demo-*` profile in the OS temp folder (the E2E harness's `createIsolatedProfile`): userData,
 *    home folders, provider homes and the Host's data root all inside it.
 * 2. The fictional mine folders (`tierFiles.mjs`) and the stub CLIs with the scenario's turns (`stubs/`).
 * 3. The environment is checked (`isolation.mjs`) and the start refused if anything points outside the profile.
 * 4. The visible app, its Host attached, the first-run step answered with every option off, the mines declared and
 *    measured, then the timeline: launches one by one, a shut mine's folder removed, a late launch; then the hold loop
 *    keeps it going until Ctrl+C or the app's own Stop everything and quit. With `--shots`, the PNGs are taken instead.
 * 5. On the way out: Stop everything and quit (the app ends its Host), anything still naming the profile ended, and
 *    the profile removed unless `--keep`.
 */

const started = Date.now()
const clock = () => {
  const s = Math.floor((Date.now() - started) / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** Writes the mines and the stubs into the profile; answers the stub folders' PATH and the mine folders. */
function prepareProfile(profile, scenario, speed) {
  const folders = {}
  for (const mine of scenario.mines) {
    const folder = mineFolderOf(profile, mine.name)
    writeTierFiles(folder, tierFilePlan(mine.tier))
    writeFileSync(
      path.join(folder, 'README.md'),
      `# ${mine.name}\n\nA fictional project made by DwarfAI-Miners' demo (scripts/demo). Nothing here is real.\n`
    )
    folders[mine.key] = folder
  }
  const stubs = ['claude', 'codex'].map((name) =>
    installStub(profile.root, name, stubScriptOf(scenario, name, speed))
  )
  return { folders, stubPath: isolatedStubPath(...stubs) }
}

/** Refuses to start when anything would let the app leave the profile. */
function checkIsolation(profile, stubPath) {
  const env = appEnv(profile, { stubs: stubPath, pathOnly: true, trayProbe: true })
  const realHomes = [homedir(), process.env.USERPROFILE, process.env.HOME].filter(
    (home) => typeof home === 'string' && home !== ''
  )
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const lookup = {
    platform: process.platform,
    exists: existsSync,
    pathExt: process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT') : ''
  }
  const problems = [
    ...isolationProblems(env, profile, { platform: process.platform, realHomes }),
    // The hard guard: only the demo's stubs can be resolved, so no real provider agent ever runs.
    ...resolutionProblems(pathValue, profile, lookup),
    ...pathProblems(pathValue, profile, lookup)
  ]
  if (problems.length > 0) {
    throw new Error(
      `refusing to start: the demo must run only its own stub CLIs and only inside its profile.\n- ${problems.join('\n- ')}`
    )
  }
}

/** Ends whatever still runs from the profile: its Host first, then any stub or app process naming it. */
function endProfileProcesses(profile) {
  const hostPid = profileHostPid(profile.userDataDir)
  if (hostPid !== null && isProcessAlive(hostPid)) {
    try {
      process.kill(hostPid)
    } catch {
      // Gone meanwhile.
    }
  }
  for (const pid of [...processesNaming(profile.root), ...processesNaming(profile.dataRoot)]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone meanwhile.
    }
  }
}

/** Sleeps until `atMs` after `t0`, or until `stopped()`; answers whether it was stopped. */
async function waitUntil(t0, atMs, stopped) {
  while (Date.now() - t0 < atMs) {
    if (stopped()) return true
    await sleep(Math.min(250, atMs - (Date.now() - t0)))
  }
  return stopped()
}

/** Plays the scenario's timeline, filling `ids` (dwarf id by scenario key) as the dwarfs arrive. */
async function playTimeline({
  busy,
  scenario,
  speed,
  window,
  ids,
  mineIds,
  folders,
  profile,
  log,
  stopped
}) {
  const t0 = Date.now()
  for (const event of timelineOf(scenario, speed)) {
    if (await waitUntil(t0, event.atMs, stopped)) return ids
    if (event.kind === 'launch') {
      const mine = scenario.mines.find((m) => m.key === event.dwarf.mine)
      try {
        busy.set(
          event.dwarf.key,
          Date.now() + scriptedLengthMs(scenario, event.dwarf.provider, event.dwarf.prompt, speed)
        )
        ids[event.dwarf.key] = await launchDwarf(
          window,
          mineIds[mine.key],
          event.dwarf.provider,
          event.dwarf.prompt
        )
        const label = event.dwarf.name ?? event.dwarf.key
        if (event.dwarf.name !== null && event.dwarf.name !== undefined) {
          const renamed = await renameDwarf(window, ids[event.dwarf.key], event.dwarf.name)
          if (!renamed) log(`${label}: the app kept its own name`)
        }
        log(`${label} (${event.dwarf.provider}) started in ${mine.name}`)
      } catch (error) {
        log(
          `${event.dwarf.key} did not start: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } else if (event.kind === 'remove-folder') {
      const folder = folders[event.mine]
      if (path.relative(profile.root, folder).startsWith('..'))
        throw new Error(`${folder} is outside the profile`)
      rmSync(folder, { recursive: true, force: true })
      log(
        `removed the folder of ${scenario.mines.find((m) => m.key === event.mine).name}: it becomes unenterable`
      )
    }
  }
  return ids
}

/**
 * Names the workers as the Host observes them (`assignWorkers`): every half second, each new worker under a known
 * parent gets its scripted name through the app's own rename, so it walks in already named, or nearly.
 */
async function nameWorkers({ scenario, window, ids, log, stopped }) {
  const everyone = scenarioDwarfs(scenario)
  while (!stopped()) {
    let rows
    try {
      rows = await dwarfsOf(window)
    } catch {
      return // The window is gone: the app is ending.
    }
    for (const [key, id] of Object.entries(assignWorkers(scenario, ids, rows))) {
      ids[key] = id
      const worker = everyone.find((d) => d.key === key)
      const mine = scenario.mines.find((m) => m.key === worker.mine)
      if (worker.name !== null && !(await renameDwarf(window, id, worker.name))) {
        log(`${worker.name}: the app kept its own name`)
      }
      log(`${worker.name ?? key} (${worker.rank}) arrived in ${mine.name}`)
    }
    await sleep(500)
  }
}

/** The hold loop: keeps the scene alive until `stopped()`. */
async function hold({ scenario, speed, window, ids, busy, log, stopped }) {
  const idleSince = new Map()
  let round = 0
  while (!stopped()) {
    const byId = new Map(Object.entries(ids).map(([key, id]) => [id, key]))
    let dwarfs
    try {
      dwarfs = await dwarfsOf(window)
    } catch {
      return // The window is gone: the app is ending.
    }
    const now = Date.now()
    const views = []
    for (const dwarf of dwarfs) {
      const key = byId.get(dwarf.id)
      if (key === undefined) continue
      if (dwarf.status === 'idle' || dwarf.status === 'asleep') {
        if (!idleSince.has(key)) idleSince.set(key, now)
      } else idleSince.delete(key)
      views.push({
        key,
        status: dwarf.status,
        idleSince: idleSince.get(key) ?? now,
        busyUntil: busy.get(key)
      })
    }
    const sends = holdPlan(scenario, views, now, speed, round)
    for (const send of sends) {
      if (await sendText(window, ids[send.key], send.text)) {
        idleSince.delete(send.key)
        const { provider } = scenarioDwarfs(scenario).find((d) => d.key === send.key)
        busy.set(send.key, Date.now() + scriptedLengthMs(scenario, provider, send.text, speed))
        log(`${send.key} told: ${send.text}`)
      }
    }
    if (sends.length > 0) round++
    for (let waited = 0; waited < scenario.holdEveryMs / speed && !stopped(); waited += 250)
      await sleep(250)
  }
}

/** Runs the demo; answers the process exit code. */
export async function runDemo(
  options,
  log = (line) => process.stdout.write(`[demo ${clock()}] ${line}\n`)
) {
  const scenario = SCENARIOS[options.scenario]
  const profile = createIsolatedProfile(DEMO_PROFILE_PREFIX)
  log(`profile: ${profile.root}`)
  let launched
  let stopRequested = false
  let appExited = false
  const stopped = () => stopRequested || appExited
  const onSignal = () => {
    if (stopRequested) return
    stopRequested = true
    log('stopping…')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const timer =
    options.duration === null
      ? undefined
      : setTimeout(() => {
          log(`${options.duration} s are up`)
          onSignal()
        }, options.duration * 1000)
  let exitCode = 0
  try {
    log('writing the fictional mines and the stub CLIs')
    const { folders, stubPath } = prepareProfile(profile, scenario, options.speed)
    checkIsolation(profile, stubPath)
    log('starting the app (the built one in out/: run `pnpm build` first)')
    launched = await launchApp({
      profile,
      stubs: stubPath,
      pathOnly: true,
      trayProbe: true,
      quitTimeoutMs: 20_000
    })
    const { app, window } = launched
    app.process().once('exit', () => {
      appExited = true
    })
    if (!options.sound) await muteAppAudio(app)
    if (!options.notifications) await recordNotifications(app)
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await poll(
      () => anyWindowVisible(app),
      (shown) => shown,
      'the Panel shows',
      30_000
    )
    await answerFirstRunStep(window)

    log(`declaring ${scenario.mines.length} mines`)
    const mineIds = {}
    for (const mine of scenario.mines)
      mineIds[mine.key] = await declareMineFolder(app, window, folders[mine.key])
    await setPreference(
      window,
      'valleMosaicOrder',
      scenario.mines.map((mine) => mineIds[mine.key])
    )
    for (const mine of scenario.mines) {
      const row = await measuredMine(window, mineIds[mine.key])
      log(`${mine.name}: ${row.tier ?? '?'} (planned ${mine.tier})`)
    }

    // The first mine's column open before anyone arrives: the Panel walks in only a dwarf that turns up after its
    // column opened (MineColumn.vue, sceneMotion.ts createWalkBoard), so its crew is seen walking in.
    await openMineColumn(window, mineIds[scenario.mines[0].key]).catch((error) =>
      log(`the first mine's column did not open: ${error.message}`)
    )
    log('playing the timeline')
    // The hold loop runs beside the timeline, so the first crews keep working while the later ones arrive.
    const ids = {}
    let shotsDone = false
    // When each dwarf's last scripted turn can have ended, by scenario key.
    const busy = new Map()
    const naming = nameWorkers({
      scenario,
      window,
      ids,
      log,
      stopped: () => stopped() || shotsDone
    })
    const shots = options.shots ? shooter(shotsFolder(options.out), log, stopped) : null
    const panelWalk =
      shots === null
        ? Promise.resolve()
        : watchPanelWalk({ window, shoot: shots.shoot, log, stopped })
    const holding = hold({
      busy,
      scenario,
      speed: options.speed,
      window,
      ids,
      log,
      stopped: () => stopped() || shotsDone
    })
    await playTimeline({
      busy,
      scenario,
      speed: options.speed,
      window,
      ids,
      mineIds,
      folders,
      profile,
      log,
      stopped
    })
    if (options.shots) {
      await panelWalk
      await captureShots({ app, window, scenario, ids, mineIds, ...shots, log, stopped })
      log(`shots written to ${path.dirname(shots.taken[0] ?? '.')}`)
      shotsDone = true
    } else if (!stopped()) {
      log('holding the scene: Ctrl+C, or Stop everything and quit in the app, ends the demo')
    }
    await holding
    await naming
  } catch (error) {
    if (!stopped()) {
      exitCode = 1
      log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    }
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (launched !== undefined && !appExited) {
      log('Stop everything and quit')
      await launched.teardown({ stopEverything: true }).catch(async () => {
        await launched.app.close().catch(() => undefined)
      })
    }
    endProfileProcesses(profile)
    if (options.keep) log(`kept the profile at ${profile.root}`)
    else {
      await disposeProfile(profile).catch((error) => {
        exitCode = 1
        log(
          `the profile was not removed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      log('profile removed')
    }
  }
  return exitCode
}
