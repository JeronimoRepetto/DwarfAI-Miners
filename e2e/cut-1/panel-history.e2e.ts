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
import { STUB_BIN } from '../_harness/stubs.ts'
import { seedClaudeStubSession, type StubTurn } from './claudeStubWorld.ts'

/**
 * L9, cut 1 (ISSUE-123; ADR-033 item 3; 14 §4.3): the person opens the message panel on an observed dwarf by clicking it
 * on the board, and the panel draws the conversation the Host holds. Regression for PR #1273: a window that mounted
 * before the Host's `hello.ok` (a fresh profile, so the Host is spawned after the window loads) read its chat once,
 * was refused, and stopped following, so the panel said "Reading this session's latest activity…" for the window's
 * life while the Host held every row.
 */

test.describe.configure({ timeout: 240_000 })

/** The session's exchanges, oldest first: a few rows, so a partial or empty read cannot pass. */
const TURNS: readonly StubTurn[] = [
  { person: 'List the tunnels under the east gate.', dwarf: 'There are three tunnels under it.' },
  { person: 'Which one is the deepest?', dwarf: 'The middle tunnel goes deepest.' },
  { person: 'Mark it on the map.', dwarf: 'Marked the middle tunnel on the map.' }
]

/** The panel's note while the chat has not been read (`READING_NOTE`, lib/message/conversation.ts). */
const READING = /Reading this session's latest activity/

test.describe('cut 1: the message panel shows an observed dwarf’s history (ISSUE-123)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[ADR-033, S12.B01] a panel opened by clicking an observed dwarf draws its conversation and leaves the reading note', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    // The window is loaded, and its dock has mounted and read its chat once: on a fresh profile the Host is still
    // being spawned, which is the mount-before-hello order that left the panel reading forever.
    const atMount = (await window.evaluate('window.api.getHostConnection()')) as { state?: string }
    test.info().annotations.push({
      type: 'host connection when the window mounted',
      description: String(atMount.state)
    })

    await waitForHostAttached(owned)
    // Seeded once the Host is up, so the session is written after the install moment and observed as live
    // (owner decision 2026-10-10, ADR-006 item 8).
    seedClaudeStubSession(owned, TURNS)

    await chooseTrayItem(app, TRAY_ITEMS.open)
    await window.locator('.dm-marker').first().click({ timeout: 30_000 })
    const dwarf = window.locator('button.dm-dwarf[data-dwarf]')
    await expect(dwarf, 'the observed dwarf is drawn on its mine').toHaveCount(1, {
      timeout: 60_000
    })
    await dwarf.click()

    const log = window.locator('.dm-msg__log')
    await expect(log, 'the panel is open on the dwarf').toBeVisible({ timeout: 30_000 })
    for (const turn of TURNS) {
      await expect(log, 'every row the Host holds is drawn').toContainText(turn.person, {
        timeout: 30_000
      })
      await expect(log).toContainText(turn.dwarf)
    }
    await expect(
      window.locator('.dm-msg__note', { hasText: READING }),
      'the panel no longer says it is reading'
    ).toHaveCount(0)
  })
})
