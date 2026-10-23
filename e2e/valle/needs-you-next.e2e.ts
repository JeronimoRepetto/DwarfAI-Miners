import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  anyWindowVisible,
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
import {
  ASK_MARKER,
  asksOf,
  createClaudeStreamWorld,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (owner ruling 2026-10-23, VQA-02 and VQA-13; US-VALLE-004.AC01; 07 S34.05 as the ruling reads it): three stub
 * Claude dwarfs wait on you, each in its own mine. Each press of the "N need you" counter goes to the next one after the
 * dwarf it last jumped to, round the queue (`DS` valle.js `nextNeed`): the oldest, then the second, then the third, and
 * each jump ends with the keyboard in that dwarf's chat, never left on the counter. Stub CLIs only; no OS dialog.
 */

test.describe.configure({ timeout: 300_000 })

/** The stub dwarf asks for its Write tool (`claudeStreamStub.mjs` ASK_MARKER); answers once its ask is open. */
async function startAsking(window: Page, dwarfId: string): Promise<void> {
  const sent = (await window.evaluate(
    `window.api.sendDwarfText(${JSON.stringify({
      dwarfId,
      text: `Please write the ${ASK_MARKER}.`,
      attachments: [],
      requestId: uuidv7()
    })})`
  )) as { ok: boolean; value?: { ok: boolean } }
  expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true, value: { ok: true } })
  await expect
    .poll(
      async () =>
        (await asksOf(window)).some((ask) => ask.dwarfId === dwarfId && ask.state === 'open'),
      { timeout: 60_000, message: 'the stub’s permission request opens an ask' }
    )
    .toBe(true)
}

/** The dwarf whose chat holds the keyboard, never a motion ghost's copy; `null` when the keyboard is elsewhere. */
function keyboardChat(valle: Page): Promise<string | null> {
  return valle.evaluate(`(() => {
    const active = document.activeElement
    if (active === null || active.closest('.dm-vghosts') !== null) return null
    return active.closest('[data-valle-chat]')?.getAttribute('data-valle-chat') ?? null
  })()`) as Promise<string | null>
}

test.describe('the needs-you counter goes round the queue (owner ruling 2026-10-23)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-004.AC01, S34.05] three presses with three waiters reach each in turn, the keyboard in its chat', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createClaudeStreamWorld(owned)
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
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    const dwarfIds: string[] = []
    for (const name of ['alpha', 'beta', 'gamma']) {
      const folder = path.join(owned.root, name)
      mkdirSync(folder, { recursive: true })
      const mineId = await declareMine(app, window, folder)
      dwarfIds.push((await launchClaude(window, mineId)).dwarfId)
    }
    // Asked in this order: the Host's queue is oldest first (ADR-032 D6).
    for (const dwarfId of dwarfIds) await startAsking(window, dwarfId)

    const valle = await showValle(app, window)
    await valleSettled(valle)
    await expect(valle.locator('[data-valle-root]')).toHaveAttribute('data-motion', 'none')
    const counter = valle.locator('[data-needs-counter]')
    await expect(counter).toContainText('3 need you', { timeout: 30_000 })
    await expect(counter).toHaveAttribute('title', 'Jump to the next dwarf waiting on you')
    await expect(counter).toHaveAttribute('aria-label', '3 waiting on you. Jump to the next one')
    await expect(valle.locator('.dm-vq__entry').first()).toHaveAttribute('data-id', dwarfIds[0]!)

    for (const dwarfId of dwarfIds) {
      await counter.click()
      await expect(valle.locator('.dm-cstack__open:not(.dm-vghosts *)')).toHaveAttribute(
        'data-pin',
        dwarfId
      )
      await expect
        .poll(() => keyboardChat(valle), {
          timeout: 15_000,
          message: 'the keyboard moves into the jumped-to dwarf’s chat'
        })
        .toBe(dwarfId)
    }
    // Round the queue: the fourth press is the oldest again.
    await counter.click()
    await expect(valle.locator('.dm-cstack__open:not(.dm-vghosts *)')).toHaveAttribute(
      'data-pin',
      dwarfIds[0]!
    )
    await expect.poll(() => keyboardChat(valle), { timeout: 15_000 }).toBe(dwarfIds[0]!)
    await expect(valle.locator('[data-valle-root]')).toHaveAttribute('data-preset', 'control')
  })
})
