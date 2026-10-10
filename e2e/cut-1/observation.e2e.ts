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
import { STUB_BIN } from '../_harness/stubs.ts'
import {
  observedDwarfs,
  seedClaudeStubSession,
  STUB_MINE_NAME,
  type ObservedDwarf
} from './claudeStubWorld.ts'

/**
 * L9, cut 1 (ISSUE-123; 21 §2 cut 1 exit "L9 observation … reopen"; US-RES-003, NFR-PERS-02, BR-07): the cut-1 board and
 * chat are the Host's. A session the claude stub replayed is observed by the Host, drawn on the Panel's board, and after
 * the app is closed (Stop everything and quit, so the Host goes too) and opened again on the same profile, the same
 * dwarf and the same conversation come back from the Host's database, with no row added.
 */

test.describe.configure({ timeout: 240_000 })

/** The Host's view of the one observed dwarf, once it holds its turn. */
async function oneObservedDwarf(window: Page): Promise<ObservedDwarf> {
  let seen: ObservedDwarf[] = []
  await expect
    .poll(
      async () => {
        seen = await observedDwarfs(window)
        return seen.map((d) => [d.providerId, d.mineName, d.messages.length])
      },
      { timeout: 60_000, message: 'the Host serves the observed dwarf and its turn' }
    )
    .toEqual([['claude', STUB_MINE_NAME, 2]])
  return seen[0]!
}

/** The Panel's board draws the mine and, opened, its one dwarf. */
async function boardDrawsTheDwarf(launched: LaunchedApp): Promise<void> {
  await chooseTrayItem(launched.app, TRAY_ITEMS.open)
  await launched.window.locator('.dm-marker').first().click({ timeout: 30_000 })
  await expect(launched.window.locator('.dm-dwarf')).toHaveCount(1, { timeout: 30_000 })
}

test.describe('cut 1: observation survives a close and reopen (ISSUE-123)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test("[US-RES-003.AC01, NFR-PERS-02, BR-07] a stub session's dwarf and conversation reappear after the app is closed and reopened", async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const stubs = path.join(STUB_BIN, 'claude')
    launched = await launchApp({
      profile: owned,
      stubs,
      trayProbe: true,
      tracePath: test.info().outputPath('trace-first.zip')
    })
    await waitForHostAttached(owned)
    // Seeded once the Host is up, so the stub session is written after the install moment: a
    // session whose newest record predates it, and whose process is not known to run, is history,
    // left to the coal backfill (owner decision 2026-10-10, ADR-006 item 8).
    seedClaudeStubSession(owned)
    const before = await oneObservedDwarf(launched.window)
    await boardDrawsTheDwarf(launched)

    // Closed: the app and its Host both end, so the reopened app reads only what the Host stored.
    await launched.teardown({ stopEverything: true })
    launched = undefined

    launched = await launchApp({
      profile: owned,
      stubs,
      trayProbe: true,
      tracePath: test.info().outputPath('trace-reopened.zip')
    })
    await waitForHostAttached(owned)
    const after = await oneObservedDwarf(launched.window)
    expect(after.id, 'the same dwarf').toBe(before.id)
    expect(after.messages, 'the same conversation, no row added').toEqual(before.messages)
    await boardDrawsTheDwarf(launched)
  })
})
