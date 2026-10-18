import { expect, test } from '@playwright/test'
import { t } from '../../src/contracts/text/copy/index.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
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
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'
import {
  createClaudeStreamWorld,
  hostSection,
  killHostOnce,
  launchClaude,
  seedMine,
  stubOnlyPath
} from './claudeStreamWorld.ts'

/**
 * L9, step 3a (ISSUE-001 test 5, moved from ISSUE-330, review R7V-04; TC-001-07; ADR-015 item 5; 13 CH-01): a
 * Host-launched Claude session that cannot come back after the Host is killed. The Host restarts (UI main starts it
 * again, ADR-002 D9), its recovery pass tries the session's resume and the Claude stub refuses it (`world.json`
 * `resume: 'refuse'`: an error `result` before `system/init`, the recorded failing start of S-020-1), so the Host's
 * report lists the dwarf; the window shows ONE grouped recovery message (ISSUE-330's `RecoveryMessage.vue`, the
 * owner-approved `recovery.message.*` copy) with Dismiss and Try again, and Dismiss (A-N11) settles it: the message
 * goes and the dwarf departs `recovery-dismissed` (OQ-43).
 *
 * Why a refused resume and not a driver without resume: the issue's case names a "no-resume" session, but the only
 * Claude driver of 3a resumes (`ClaudeStreamJsonDriver` `resume: 'cli-flag'`, SP-15), so no Host-launched Claude session
 * has `resume: 'none'` in 3a. A resume the CLI refuses is the session that cannot be resumed with this driver, and it
 * reaches the same one grouped message (`07` machine 16). The title is the issue's, unchanged (traceability).
 *
 * Runs after the 3a switch (writer 1 of ISSUE-001 WU-D): before it, the Claude launch, A-N10 and A-N11 are not routed
 * to the Host.
 */

test.describe.configure({ timeout: 300_000 })

interface RecoveryReport {
  hostEpoch: string
  state: string
  unrecovered: Array<{ dwarfId: string; reason: string }>
}

test.describe('step 3a: the recovery message after a Host kill (ISSUE-001, ISSUE-330)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-RES-009.AC03, CH-01] after a Host kill that leaves a no-resume session the window shows one grouped message with retry and dismiss', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createClaudeStreamWorld(owned, { resume: 'refuse' })
    launched = await launchApp({
      profile: owned,
      stubs: stubOnlyPath(world),
      pathOnly: true,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    // The Claude stub is installed, so the first-run step is due on this fresh profile (ISSUE-141): answered first.
    await answerFirstRunStep(window)
    const { mineId } = await seedMine(window, owned)
    const { dwarfId } = await launchClaude(window, mineId)

    await killHostOnce(window, owned)

    // The restarted Host could not resume the session: its report lists the dwarf.
    await expect
      .poll(
        async () =>
          (await hostSection<RecoveryReport | null>(window, 'recovery'))
            .flatMap((report) => report?.unrecovered ?? [])
            .map((item) => item.dwarfId),
        { timeout: 60_000, message: 'the Host reports the session it could not resume' }
      )
      .toContain(dwarfId)

    // ONE grouped message, naming the one dwarf, with Dismiss and Try again (never a toast, never one per dwarf).
    const message = window.getByRole('dialog', { name: t('recovery.message.title') })
    await expect(message).toHaveCount(1, { timeout: 30_000 })
    await expect(message).toBeVisible()
    await expect(message.locator('.dm-recovery__names li')).toHaveCount(1)
    const dismiss = message.getByRole('button', { name: t('recovery.message.dismiss') })
    await expect(dismiss).toBeVisible()
    await expect(message.getByRole('button', { name: t('recovery.message.retry') })).toBeVisible()

    // Dismiss (A-N11) settles the report: the message goes.
    await dismiss.click()
    await expect(message).toHaveCount(0, { timeout: 30_000 })

    // Read only after the Host exited (the single writer, ADR-002 D1): Dismiss walked the dwarf out (OQ-43).
    await launched.teardown({ stopEverything: true })
    launched = undefined
    const db = openHostDatabaseReadOnly(owned)
    try {
      const row = db
        .prepare('SELECT departure_cause AS cause FROM dwarfs WHERE id = ?')
        .get(dwarfId) as { cause: string | null } | undefined
      expect(row?.cause, 'the dismissed dwarf departed').toBe('recovery-dismissed')
    } finally {
      db.close()
    }
  })
})
