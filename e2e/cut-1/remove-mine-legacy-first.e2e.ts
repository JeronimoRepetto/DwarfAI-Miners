import { expect, test } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import path from 'node:path'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import { observedDwarfs, STUB_MINE_NAME } from './claudeStubWorld.ts'
import {
  seedLegacyLaunchedStubSession,
  type LegacyLaunchedStubSession
} from './legacyLaunchedStubSession.ts'

/**
 * L9, cut 1 (ISSUE-123, the A-32 end-first case of ISSUE-090, review R7B-13; ADR-014; 21 §3 `LegacyEndFirstAdapter`):
 * once the switch routes A-32 `host`, Remove mine on a mine whose dwarf today's runtime launched first ends that launch
 * through today's identity-checked kill, waits for the Host to see the dwarf depart, and only then relays
 * `mines.remove`: the session's process is gone, the mine leaves the Host's board, and the Host recorded the dwarf as
 * departed because its process closed elsewhere, never as one it ended itself for the removal (`mine-removed`), which
 * is what a relay sent before the legacy end gives (the Host can end this session too: its registry names the
 * process identity).
 */

test.describe.configure({ timeout: 240_000 })

interface MineRow {
  id: string
  name: string
}

test.describe('cut 1: Remove mine ends legacy-launched sessions first (ISSUE-123)', () => {
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

  test('[ADR-014] Remove mine ends a legacy-launched fixture session first and then removes the mine', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      // Today's runtime reads its Claude roots from CLAUDE_CONFIG_DIRS (default `~/.claude`); the Host reads
      // CLAUDE_CONFIG_DIR. Both name the profile's own folder.
      env: (p) => ({ CLAUDE_CONFIG_DIRS: p.claudeConfigDir }),
      beforeLaunch: async (p) => {
        session = await seedLegacyLaunchedStubSession(p)
      },
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched
    await waitForHostAttached(owned)
    await expect
      .poll(async () => (await observedDwarfs(window)).map((d) => [d.mineName, d.presence]), {
        timeout: 60_000,
        message: 'the Host observes the legacy-launched session as a present dwarf'
      })
      .toEqual([[STUB_MINE_NAME, 'present']])
    expect(session?.alive(), 'today’s runtime adopted the running fixture session').toBe(true)

    const mines = (await window.evaluate(
      "window.api.getHostSnapshot({ sections: ['mines'] }).then((a) => a.ok ? a.value.chunks.flatMap((c) => c.data) : [])"
    )) as MineRow[]
    const mine = mines.find((row) => row.name === STUB_MINE_NAME)
    expect(mine, 'the mine of the session').toBeDefined()

    const answer = await window.evaluate(`window.api.undeclareMine(${JSON.stringify(mine!.id)})`)
    expect(answer).toEqual({ outcome: 'removed' })
    expect(session?.exitedAt(), 'the legacy-launched session was ended first').not.toBeNull()
    await expect
      .poll(
        async () =>
          (
            (await window.evaluate(
              "window.api.getHostSnapshot({ sections: ['mines'] }).then((a) => a.ok ? a.value.chunks.flatMap((c) => c.data) : [])"
            )) as MineRow[]
          ).map((row) => row.id),
        { timeout: 15_000, message: 'the mine leaves the Host board' }
      )
      .not.toContain(mine!.id)

    // Read only after the Host exited (the single writer, ADR-002 D1).
    await launched.teardown({ stopEverything: true })
    launched = undefined
    const db = openHostDatabaseReadOnly(owned)
    try {
      const causes = db.prepare('SELECT departure_cause AS cause FROM dwarfs').all() as Array<{
        cause: string | null
      }>
      expect(
        causes.map((row) => row.cause),
        'the dwarf departed when today’s runtime ended it'
      ).toEqual(['closed-elsewhere'])
    } finally {
      db.close()
    }
  })
})
