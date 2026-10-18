import { expect, test } from '@playwright/test'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import {
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  isProcessAlive,
  launchApp,
  stopEverythingFromWindow,
  TRAY_ITEMS,
  trayEvents,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'
import { exitsWithin } from '../cut-0/stopAllWorld.ts'
import {
  createClaudeStreamWorld,
  dwarfsOf,
  launchClaude,
  launchedRun,
  seedMine,
  startOutsideSession,
  stubOnlyPath,
  type OutsideSession
} from '../cut-3a/claudeStreamWorld.ts'

/**
 * L9 (ISSUE-001 test 6, moved from ISSUE-175, review R8B-03; US-RES-002.AC09; INV-120, INV-121; ADR-002 D7): from 3a
 * Stop everything and quit (A-N26) also ends the sessions the Host launched. The world has two Claude sessions in one
 * mine: one the Host launched through the 3a rows (the interactive Claude stub, `claudeStreamStub.mjs`), and one the
 * person started outside the app (a stub process Claude Code's session registry names, which the Host only observes).
 * Confirming in the window ends the launched one, whose dwarf departs `stopped`, keeps the outside one running, and the
 * app, its Host and the tray icon go away.
 *
 * Runs after the 3a switch (writer 1 of ISSUE-001 WU-D): before it, the Claude launch is not the Host's.
 */

test.describe.configure({ timeout: 300_000 })

test.describe('Stop everything and quit with Host-launched sessions (ISSUE-001, ISSUE-175)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined
  let outside: OutsideSession | undefined

  test.afterEach(async () => {
    outside?.dispose()
    outside = undefined
    await launched?.teardown()
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-RES-002.AC09] confirming Stop everything and quit ends the launched stub session, keeps a stub started outside the app, and the app and the tray go away', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createClaudeStreamWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: stubOnlyPath(world),
      pathOnly: true,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    const hostPid = await waitForHostAttached(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    // The Claude stub is installed, so the first-run step is due on this fresh profile (ISSUE-141): answered first.
    await answerFirstRunStep(window)

    // The person's own session, then the Host's launch, in the same mine.
    const { mineId, world: mine } = await seedMine(window, owned)
    outside = await startOutsideSession(owned, mine)
    const { dwarfId } = await launchClaude(window, mineId)
    const run = launchedRun(world)
    expect(isProcessAlive(run.pid), 'the Host launched the stub session').toBe(true)
    await expect
      .poll(async () => (await dwarfsOf(window)).filter((d) => !d.owned).length, {
        timeout: 60_000,
        message: 'the Host observes the session started outside the app'
      })
      .toBeGreaterThan(0)

    // The app ends on its own once confirmed: its trace is saved first, so no screencast frame is lost under the exit.
    await launched.stopTracing()
    await stopEverythingFromWindow(window)

    expect(await exitsWithin(app.process(), 30_000), 'the app exits').toBe(true)
    await expect.poll(() => isProcessAlive(hostPid), { timeout: 15_000 }).toBe(false)
    expect(trayEvents(owned), 'the tray icon goes away').toEqual(['shown', 'removed'])
    expect(isProcessAlive(run.pid), 'the launched stub session was ended').toBe(false)
    expect(outside.alive(), 'the session started outside the app keeps running').toBe(true)

    // Read only after the Host exited (the single writer, ADR-002 D1): the launched dwarf departed stopped (INV-120).
    const db = openHostDatabaseReadOnly(owned)
    try {
      const row = db
        .prepare('SELECT departure_cause AS cause FROM dwarfs WHERE id = ?')
        .get(dwarfId) as { cause: string | null } | undefined
      expect(row?.cause, 'the launched dwarf departed stopped').toBe('stopped')
    } finally {
      db.close()
    }
  })
})
