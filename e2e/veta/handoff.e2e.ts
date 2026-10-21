import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
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
  chatOf,
  createClaudeStreamWorld,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { declareMine, risenContent, showVeta } from '../support/veta.ts'

/**
 * L9 (ISSUE-293; 07 machine 9, S24.12, S24.18; UC-051; ADR-024 item 3, ADR-025 item 3; 17 §1.9; S-025-1): in the E2E
 * build profile, whose built-modes list contains Veta (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, docs/e2e.md), a chat
 * moves between Veta and the Panel as the same chat. A stub Claude dwarf has said enough for its chat to scroll; the
 * chat rises in Veta, is scrolled up, gets a draft and a backward composer selection, and moves to the Panel by its
 * "▢ Open in the Panel", back to Veta (the Panel lever is ISSUE-294's, so the move is asked the way the lever will ask
 * it, A-N13 from the Panel's renderer, naming the open chat) and to the Panel again: the draft, the selection and the
 * first message in view are the same each time, and no window is created or destroyed on the way, so no taskbar button
 * appears. "▲" by Tab and Enter, or Space, moves to the Panel. A composition in progress (an input method, driven over
 * the DevTools protocol) ends at the switch, its text travelling in the draft: the OS outcome is S-025-1's record.
 *
 * Screenshots go to `DWARFAI_E2E_SHOTS` when it names a folder (a person's live check); nothing is written otherwise.
 * The page's own scripts are strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 420_000 })

/** What a chat shows: its draft, its composer selection and the first conversation row in view. */
interface ChatState {
  draft: string
  selection: [number, number, string]
  firstInView: string
  scrolledUp: boolean
}

/** The chat state of the MessagePanel inside `scope` (`[data-veta-risen]` in Veta, the dock in the Panel). */
function chatState(page: Page, scope: string): Promise<ChatState | null> {
  return page.evaluate(`(() => {
    const panel = document.querySelector(${JSON.stringify(scope + ' .dm-msg')})
    if (panel === null) return null
    const field = panel.querySelector('.dm-composer textarea')
    const log = panel.querySelector('.dm-msg__log')
    const top = log.getBoundingClientRect().top
    const rows = [...log.querySelectorAll('.dm-bubble')]
    const first = rows.find((row) => row.getBoundingClientRect().bottom > top + 1)
    return {
      draft: field.value,
      selection: [field.selectionStart, field.selectionEnd, field.selectionDirection],
      firstInView: first === undefined ? '' : first.textContent.trim().slice(0, 80),
      scrolledUp: log.scrollHeight - log.clientHeight - log.scrollTop > 2
    }
  })()`) as Promise<ChatState | null>
}

/** Every BrowserWindow's id, read in the main process: a window created or destroyed would show a taskbar button. */
function windowIds(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map((w) => w.id)
      .sort((a, b) => a - b)
  )
}

/** Which mode window is shown: `panel`, `veta`, both or none. */
function shownModes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible())
      .map((w) => (w.webContents.getURL().includes('mode=veta') ? 'veta' : 'panel'))
      .sort()
  )
}

/** Saves a screenshot of `page` as `name` when `DWARFAI_E2E_SHOTS` names a folder. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['DWARFAI_E2E_SHOTS']
  if (dir === undefined || dir === '') return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

test.describe('the chat hand-off between Veta and the Panel (ISSUE-293)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-DLG-006.AC03, US-VETA-009.AC03, ADR-025] Panel to Veta to Panel with a scrolled-up chat, a draft and a composer selection keeps all three identical, and no taskbar button flickers', async () => {
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

    const folder = path.join(owned.root, 'moria')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    const { dwarfId } = await launchClaude(window, mineId)
    // Enough said for the chat to scroll: each message waits for its reply.
    for (let i = 1; i <= 8; i += 1) {
      const before = (await chatOf(window, dwarfId)).length
      const sent = (await window.evaluate(
        `window.api.sendDwarfText(${JSON.stringify({
          dwarfId,
          text: `Message ${i}: look at the seam under the third pillar and say what you see there.`,
          attachments: [],
          requestId: uuidv7()
        })})`
      )) as { ok: boolean }
      expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true })
      await expect
        .poll(async () => (await chatOf(window, dwarfId)).length, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(before + 2)
    }

    // The chat rises in Veta, scrolled up, with a draft and a backward selection.
    const veta = await showVeta(app, window)
    const dwarf = veta.locator(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)
    await expect(dwarf).toBeVisible({ timeout: 60_000 })
    await dwarf.click()
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('chat')
    await shot(veta, '0-veta-chat-risen')
    const composer = veta.locator('[data-veta-risen] .dm-msg textarea')
    await composer.pressSequentially('half a thought about the seam')
    await veta.evaluate(`(() => {
      const log = document.querySelector('[data-veta-risen] .dm-msg__log')
      log.scrollTop = Math.floor((log.scrollHeight - log.clientHeight) / 3)
      document.querySelector('[data-veta-risen] .dm-msg textarea').setSelectionRange(5, 12, 'backward')
    })()`)
    const inVeta = await chatState(veta, '[data-veta-risen]')
    expect(inVeta, 'the risen chat is drawn').not.toBeNull()
    expect(inVeta!.scrolledUp, 'the chat holds enough rows to be scrolled up').toBe(true)
    await shot(veta, '1-veta-chat-before')
    const ids = await windowIds(app)

    // "▢ Open in the Panel": the Panel on this dwarf's mine and chat, the same three.
    await veta.locator('[data-veta-risen] [data-open-in-panel]').click()
    await expect.poll(() => shownModes(app), { timeout: 15_000 }).toEqual(['panel'])
    await expect(window.locator(`.dm-msg[data-dwarf="${dwarfId}"]`)).toBeVisible({
      timeout: 15_000
    })
    const inPanel = await chatState(window, 'body')
    expect(inPanel?.draft).toBe(inVeta!.draft)
    expect(inPanel?.selection).toEqual(inVeta!.selection)
    expect
      .soft(inPanel?.firstInView, 'the same message is first in view in the Panel')
      .toBe(inVeta!.firstInView)
    await shot(window, '2-panel-after-open-in-panel')

    // Down to Veta with the chat open: it rises once Veta landed, the same three.
    const down = (await window.evaluate(
      `window.api.moveToMode(${JSON.stringify({ mode: 'veta', mineId, dwarfId })})`
    )) as { ok: boolean }
    expect(down.ok).toBe(true)
    await expect.poll(() => shownModes(app), { timeout: 15_000 }).toEqual(['veta'])
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('chat')
    const backInVeta = await chatState(veta, '[data-veta-risen]')
    expect(backInVeta?.draft).toBe(inVeta!.draft)
    expect(backInVeta?.selection).toEqual(inVeta!.selection)
    expect
      .soft(backInVeta?.firstInView, 'the same message is first in view in Veta')
      .toBe(inVeta!.firstInView)
    await shot(veta, '3-veta-after-panel')

    // And to the Panel again.
    await veta.locator('[data-veta-risen] [data-open-in-panel]').click()
    await expect.poll(() => shownModes(app), { timeout: 15_000 }).toEqual(['panel'])
    await expect(window.locator(`.dm-msg[data-dwarf="${dwarfId}"]`)).toBeVisible({
      timeout: 15_000
    })
    const again = await chatState(window, 'body')
    expect(again?.draft).toBe(inVeta!.draft)
    expect(again?.selection).toEqual(inVeta!.selection)
    expect
      .soft(again?.firstInView, 'the same message is first in view after the round trip')
      .toBe(inVeta!.firstInView)
    // A chat opened in the Panel has no hand-off tool (US-MSG-010.AC02).
    await expect(window.locator('[data-open-in-panel]')).toHaveCount(0)
    // No window was created or destroyed on the way: the two mode windows are the ones there were.
    expect(await windowIds(app)).toEqual(ids)

    // "▲" by Tab and Enter, then by Space: the Panel with no mine implied (US-VETA-011.AC01).
    for (const key of ['Enter', 'Space']) {
      await showVeta(app, window)
      await expect.poll(() => shownModes(app), { timeout: 15_000 }).toEqual(['veta'])
      const expand = veta.locator('[data-veta-expand]')
      await expect(expand).toBeVisible()
      let reached = false
      for (let i = 0; i < 40 && !reached; i += 1) {
        await veta.keyboard.press('Tab')
        reached = (await veta.evaluate(
          `document.activeElement?.hasAttribute('data-veta-expand') === true`
        )) as boolean
      }
      expect(reached, '▲ is reached by Tab').toBe(true)
      if (key === 'Enter') await shot(veta, '4-veta-expand-focused')
      await veta.keyboard.press(key)
      await expect.poll(() => shownModes(app), { timeout: 15_000 }).toEqual(['panel'])
    }
    await shot(window, '5-panel-after-expand')

    // An input-method composition in progress ends at the switch; its text travels in the draft (S9.02, S-025-1).
    await showVeta(app, window)
    await dwarf.click()
    await expect.poll(() => risenContent(veta), { timeout: 15_000 }).toBe('chat')
    await composer.fill('')
    await composer.pressSequentially('ime ')
    const cdp = await veta.context().newCDPSession(veta)
    await cdp.send('Input.imeSetComposition', { text: 'dig', selectionStart: 3, selectionEnd: 3 })
    const composing = (await veta.evaluate(
      `document.querySelector('[data-veta-risen] .dm-msg textarea').value`
    )) as string
    test.info().annotations.push({
      type: 'S-025-1',
      description: `${process.platform}: while composing, the field reads ${JSON.stringify(composing)}`
    })
    await veta.evaluate(
      `window.api.moveToMode(${JSON.stringify({ mode: 'panel', mineId, dwarfId })})`
    )
    await expect.poll(() => shownModes(app), { timeout: 15_000 }).toEqual(['panel'])
    await expect(window.locator(`.dm-msg[data-dwarf="${dwarfId}"]`)).toBeVisible()
    const committed = (await chatState(window, 'body'))?.draft ?? ''
    test.info().annotations.push({
      type: 'S-025-1',
      description: `${process.platform}: after the switch, the Panel's draft reads ${JSON.stringify(committed)}`
    })
    expect(committed).toBe('ime dig')
  })
})
