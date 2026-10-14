import { randomBytes } from 'node:crypto'
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
import { STUB_BIN } from '../_harness/stubs.ts'
import {
  claudeSettings,
  foreignLine,
  hookCommands,
  isHostEntry,
  seedForeignEntry,
  welcomeStep
} from './claudeHooksWorld.ts'

/**
 * L9, cut 2 (ISSUE-141, moved from ISSUE-221, review R8B-03; AMENDMENT-7; ADR-016 items 1, 6, 7): the "Claude Code ·
 * instant updates" switch, A-N31 `setClaudeHooksEnabled`, routed `host` by the cut-2 switch, writes DwarfAI's own hook
 * entry into the profile's `CLAUDE_CONFIG_DIR` and removes it again, the person's own hook keeping its bytes.
 *
 * Package gap, reported with ISSUE-141: this tree composes no Settings → Integrations row for the switch yet (the
 * `useClaudeHooksSettings` composable of ISSUE-221 has no component), so the case calls A-N31 through the renderer's
 * own `window.api`, the member the row will call, and proves the route and the Host's writer end to end; the row's
 * click is the UI issue's to add.
 */

test.describe.configure({ timeout: 180_000 })

/** The renderer's `window.api` member the case calls, as `evaluate` reaches it. */
interface RendererApi {
  api: { setClaudeHooksEnabled(request: unknown): Promise<unknown> }
}

/** A UUIDv7 (RFC 9562) for one intent (14 §1.6). */
function uuidV7(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

test.describe('cut 2: the Claude Code hooks switch (ISSUE-141)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-SET-013.AC01, US-SET-013.AC04] with a temp CLAUDE_CONFIG_DIR the Settings toggle writes and removes the hook entry with a foreign entry byte-identical', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    seedForeignEntry(owned)
    const before = claudeSettings(owned)
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const { window } = launched
    // The first-run step is due on this clean profile (Claude stub installed): it is answered first, with the option
    // off, so nothing is written by it and the switch alone turns the entry on (07 S41.06).
    const step = welcomeStep(window)
    await expect(step.options).toBeVisible({ timeout: 60_000 })
    await step.toggles.first().click()
    await step.activate.click()
    await expect(step.dialog).toBeHidden({ timeout: 30_000 })
    expect(claudeSettings(owned)).toBe(before)
    const set = (on: boolean) =>
      window.evaluate(
        ([value, requestId]) =>
          (globalThis as unknown as RendererApi).api.setClaudeHooksEnabled({
            on: value as boolean,
            requestId: requestId as string
          }),
        [on, uuidV7()] as const
      )

    // On: the Host writes its own entry, the person's hook keeps its bytes.
    const turnedOn = (await set(true)) as { ok: boolean; value?: { ok: boolean } }
    expect(turnedOn.ok, 'A-N31 is routed in cut 2').toBe(true)
    await expect
      .poll(() => hookCommands(claudeSettings(owned)).filter(isHostEntry).length, {
        timeout: 30_000,
        message: 'the Host writes its entry'
      })
      .toBeGreaterThan(0)
    expect(foreignLine(claudeSettings(owned))).toBe(foreignLine(before))

    // Off: the Host's entry is removed, and the person's hook is still there, byte for byte (ADR-016 item 7).
    const turnedOff = (await set(false)) as { ok: boolean }
    expect(turnedOff.ok).toBe(true)
    await expect
      .poll(() => hookCommands(claudeSettings(owned)).filter(isHostEntry).length, {
        timeout: 30_000,
        message: 'the Host removes its entry'
      })
      .toBe(0)
    expect(foreignLine(claudeSettings(owned))).toBe(foreignLine(before))
    expect(hookCommands(claudeSettings(owned))).toEqual(hookCommands(before))
  })
})
