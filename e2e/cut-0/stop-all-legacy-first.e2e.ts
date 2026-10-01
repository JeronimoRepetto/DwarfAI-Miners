import { expect, test } from '@playwright/test'
import {
  homeIn,
  isProcessAlive,
  launchApp,
  stopEverythingFromWindow,
  trayEvents,
  waitForHostAttached,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { seedLegacyFixtureSession, type LegacyFixtureSession } from './legacyFixtureSession.ts'
import { cleanShutdown, exitsWithin, hostLog } from './stopAllWorld.ts'

/**
 * L9, cut 0 (moved from ISSUE-054, review R8B-02; TC-056-06; 21 §3 `LegacyEndFirstAdapter`; ADR-002 D7): through cut 4
 * Stop everything and quit ends the sessions today's runtime launched first, through its own identity-checked kill,
 * and only then relays `host.shutdown {mode:'stop-all'}`; the Host exits with its clean-shutdown marker and the tray
 * disappears with the app. The legacy-launched session is a stub process written down as a launch of today's runtime
 * (`legacyFixtureSession.ts`).
 */

test.describe.configure({ timeout: 180_000 })

test.describe('cut 0: Stop everything and quit ends legacy-launched sessions first (ISSUE-054)', () => {
  let launched: LaunchedApp | undefined
  let session: LegacyFixtureSession | undefined

  test.afterEach(async () => {
    session?.dispose()
    session = undefined
    await launched?.teardown()
    launched = undefined
  })

  test('[ADR-002] Stop everything and quit ends a legacy-launched fixture session first, the Host exits with the clean marker and the tray disappears', async () => {
    launched = await launchApp({
      trayProbe: true,
      env: homeIn,
      beforeLaunch: async (profile) => {
        session = await seedLegacyFixtureSession(profile)
      },
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window, profile } = launched
    const hostPid = await waitForHostAttached(profile)
    expect(session?.alive(), 'today’s runtime adopted the running fixture session').toBe(true)

    await stopEverythingFromWindow(window)

    expect(await exitsWithin(app.process(), 30_000), 'the app exits').toBe(true)
    await expect.poll(() => isProcessAlive(hostPid), { timeout: 15_000 }).toBe(false)
    // The legacy session was ended by Stop everything. The order is the adapter's (L2, LegacyEndFirstAdapter.test.ts):
    // the relay waits for the end, and the app exits when the Host closes, so a relay sent first leaves the session
    // running here (the break of this case). The test process's exit timestamp is not compared with the Host's log:
    // its delivery lags the OS's end by milliseconds.
    expect(session?.exitedAt(), 'the fixture session was ended').not.toBeNull()
    expect(
      hostLog(profile).some((record) => record.event === 'host.stop-all'),
      'the Host ran stop-all'
    ).toBe(true)
    // The Host exited cleanly for stop-all, with its marker, and the tray went with the app.
    expect(
      hostLog(profile).some((r) => r.event === 'host.exit' && r.causeClass === 'stop-all')
    ).toBe(true)
    expect(cleanShutdown(profile)).toEqual({ reason: 'stop-all', ofRunningEpoch: true })
    expect(trayEvents(profile)).toEqual(['shown', 'removed'])
  })
})
