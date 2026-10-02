import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  anyWindowVisible,
  homeIn,
  isProcessAlive,
  launchApp,
  stopEverythingFromWindow,
  trayEvents,
  waitForHostAttached,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import {
  pathWithoutKill,
  seedLegacyFixtureSession,
  type LegacyFixtureSession
} from './legacyFixtureSession.ts'
import { cleanShutdown, exitsWithin, hostLog } from './stopAllWorld.ts'

/**
 * L9, cut 0 (moved from ISSUE-054, review R8B-02; TC-056-06; 21 §3 `LegacyEndFirstAdapter`; ADR-002 D7): through cut 4
 * Stop everything and quit ends the sessions today's runtime launched first, through its own identity-checked kill,
 * and only then relays `host.shutdown {mode:'stop-all'}`; the Host exits with its clean-shutdown marker and the tray
 * disappears with the app. The legacy-launched session is a stub process written down as a launch of today's runtime
 * (`legacyFixtureSession.ts`).
 */

/**
 * The window's own Stop everything and quit, answered by the test instead of the person: A-N34 asks for the flow, the
 * A-N25 push names the confirmation, and A-N26 confirms it; the answer is A-N26's. Page-side source text: this file is
 * type-checked without the DOM library.
 */
function confirmThroughA26(requestId: string): string {
  return `(async () => {
    const confirmationId = await new Promise((resolve) => {
      const stop = window.api.onStopEverythingRequested((pushed) => {
        stop()
        resolve(pushed.confirmationId)
      })
      window.api.requestStopEverything()
    })
    return window.api.confirmStopEverything({ confirmationId, requestId: ${JSON.stringify(requestId)} })
  })()`
}

/** A UUIDv7 (14 §1.6): the time prefix, then random bits. */
function uuidv7(): string {
  const hex = Date.now().toString(16).padStart(12, '0')
  const rest = randomUUID().replaceAll('-', '')
  const variant = ((Number.parseInt(rest[16] ?? '8', 16) & 0x3) | 0x8).toString(16)
  const v = `${hex}7${rest.slice(13, 16)}${variant}${rest.slice(17, 32)}`
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`
}

test.describe.configure({ timeout: 180_000 })

test.describe('cut 0: Stop everything and quit ends legacy-launched sessions first (ISSUE-054)', () => {
  let launched: LaunchedApp | undefined
  let session: LegacyFixtureSession | undefined
  let noKill: { dispose(): void } | undefined

  test.afterEach(async () => {
    session?.dispose()
    session = undefined
    noKill?.dispose()
    noKill = undefined
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

  test('[ADR-002] a legacy session that cannot be ended keeps the Host, the windows and the tray', async () => {
    // Today's runtime finds its probe but not its kill: it adopts the running session and its end is refused, with
    // nothing signalled (`pathWithoutKill`).
    const pathOnly = pathWithoutKill()
    noKill = pathOnly
    launched = await launchApp({
      trayProbe: true,
      stubs: pathOnly.path,
      pathOnly: true,
      env: homeIn,
      beforeLaunch: async (profile) => {
        session = await seedLegacyFixtureSession(profile)
      },
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window, profile } = launched
    const hostPid = await waitForHostAttached(profile)

    const answer = await window.evaluate(confirmThroughA26(uuidv7()))

    // A-N26 answers its error branch and nothing is relayed: the Host never ran stop-all (ADR-002 D7 step 3).
    expect(answer).toMatchObject({ ok: false, error: { code: 'INTERNAL', retryable: false } })
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(hostLog(profile).some((record) => record.event === 'host.stop-all')).toBe(false)
    // The session, the Host, the app, its window and the tray all stay.
    expect(session?.alive(), 'the session that could not be ended keeps running').toBe(true)
    expect(isProcessAlive(hostPid), 'the Host keeps running').toBe(true)
    expect(app.process().exitCode, 'the app keeps running').toBeNull()
    expect(await anyWindowVisible(app), 'a window shows the answer').toBe(true)
    expect(trayEvents(profile), 'the icon stays').toEqual(['shown'])
  })
})
