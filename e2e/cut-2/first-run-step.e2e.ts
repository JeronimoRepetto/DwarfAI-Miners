import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { buildHookCommand } from '../../src/main/hooks/hookCommand.ts'
import { NodeHookFs } from '../../src/main/hooks/hookFs.ts'
import { installClaudeHooks } from '../../src/main/hooks/hookInstaller.ts'
import {
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import {
  claudeSettings,
  foreignLine,
  hookCommands,
  isHostEntry,
  isOldAppEntry,
  persistedIngressPort,
  seedForeignEntry,
  welcomeStep
} from './claudeHooksWorld.ts'

/**
 * L9, cut 2 (ISSUE-141, moved from ISSUE-223, review R8B-03; 18 §4.5 T-46; ADR-016 items 5–7; 21 §4 row "Claude hook
 * entry"): a Claude hook entry the old app wrote is never adopted silently. The first-run consent step asks; Activate
 * with Claude Code on replaces it with DwarfAI's own entry (own ingress, own channel token), and with it off reverts it
 * (removed); the person's own hook keeps its bytes either way. Until the answer, a call carrying the old entry's token
 * is refused `401` at the Host's ingress, whose channel tokens never hold it.
 *
 * The old entry is written by the old app's own installer (`src/main/hooks/hookInstaller.ts`), byte for byte what a
 * person upgrading has on disk. Its call target is the old app's loopback route, which from cut 2 no build composes
 * (TC-141-06); the token is also posted to the Host's ingress, the one listener of this build, whose port the first
 * start persisted (`app_meta.ingress_port`, read after that Host exited).
 */

test.describe.configure({ timeout: 300_000 })

const CLAUDE_STUB = path.join(STUB_BIN, 'claude')

/** The old app's per-install token (`hookToken.ts`: lowercase hex). */
const OLD_TOKEN = randomBytes(16).toString('hex')

/** The old app's loopback port (`config.hooksPort`): any free-looking number; nothing listens there from cut 2. */
const OLD_PORT = 47_651

test.describe('T-46 old-app entries (18 §4.5)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  /**
   * A profile whose Host has started once (its ingress port persisted, the clean-profile step answered with nothing
   * ticked, so nothing of DwarfAI's is in the file), then the old app's entry written beside the person's own hook.
   */
  async function upgradedProfile(): Promise<{
    owned: IsolatedProfile
    port: number
    before: string
  }> {
    const owned = createIsolatedProfile()
    profile = owned
    seedForeignEntry(owned)
    launched = await launchApp({ profile: owned, stubs: CLAUDE_STUB })
    await waitForHostAttached(owned)
    const first = welcomeStep(launched.window)
    await expect(first.options).toBeVisible({ timeout: 60_000 })
    await first.toggles.first().click()
    await first.activate.click()
    await expect(first.dialog).toBeHidden({ timeout: 30_000 })
    await launched.teardown({ stopEverything: true })
    launched = undefined
    const port = persistedIngressPort(owned)
    expect(port, 'the first start persisted the ingress port').not.toBeNull()

    const reports = await installClaudeHooks({
      fs: new NodeHookFs(),
      roots: [owned.claudeConfigDir],
      command: buildHookCommand({ port: OLD_PORT, token: OLD_TOKEN, platform: process.platform })
    })
    expect(reports.map((report) => report.error)).toEqual([undefined])
    const before = claudeSettings(owned) ?? ''
    expect(hookCommands(before).filter(isOldAppEntry).length).toBeGreaterThan(0)
    return { owned, port: port as number, before }
  }

  /** Posts one hook call with the old entry's token to the Host's ingress, and answers the status. */
  async function oldTokenStatus(port: number): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}/hooks/claude/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dwarfai-token': OLD_TOKEN },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'old-app-session' })
    })
    return response.status
  }

  test('[US-SET-012.AC04, ADR-016] with an old-app Claude hook entry seeded, accept replaces it and decline removes it, and the old token got 401 before the answer', async () => {
    for (const accept of [true, false]) {
      const { owned, port, before } = await upgradedProfile()
      launched = await launchApp({
        profile: owned,
        stubs: CLAUDE_STUB,
        tracePath: test.info().outputPath(`trace-${accept ? 'accept' : 'decline'}.zip`)
      })
      await waitForHostAttached(owned)
      const step = welcomeStep(launched.window)

      // The old entry makes the step due again (07 S41.02, reason legacy-entries), and it is left as it was.
      await expect(step.options, 'the step asks about the old entry').toBeVisible({
        timeout: 60_000
      })
      expect(claudeSettings(owned)).toBe(before)
      // Never adopted silently: until the answer, the old token is refused at the Host's ingress (21 §4).
      expect(await oldTokenStatus(port), 'the old token before the answer').toBe(401)

      if (!accept) await step.toggles.first().click()
      await step.activate.click()
      await expect(step.dialog).toBeHidden({ timeout: 30_000 })

      await expect
        .poll(() => hookCommands(claudeSettings(owned)).filter(isOldAppEntry).length, {
          timeout: 30_000,
          message: accept ? 'accept replaces the old entry' : 'decline removes the old entry'
        })
        .toBe(0)
      const hostEntries = hookCommands(claudeSettings(owned)).filter(isHostEntry)
      if (accept) expect(hostEntries.length, 'DwarfAI’s own entry').toBeGreaterThan(0)
      else expect(hostEntries).toEqual([])
      expect(foreignLine(claudeSettings(owned))).toBe(foreignLine(before))

      await launched.teardown({ stopEverything: true })
      launched = undefined
      await disposeProfile(owned)
      profile = undefined
    }
  })
})
