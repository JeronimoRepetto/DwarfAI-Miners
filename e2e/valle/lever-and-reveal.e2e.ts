import { mkdirSync, readFileSync } from 'node:fs'
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
  ASK_MARKER,
  asksOf,
  createClaudeStreamWorld,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { PRESENCE_DEBOUNCE_MS } from '../../src/ui-main/window/application/presenceTracker.ts'
import { muteAppAudio, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (ISSUE-311; US-SHELL-001.AC01; 07 S10.04, S29.23, S39.06, S10.10; ADR-034 item 2, ADR-025 item 8, ADR-018 item 6;
 * UC-040, UC-053, UC-064): Valle ships in every build profile now. In the Panel a person opens a stub Claude dwarf's
 * chat, types half a thought and presses "▲ Valle": the app moves into Valle, the chat lands in Valle's chat zone pinned
 * and focused with its draft, and Valle is the mode last used. A second dwarf, in a mine Valle's mosaic does not show,
 * then asks for a permission: the Host raises level 3 for it, and a click on that notification reveals the dwarf in
 * Valle (its column added, its chat pinned and focused) without leaving Valle or the Control room.
 *
 * The OS notification is never drawn on the machine running the case: Electron's `Notification` is replaced in the main
 * process before any ask, keeping each one so its click can be played there. Every page is muted first.
 * The page's own scripts are strings: the e2e project has no DOM types.
 */

test.describe.configure({ timeout: 360_000 })

/** A JSON file of UI main's stores, or null while it is missing or partly written. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** The modes whose window is on screen, read in the main process. */
function shownModes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.isVisible())
      .map((w) => {
        const url = w.webContents.getURL()
        return url.includes('mode=valle') ? 'valle' : url.includes('mode=veta') ? 'veta' : 'panel'
      })
      .sort()
  )
}

/**
 * Electron's `Notification` in the main process keeps each notification instead of drawing it: `isSupported` answers
 * yes (a Linux runner may have no notification daemon), and `show` keeps the instance, whose click a case can emit.
 */
async function keepNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const kept: Array<{ title: string; body: string; emit(event: string): void }> = []
    ;(globalThis as unknown as { dwarfaiE2eKept: typeof kept }).dwarfaiE2eKept = kept
    Notification.isSupported = () => true
    Notification.prototype.show = function (this: (typeof kept)[number]) {
      kept.push(this)
    }
  })
}

/** The bodies of the notifications kept so far. */
const keptBodies = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() =>
    (
      (globalThis as unknown as { dwarfaiE2eKept?: Array<{ body: string }> }).dwarfaiE2eKept ?? []
    ).map((n) => n.body)
  )

/** A person clicks the kept notification whose body names `mine`: its own `click`, played in the main process. */
async function clickNotification(app: ElectronApplication, mine: string): Promise<void> {
  const clicked = await app.evaluate((_electron, name) => {
    const kept =
      (
        globalThis as unknown as {
          dwarfaiE2eKept?: Array<{ body: string; emit(event: string): void }>
        }
      ).dwarfaiE2eKept ?? []
    const notification = kept.find((n) => n.body.includes(name))
    notification?.emit('click')
    return notification !== undefined
  }, mine)
  expect(clicked, `a notification names ${mine}`).toBe(true)
}

/**
 * Valle's on-screen reports (A-44) as the main process receives them, beside the app's own handler; then waits until the
 * last one holds `onScreen` and has been held past UI main's settle (`PRESENCE_DEBOUNCE_MS`, ADR-024 item 7), so the
 * Host knows it before any ask opens (07 S17.01).
 */
async function watchValleReports(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const reports: Array<{ at: number; mineIds: string[] }> = []
    ;(globalThis as unknown as { dwarfaiE2eValleReports: typeof reports }).dwarfaiE2eValleReports =
      reports
    ipcMain.on('presence:visibleMines', (event, request: unknown) => {
      if (!event.sender.getURL().includes('mode=valle')) return
      const mineIds = (request as { mineIds?: string[] } | null)?.mineIds ?? []
      reports.push({ at: Date.now(), mineIds: [...mineIds] })
    })
  })
}

async function valleReportSettled(app: ElectronApplication, onScreen: string): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(
          (_electron, [on, settle]) => {
            const reports = (
              globalThis as unknown as {
                dwarfaiE2eValleReports?: Array<{ at: number; mineIds: string[] }>
              }
            ).dwarfaiE2eValleReports
            const last = reports?.at(-1)
            if (last === undefined) return 'no report yet'
            if (!last.mineIds.includes(on)) return 'reported ' + JSON.stringify(last.mineIds)
            return Date.now() - last.at > settle ? 'settled' : 'settling'
          },
          [onScreen, PRESENCE_DEBOUNCE_MS] as const
        ),
      { timeout: 15_000, message: 'Valle reports its mine on screen, and UI main settles it' }
    )
    .toBe('settled')
}

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

test.describe('Valle on the mode lever and in the reveal (ISSUE-311)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-SHELL-001.AC01, S39.06] from the Panel with a chat open a person climbs to Valle, and a later notification click reveals another dwarf in Valle without leaving it', async () => {
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
    await muteAppAudio(app)
    await keepNotifications(app)

    // One mine at work: the person opens its dwarf's chat in the Panel and types half a thought.
    const alphaFolder = path.join(owned.root, 'alpha')
    mkdirSync(alphaFolder, { recursive: true })
    const alpha = await declareMine(app, window, alphaFolder)
    const first = await launchClaude(window, alpha)
    const nav = window.locator('nav.dm-nav')
    await nav.locator('.dm-slot[data-label="Map"]').click()
    await window.locator('.dm-marker').first().click({ timeout: 60_000 })
    await window.locator(`.dm-roster [data-dwarf="${first.dwarfId}"]`).click({ timeout: 30_000 })
    const panelChat = window.locator(`.dm-msg[data-dwarf="${first.dwarfId}"]`)
    await expect(panelChat).toBeVisible({ timeout: 15_000 })
    await panelChat.locator('.dm-composer textarea').fill('half a thought')

    // Valle's on-screen reports, from its first.
    await watchValleReports(app)
    // "▲ Valle": the app moves into Valle, the chat in focus pinned and focused there with its draft (S29.23).
    await nav.locator('[aria-label="Mode"] .dm-slot[data-label="▲ Valle"]').click()
    await expect
      .poll(() => shownModes(app), { timeout: 30_000, message: '▲ Valle moves the app into Valle' })
      .toEqual(['valle'])
    let valle: Page | undefined
    await expect
      .poll(
        () => {
          valle = app.windows().find((page) => page.url().includes('mode=valle'))
          return valle !== undefined
        },
        { timeout: 15_000, message: 'Playwright lists the Valle page' }
      )
      .toBe(true)
    await valle!.waitForSelector('[data-valle-root]')
    await valleSettled(valle!)
    await expect(valle!.locator('.dm-cstack__open')).toHaveAttribute('data-pin', first.dwarfId, {
      timeout: 15_000
    })
    await expect(
      valle!.locator(`[data-valle-chat="${first.dwarfId}"] .dm-composer textarea`)
    ).toHaveValue('half a thought')
    // Valle is the mode last used, written by the ModeCoordinator alone into UI main's own store file (14 §3.9).
    await expect
      .poll(() => JSON.stringify(readJson(path.join(owned.userDataDir, 'last-mode-v1.json'))), {
        timeout: 15_000
      })
      .toContain('"valle"')

    // A second mine, which Valle's mosaic does not show, and its dwarf.
    const betaFolder = path.join(owned.root, 'beta')
    mkdirSync(betaFolder, { recursive: true })
    const beta = await declareMine(app, window, betaFolder)
    const second = await launchClaude(window, beta)
    await expect(valle!.locator(`[data-valle-column="${beta}"]`)).toHaveCount(0)
    // Valle's report holds alpha, and UI main has settled it, before any ask opens (07 S17.01).
    await valleReportSettled(app, alpha)

    // "System notifications" on (A-43), then the second dwarf asks: its mine is not on screen, so level 3.
    await window.evaluate('window.api.setNotificationsEnabled(true)')
    await app.evaluate(() => {
      ;(globalThis as unknown as { dwarfaiE2eKept?: unknown[] }).dwarfaiE2eKept?.splice(0)
    })
    await startAsking(window, second.dwarfId)
    await expect
      .poll(() => keptBodies(app), {
        timeout: 60_000,
        message: 'the Host raises level 3 for the mine Valle does not show'
      })
      .toEqual(expect.arrayContaining([expect.stringContaining('beta')]))

    // The person clicks it: the dwarf is revealed in Valle, which stays Valle in the Control room (S39.06, S10.10).
    await clickNotification(app, 'beta')
    await expect(valle!.locator(`[data-valle-column="${beta}"]`)).toHaveCount(1, {
      timeout: 15_000
    })
    await expect(valle!.locator('.dm-cstack__open')).toHaveAttribute('data-pin', second.dwarfId, {
      timeout: 15_000
    })
    await expect(valle!.locator('[data-valle-root]')).toHaveAttribute('data-preset', 'control')
    expect(await shownModes(app)).toEqual(['valle'])
  })
})
