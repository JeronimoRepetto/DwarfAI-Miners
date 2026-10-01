import { expect, test } from '@playwright/test'
import {
  chooseTrayItem,
  homeIn,
  isProcessAlive,
  launchApp,
  profileHostPid,
  TRAY_ITEMS,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'

/**
 * L9, cut 0 (moved from ISSUE-316, review R8B-02; TC-056-06; ADR-002 D9; 13 FM-007): the Host is killed three times
 * within five minutes (CH-02, each time after UI main started it again), and the Panel shows the one crash-loop message
 * with Retry; Retry asks main (A-N05) and the Host is reached again; and the dwarfs the board shows stay drawn
 * throughout. The board is the simulated valley of today's runtime (`skills/simulated-valley`), with the Panel open on
 * one of its mines.
 *
 * What this world cannot show stays at L2, where ISSUE-316's `App.messageDock.test.ts` carries it (orchestrator
 * decision 2026-10-02, option (a)): the composer keeping its draft, and the composer and the Host-owned actions sending
 * nothing while the Host is down. A composer takes text only for a dwarf with a text channel, and no fixture world has
 * one yet: the simulated valley's dwarfs have none (`SimulatedProvider.textDelivery` answers null) and the ISSUE-313 stub
 * CLIs do not speak stream-json. Forward note: the L9 draft-kept case is added when a dwarf with a text channel exists in
 * a fixture world (ISSUE-143's `SimulatedDriver`, or a stream-json stub CLI).
 */

test.describe.configure({ timeout: 300_000 })

/** The simulated valley: two mines, a small crew, frozen so the board does not change on its own. */
const VALLEY: Readonly<Record<string, string>> = {
  DWARFAI_SIMULATE: '1',
  DWARFAI_SIMULATE_SEED: 'host-connection-ui',
  DWARFAI_SIMULATE_MINES: '2',
  DWARFAI_SIMULATE_CREW: '3',
  DWARFAI_SIMULATE_ANIMATE: 'false',
  DWARFAI_SIMULATE_STEP_MS: '600000'
}

/** Ends the profile's running Host (CH-02) and waits until UI main started the next one, unless `last`. */
async function killHost(profile: IsolatedProfile, last: boolean): Promise<void> {
  const pid = profileHostPid(profile.userDataDir)
  if (pid === null) throw new Error('no Host runs for the profile')
  process.kill(pid)
  await expect.poll(() => isProcessAlive(pid), { timeout: 15_000 }).toBe(false)
  if (last) return
  await expect
    .poll(
      () => {
        const next = profileHostPid(profile.userDataDir)
        return next !== null && next !== pid && isProcessAlive(next)
      },
      { timeout: 60_000, message: 'UI main starts the Host again after a crash' }
    )
    .toBe(true)
}

test.describe('cut 0: the Host connection in the Panel (ISSUE-316)', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown()
    launched = undefined
  })

  test("[FM-007, CH-02] after three Host kills within five minutes the Panel shows one crash-loop message with Retry, Retry reaches the Host again, and the board's dwarfs stay drawn", async () => {
    launched = await launchApp({
      trayProbe: true,
      env: (profile) => ({ ...homeIn(profile), ...VALLEY }),
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window, profile } = launched
    await waitForHostAttached(profile)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await window.locator('.dm-marker').first().click()
    const dwarfs = window.locator('.dm-dwarf')
    await expect(dwarfs.first()).toBeVisible({ timeout: 30_000 })
    const drawn = await dwarfs.count()
    expect(drawn, 'the open mine draws its crew').toBeGreaterThan(0)

    for (const kill of [1, 2, 3]) await killHost(profile, kill === 3)

    // One message, the crash-loop variant, with its Retry; no Host is started again until the person asks.
    const message = window.locator('.dm-host-state')
    await expect(message).toHaveCount(1)
    await expect(message).toHaveAttribute('data-variant', 'crash-loop', { timeout: 30_000 })
    expect(await window.evaluate('window.api.getHostConnection()')).toEqual({
      state: 'unavailable',
      reason: 'crash-loop'
    })
    const left = profileHostPid(profile.userDataDir)
    expect(left === null || !isProcessAlive(left), 'nothing respawns in a crash loop').toBe(true)
    await expect(dwarfs, 'the board keeps its dwarfs').toHaveCount(drawn)

    // Retry: main starts the Host again and the Panel follows; the crash-loop message goes.
    await message.getByRole('button').click()
    await waitForHostAttached(profile)
    await expect
      .poll(
        async () =>
          ((await window.evaluate('window.api.getHostConnection()')) as { state: string }).state,
        {
          timeout: 60_000
        }
      )
      .toBe('connected')
    await expect(window.locator('.dm-host-state[data-variant="crash-loop"]')).toHaveCount(0)
    await expect(dwarfs, 'the board still keeps its dwarfs').toHaveCount(drawn)
  })
})
