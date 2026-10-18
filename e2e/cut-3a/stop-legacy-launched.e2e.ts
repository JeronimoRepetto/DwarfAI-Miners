import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import { observedDwarfs, STUB_MINE_NAME } from '../cut-1/claudeStubWorld.ts'
import {
  seedLegacyLaunchedStubSession,
  type LegacyLaunchedStubSession
} from '../cut-1/legacyLaunchedStubSession.ts'
import { uuidv7 } from './claudeStreamWorld.ts'

/**
 * L9, step 3a (ISSUE-001 test 7, moved from ISSUE-178, review R8B-03; ADR-014; 21 §3 `LegacyEndFirstAdapter`): once the
 * 3a switch routes A-N29 `host` through `LegacyEndFirstAdapter`, "Stop dwarf…" of a session the old app launched ends
 * that launch through today's identity-checked kill, waits for the Host to see the dwarf depart, and only then relays
 * `crew.stop` (B-M21). The session is the cut-1 legacy-launched world (`legacyLaunchedStubSession.ts`): the Host
 * observes it as a present dwarf, today's runtime holds its launch. The Host can end this session too (its registry
 * names the process identity), so the departure cause tells the two paths apart: `closed-elsewhere` when today's kill
 * ended it first, `stopped` when a relay sent first let the Host end it.
 *
 * Runs after the 3a switch (writer 1 of ISSUE-001 WU-D): before it, A-N29 has no route.
 */

test.describe.configure({ timeout: 240_000 })

test.describe('step 3a: Stop dwarf ends a legacy-launched session first (ISSUE-001, ISSUE-178)', () => {
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

  test('[ADR-014] Stop dwarf of a session the old app launched ends it and the dwarf walks out', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      // Today's runtime reads its Claude roots from CLAUDE_CONFIG_DIRS; the Host reads CLAUDE_CONFIG_DIR. Both name the
      // profile's own folder.
      env: (p) => ({ CLAUDE_CONFIG_DIRS: p.claudeConfigDir }),
      beforeLaunch: async (p) => {
        session = await seedLegacyLaunchedStubSession(p)
      },
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched
    await waitForHostAttached(owned)
    let dwarfId: string | undefined
    await expect
      .poll(
        async () => {
          const dwarfs = await observedDwarfs(window)
          dwarfId = dwarfs[0]?.id
          return dwarfs.map((d) => [d.mineName, d.presence])
        },
        {
          timeout: 60_000,
          message: 'the Host observes the legacy-launched session as a present dwarf'
        }
      )
      .toEqual([[STUB_MINE_NAME, 'present']])
    const id = dwarfId
    if (id === undefined) throw new Error('the Host observes no dwarf')
    expect(session?.alive(), 'today’s runtime adopted the running fixture session').toBe(true)

    const answer = await window.evaluate(
      `window.api.stopDwarf(${JSON.stringify({ dwarfId: id, requestId: uuidv7() })})`
    )
    expect(answer, 'A-N29 answers the session ended').toMatchObject({
      ok: true,
      value: { ok: true }
    })
    expect(session?.exitedAt(), 'the legacy-launched session was ended').not.toBeNull()
    await expect
      .poll(
        async () => {
          const dwarf = (await observedDwarfs(window)).find((d) => d.id === id)
          return dwarf === undefined || dwarf.presence === 'walking-out'
        },
        { timeout: 30_000, message: 'the dwarf walks out' }
      )
      .toBe(true)

    // Read only after the Host exited (the single writer, ADR-002 D1).
    await launched.teardown({ stopEverything: true })
    launched = undefined
    const db = openHostDatabaseReadOnly(owned)
    try {
      const row = db.prepare('SELECT departure_cause AS cause FROM dwarfs WHERE id = ?').get(id) as
        { cause: string | null } | undefined
      expect(row?.cause, 'today’s kill ended the session before the relay').toBe('closed-elsewhere')
    } finally {
      db.close()
    }
  })
})
