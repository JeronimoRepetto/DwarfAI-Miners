import path from 'node:path'
import { expect, test } from '@playwright/test'
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
import { seedClaudeStubSession } from '../cut-1/claudeStubWorld.ts'

/**
 * L9 (ISSUE-267; ADR-034 item 2; BR-19; 21 §1 item 8; 20 §8 R-03): a Panel build, as a person gets it, shows no control
 * whose destination is not built. The build's feature list ships the Panel alone
 * (`src/renderer/src/lib/shell/builtDestinations.ts`), so the nav draws no mode lever and Settings › General no "Mode
 * at launch" row, and the Add panel draws a chip only for a provider main offers to launch — never one for Antigravity,
 * whose launch the public build does not offer (R-03).
 *
 * The built app is the one every L9 case runs: it carries no setting a public build lacks, because the feature list
 * is the same in every build until Veta ships (EPIC-19). The Antigravity launch gate itself is the Host catalog's
 * (EPIC-09, out of this issue's scope); the stub kit has no Antigravity CLI, so this case proves the Panel's half: with
 * Claude installed and launchable, the row is Claude and Other, and nothing else.
 */

test.describe.configure({ timeout: 240_000 })

test.describe('the Panel build hides what is not built (ISSUE-267)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[ADR-034, BR-19] a public-style Panel build shows no mode lever, no Mode at launch row and no Antigravity launch chip', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    // A mine to open the Add panel in: one observed Claude session, written once the Host is up.
    seedClaudeStubSession(owned)

    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)

    // The nav: no lever, no side of it, no MODE label.
    const nav = window.locator('nav.dm-nav')
    await expect(nav, 'the nav is drawn').toBeVisible({ timeout: 30_000 })
    await expect(nav.locator('.dm-nav__lever'), 'no mode lever').toHaveCount(0)
    await expect(nav.getByRole('group', { name: 'Mode' })).toHaveCount(0)
    await expect(nav).not.toContainText('MODE')

    // Settings › General: no Mode at launch row.
    await nav.locator('.dm-slot[data-label="Settings"]').click()
    await window.locator('[role="tab"][data-s="General"]').click()
    const panel = window.locator('.dm-settings__panel')
    await expect(panel, 'General is shown').toContainText('Position', { timeout: 30_000 })
    await expect(panel).not.toContainText('Mode at launch')

    // The Add panel: Claude and Other, no Antigravity chip.
    await nav.locator('.dm-slot[data-label="Map"]').click()
    await window.locator('.dm-marker').first().click({ timeout: 60_000 })
    await window.locator('.dm-minecol__foot .dm-btn--primary').click({ timeout: 30_000 })
    const chips = window.locator('.dm-add__chips [data-value]')
    await expect(chips.first(), 'the chip row is drawn').toBeVisible({ timeout: 30_000 })
    await expect(window.locator('.dm-add__chips [data-value="claude"]')).toHaveCount(1)
    await expect(window.locator('.dm-add__chips [data-value="antigravity"]')).toHaveCount(0)
    await expect(window.locator('.dm-add__chips [data-value="other"]')).toHaveCount(1)
  })
})
