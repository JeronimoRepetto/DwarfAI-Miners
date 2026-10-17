import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  TRAY_ITEMS,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import {
  seedLegacyLaunchedStubSession,
  type LegacyLaunchedStubSession
} from '../cut-1/legacyLaunchedStubSession.ts'

/**
 * L9 (ISSUE-257; US-MSG-009.AC06, US-RES-003.AC04, NFR-PERS-06; ADR-024; PO decision 2026-09-28 #67): a draft lives
 * for the app run only. A draft typed into a dwarf's composer comes back when its chat is opened again in the same run,
 * and after the app closes and reopens on the same profile it is gone, even though the dwarf's session is still alive:
 * the app is quit on its own, so the Host and the session keep running and the reopened app attaches to them. The
 * session is the cut-1 world's legacy-launched Claude stub session (a sleeper process standing for its CLI), whose
 * composer takes text today; a purely observed session's does not.
 */

test.describe.configure({ timeout: 240_000 })

/** The Panel's board, opened on the mine, with its one dwarf's chat open. */
async function openTheDwarfsChat(window: Page): Promise<void> {
  await window.locator('.dm-marker').first().click({ timeout: 60_000 })
  await window.locator('.dm-dwarf').first().click({ timeout: 30_000 })
  await expect(window.locator('.dm-msg .dm-composer textarea')).toBeVisible({ timeout: 30_000 })
}

test.describe('drafts are kept for the app run only (ISSUE-257)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined
  let session: LegacyLaunchedStubSession | undefined

  test.afterEach(async () => {
    session?.dispose()
    session = undefined
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-MSG-009.AC06, US-RES-003.AC04, NFR-PERS-06] after the app closes and reopens every draft is gone and the composer is empty, even for a live session', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const stubs = path.join(STUB_BIN, 'claude')
    // Today's runtime reads its Claude roots from CLAUDE_CONFIG_DIRS; the Host reads CLAUDE_CONFIG_DIR.
    const env = (p: IsolatedProfile) => ({ CLAUDE_CONFIG_DIRS: p.claudeConfigDir })
    launched = await launchApp({
      profile: owned,
      stubs,
      env,
      trayProbe: true,
      beforeLaunch: async (p) => {
        session = await seedLegacyLaunchedStubSession(p)
      },
      tracePath: test.info().outputPath('trace-first.zip')
    })
    await waitForHostAttached(owned)
    await chooseTrayItem(launched.app, TRAY_ITEMS.open)
    await answerFirstRunStep(launched.window)
    await openTheDwarfsChat(launched.window)

    // The draft is kept while the app runs: closed and opened again, the chat puts it back.
    const draft = 'Half a thought, never sent.'
    const well = launched.window.locator('.dm-msg .dm-composer textarea')
    await well.fill(draft)
    await launched.window.locator('.dm-msg__close').click()
    await expect(launched.window.locator('.dm-msg')).toHaveCount(0)
    await launched.window.locator('.dm-dwarf').first().click()
    await expect(well, 'the draft is kept for the app run').toHaveValue(draft)

    // The app closes on its own: the Host, and the session it observes, keep running (OQ-63).
    await launched.teardown()
    launched = undefined

    launched = await launchApp({
      profile: owned,
      stubs,
      env,
      trayProbe: true,
      tracePath: test.info().outputPath('trace-reopened.zip')
    })
    await waitForHostAttached(owned)
    expect(session?.alive(), 'the session is still alive across the reopen').toBe(true)
    await chooseTrayItem(launched.app, TRAY_ITEMS.open)
    await openTheDwarfsChat(launched.window)
    await expect(
      launched.window.locator('.dm-msg .dm-composer textarea'),
      'no draft is restored after a reopen'
    ).toHaveValue('')
  })
})
