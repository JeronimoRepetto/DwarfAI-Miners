import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import {
  observedDwarfs,
  seedClaudeStubSession,
  STUB_MINE_NAME,
  STUB_TURN,
  type ObservedDwarf
} from './claudeStubWorld.ts'

/**
 * L9, cut 1 (ISSUE-123, moved from ISSUE-313, review R7V-01; ADR-008): with the kit's claude stub first on `PATH`, the
 * built app's cut-1 Host observes the session the stub replayed exactly once: one Claude dwarf in its mine, its one
 * turn, nothing more after further observation passes, and two message rows in `dwarfai.db` read after the Host exited.
 *
 * Package gap, reported to the lead with ISSUE-123: the "detects Claude as installed" half has no observable outcome in
 * the cut-1 build. The Host's start-up detection (ADR-009 D5, `host/wiring/suppliersWiring.ts`) only fills its
 * detection cache (AMENDMENT-10: nothing is pushed), no capability probe runs because the cut-1 build ships no driver,
 * so `capability_records` stays empty, and no seam-A row born by cut 1 reads the catalogue. The case asserts the
 * observation half only until a later step exposes detection.
 */

test.describe.configure({ timeout: 180_000 })

/** Longer than two of the Host's observation passes (2 s each), so a second ingestion would have happened. */
const SEVERAL_PASSES_MS = 6_000

test.describe('cut 1: a stub CLI session observed by the Host (ISSUE-123)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test("[ADR-008] with the claude stub first on PATH the launched app's Host detects Claude as installed and observes the replayed session once", async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      beforeLaunch: async (p) => {
        seedClaudeStubSession(p)
      },
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched

    let seen: ObservedDwarf[] = []
    await expect
      .poll(
        async () => {
          seen = await observedDwarfs(window)
          return seen.map((d) => [d.providerId, d.mineName, d.messages.length])
        },
        { timeout: 60_000, message: 'the Host observes the replayed session' }
      )
      .toEqual([['claude', STUB_MINE_NAME, 2]])
    expect(seen[0]?.presence).toBe('present')
    expect(
      [...(seen[0]?.messages ?? [])].reverse().map((m) => [m.role, m.text]),
      'the one turn, oldest first'
    ).toEqual([
      ['person', STUB_TURN.person],
      ['dwarf', STUB_TURN.dwarf]
    ])

    // Once: further observation passes neither add a dwarf nor a message.
    await window.waitForTimeout(SEVERAL_PASSES_MS)
    const again = await observedDwarfs(window)
    expect(again.map((d) => d.id)).toEqual(seen.map((d) => d.id))
    expect(again[0]?.messages.map((m) => m.id)).toEqual(seen[0]?.messages.map((m) => m.id))

    // The Host's own record, read only after it exited (the single writer, ADR-002 D1).
    await launched.teardown({ stopEverything: true })
    launched = undefined
    const db = openHostDatabaseReadOnly(owned)
    try {
      const stored = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
      expect(stored.n, 'each record of the session is stored once').toBe(2)
    } finally {
      db.close()
    }
  })
})
