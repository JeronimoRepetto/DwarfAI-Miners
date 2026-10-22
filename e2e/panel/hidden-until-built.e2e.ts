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
// The renderer's own filter of A-36 (`launchSourcesOf` in src/renderer/src/lib/launch/supplierEntries.ts, through
// src/renderer/src/types.ts): an entry it does not recognise draws no chip.
import { isDwarfProvider } from '../../src/contracts/wire/today.ts'
// The one built-modes list (17 §1.9; ISSUE-285): what the build under test contains, from its build profile.
import { builtModesOf } from '../../src/contracts/ipc/builtModes.ts'
import { seedClaudeStubSession } from '../cut-1/claudeStubWorld.ts'

/**
 * L9 (ISSUE-267; ADR-034 item 2; BR-19; 21 §1 item 8; 20 §8 R-03): a build shows no control whose destination it does
 * not contain. The mode lever is drawn exactly when the build's built-modes list holds a mode beside the Panel, with
 * one side per such mode; Settings › General draws "Mode at launch" with exactly the modes the list holds (ISSUE-294); and the Add panel draws a chip only for a provider main offers to launch — never
 * one for Antigravity, whose launch the public build does not offer (R-03).
 *
 * AMENDED for ISSUE-285 (was: a public-style Panel build, no lever and no "Mode at launch" row): the built-modes list
 * is build-time data now (17 §1.9), and the E2E lane builds with `DWARFAI_BUILD_PROFILE=e2e` (docs/e2e.md), whose list
 * holds Veta and Valle, so this build draws the lever. The case checks the lever against the list of the profile the
 * lane builds. A release build's list is the Panel alone, so it draws no lever and offers no "Mode at launch" choice:
 * proven at the unit level, where no build is needed (`builtModes.test.ts` `builtModesOf('release')`,
 * `builtDestinations.test.ts` over the release list).
 *
 * AMENDED for ISSUE-294 (was: the lane's profile alone, and no "Mode at launch" row in any build): a release build lists
 * Veta now, so the case reads the profile the build under test was built with (`DWARFAI_BUILD_PROFILE`, the E2E profile
 * when unset, as the lane builds it; docs/e2e.md) and holds in both: a release build draws "▼ Veta" alone and never a
 * Valle side or option, the E2E build both sides.
 *
 * The Antigravity launch gate itself is the Host catalog's (EPIC-09, out of this issue's scope); the stub kit has no
 * Antigravity CLI, so this case proves the Panel's half: the row is exactly what main offers (detected and launchable)
 * and Other, and nothing else.
 */

/**
 * The build profile of the build under test (docs/e2e.md): the E2E profile the lane builds, or the one named, so a
 * release build is checked the same way. Whether its list holds a mode beside the Panel.
 */
const LANE_PROFILE = process.env.DWARFAI_BUILD_PROFILE ?? 'e2e'
const OTHER_MODES = builtModesOf(LANE_PROFILE).filter((mode) => mode !== 'panel')
const OTHER_MODES_SHOWN = OTHER_MODES.length > 0

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

  test('[ADR-034, BR-19] the build shows a mode lever and Mode at launch options only for the modes it contains, and no Antigravity launch chip', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      // The app's PATH is the Claude stub and the node that runs it, nothing of this machine's: a developer's own
      // installed CLIs (an Antigravity among them) never decide what this case sees.
      stubs: [path.join(STUB_BIN, 'claude'), path.dirname(process.execPath)].join(path.delimiter),
      pathOnly: true,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    // A mine to open the Add panel in: one observed Claude session, written once the Host is up.
    seedClaudeStubSession(owned)

    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)

    // The nav: the lever, with its MODE label, exactly when the build contains a mode beside the Panel; one side per
    // mode it contains.
    const nav = window.locator('nav.dm-nav')
    await expect(nav, 'the nav is drawn').toBeVisible({ timeout: 30_000 })
    await expect(nav.locator('.dm-nav__lever'), 'the mode lever').toHaveCount(
      OTHER_MODES_SHOWN ? 1 : 0
    )
    await expect(nav.getByRole('group', { name: 'Mode' })).toHaveCount(OTHER_MODES_SHOWN ? 1 : 0)
    if (OTHER_MODES_SHOWN) await expect(nav).toContainText('MODE')
    else await expect(nav).not.toContainText('MODE')
    const lever = nav.getByRole('group', { name: 'Mode' })
    await expect(lever.locator('.dm-slot[data-label="▲ Valle"]')).toHaveCount(
      OTHER_MODES.includes('valle') ? 1 : 0
    )
    await expect(lever.locator('.dm-slot[data-label="▼ Veta"]')).toHaveCount(
      OTHER_MODES.includes('veta') ? 1 : 0
    )

    // Settings › General: "Mode at launch" (ISSUE-294) offers "Last used", "Panel" and each mode the list holds beside
    // the Panel, so no option names a mode the build does not contain.
    // AMENDED for ISSUE-294 (was: no Mode at launch row in any build): the row is drawn from the same list.
    await nav.locator('.dm-slot[data-label="Settings"]').click()
    await window.locator('[role="tab"][data-s="General"]').click()
    const panel = window.locator('.dm-settings__panel')
    await expect(panel, 'General is shown').toContainText('Position', { timeout: 30_000 })
    if (OTHER_MODES_SHOWN) await expect(panel).toContainText('Mode at launch')
    else await expect(panel).not.toContainText('Mode at launch')
    const named = { veta: 'Veta', valle: 'Valle' } as const
    await expect(panel.locator('select[aria-label="Mode at launch"] option')).toHaveText(
      OTHER_MODES_SHOWN
        ? [
            'Last used',
            'Panel',
            ...(['veta', 'valle'] as const)
              .filter((m) => OTHER_MODES.includes(m))
              .map((m) => named[m])
          ]
        : []
    )
    if (!OTHER_MODES.includes('valle')) await expect(panel).not.toContainText('Valle')

    // The Add panel: Claude and Other, no Antigravity chip.
    await nav.locator('.dm-slot[data-label="Map"]').click()
    await window.locator('.dm-marker').first().click({ timeout: 60_000 })
    await window.locator('.dm-minecol__foot .dm-btn--primary').click({ timeout: 30_000 })
    const chips = window.locator('.dm-add__chips [data-value]')
    await expect(chips.first(), 'the chip row is drawn').toBeVisible({ timeout: 30_000 })
    // The row is checked against main's own A-36 answer, never against what this machine is assumed to detect: the
    // legacy detector reads the Claude stub's Windows shim as unrunnable (it names a `.mjs`), so on a runner with no
    // real Claude the offered list is empty there and Claude is rightly absent. Exactly the offered providers (detected
    // and launchable) and Other, in main's order, is the rule; polled, so the row is read once the list arrived.
    const offered = async (): Promise<string[]> =>
      (await window.evaluate(async () => {
        // From step 3a A-36 answers the 14 shape: IpcResult<SupplierEntryView[]>.
        type Entry = { providerId: string; installed: boolean; publicLaunch: string }
        type Answer = { ok: true; value: Entry[] } | { ok: false }
        const api = (
          window as unknown as {
            api: { listAgentProviders(params: { refresh: boolean }): Promise<Answer> }
          }
        ).api
        const answer = await api.listAgentProviders({ refresh: true })
        return answer.ok
          ? answer.value
              .filter((entry) => entry.installed && entry.publicLaunch === 'enabled')
              .map((entry) => entry.providerId)
          : []
      })) as string[]
    // AMENDED for ISSUE-238 (was: every offered entry): from the step-4b switch A-36 is the Host's
    // `suppliers.launchable` whole, which in a development build also lists the dev-only simulated catalog entry
    // (15 §4.12) that `CatalogMergeAdapter` used to leave out. The renderer draws a chip only for a provider
    // `isDwarfProvider` recognises, so the expected row applies the same filter.
    const expected = [...(await offered()).filter((id) => isDwarfProvider(id)), 'other']
    await expect
      .poll(
        () => chips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-value'))),
        {
          timeout: 30_000,
          message: 'the chips are the offered providers and Other'
        }
      )
      .toEqual(expected)
    await expect(window.locator('.dm-add__chips [data-value="antigravity"]')).toHaveCount(0)
    await expect(window.locator('.dm-add__chips [data-value="other"]')).toHaveCount(1)
  })
})
