import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { CATALOG_PROVIDER_IDS } from '../../src/contracts/catalog/ids.mjs'

/**
 * The demo's reads and actions on the running app, all through what the app already exposes, as the E2E cases do:
 * the renderer's own `window.api` members (the `14` seam A shapes) and Electron's main process through Playwright's
 * `evaluate`. No test hook exists in production code (R14), and none is added. Playwright's `expect` is not used: the
 * demo runs outside the test runner, so it polls with {@link poll}.
 */

/** The catalog ids of the two stub providers, from the one list (R12: never a hand-typed literal). */
export const PROVIDER_IDS = Object.freeze({
  claude: CATALOG_PROVIDER_IDS[0],
  codex: CATALOG_PROVIDER_IDS[1]
})

/** Polls `read` every 250 ms until `done(value)`; throws `what` with the last value after `timeoutMs`. */
export async function poll(read, done, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await read()
    if (done(last)) return last
    if (Date.now() > deadline)
      throw new Error(`${what}: still ${JSON.stringify(last)} after ${timeoutMs} ms`)
    await sleep(250)
  }
}

/** A UUIDv7 (14 §1.6): the requestId of one intent. */
export function uuidv7() {
  const hex = Date.now().toString(16).padStart(12, '0')
  const rest = randomUUID().replaceAll('-', '')
  const variant = ((Number.parseInt(rest[16] ?? '8', 16) & 0x3) | 0x8).toString(16)
  const v = `${hex}7${rest.slice(13, 16)}${variant}${rest.slice(17, 32)}`
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`
}

/** One section of the Host's snapshot (A-N01), flattened. */
export async function section(window, name) {
  const answer = await window.evaluate(
    `window.api.getHostSnapshot({ sections: [${JSON.stringify(name)}] })`
  )
  if (!answer?.ok || answer.value === undefined) return []
  return answer.value.chunks
    .filter((chunk) => chunk.section === name)
    .flatMap((chunk) => chunk.data)
}

export const minesOf = (window) => section(window, 'mines')
export const dwarfsOf = (window) => section(window, 'dwarfs')
export const launchesOf = (window) => section(window, 'launches')
export const asksOf = async (window) =>
  (await section(window, 'asks')).flatMap((data) => data.asks ?? [])

/**
 * Declares `folder` as a mine the way the Mines page does (`declareMine`), the OS folder picker answered in the main
 * process for this one call and then given back, so a picker the person opens later is the real one.
 */
export async function declareMineFolder(app, window, folder) {
  await app.evaluate(({ dialog }, picked) => {
    const held = dialog
    held.dwarfaiDemoPicker ??= held.showOpenDialog
    held.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] })
  }, folder)
  try {
    const declared = await window.evaluate('window.api.declareMine()')
    if (declared?.outcome !== 'added' || declared.mineId === undefined) {
      throw new Error(`declareMine did not add ${folder}: ${JSON.stringify(declared)}`)
    }
    return declared.mineId
  } finally {
    await app.evaluate(({ dialog }) => {
      const held = dialog
      if (held.dwarfaiDemoPicker !== undefined) held.showOpenDialog = held.dwarfaiDemoPicker
    })
  }
}

/** Waits until the Host measured the mine (`active`) and answers its row. */
export function measuredMine(window, mineId, timeoutMs = 180_000) {
  return poll(
    async () => (await minesOf(window)).find((mine) => mine.id === mineId),
    (mine) => mine?.state === 'active',
    `the mine ${mineId} is measured`,
    timeoutMs
  )
}

/**
 * Launches a dwarf of `provider` into `mineId` through A-35 (`launchAgent`) and answers its id once the Host settled
 * the launch with a new dwarf of that provider in the mine. A failed launch throws with its ADR-020 cause.
 */
export async function launchDwarf(window, mineId, provider, prompt) {
  const providerId = PROVIDER_IDS[provider]
  const before = new Set((await dwarfsOf(window)).map((d) => d.id))
  const accepted = await window.evaluate(
    `window.api.launchAgent(${JSON.stringify(launchParamsOf(mineId, provider, prompt, uuidv7()))})`
  )
  if (!accepted?.ok)
    throw new Error(`the ${provider} launch was refused: ${JSON.stringify(accepted)}`)
  const { launchId } = accepted.value
  let dwarfId
  await poll(
    async () => {
      const launch = (await launchesOf(window)).find((row) => row.launchId === launchId)
      if (launch !== undefined)
        return launch.state === 'failed' ? `failed ${JSON.stringify(launch)}` : launch.state
      dwarfId = (await dwarfsOf(window)).find(
        (d) => d.mineId === mineId && d.providerId === providerId && !before.has(d.id)
      )?.id
      return dwarfId === undefined ? 'waiting' : 'succeeded'
    },
    (state) => state === 'succeeded' || String(state).startsWith('failed'),
    `the ${provider} launch settles`,
    90_000
  ).then((state) => {
    if (state !== 'succeeded') throw new Error(`the ${provider} launch ${state}`)
  })
  return dwarfId
}

/** Sends `text` to a dwarf (A-23 `sendDwarfText`). */
export async function sendText(window, dwarfId, text) {
  const sent = await window.evaluate(
    `window.api.sendDwarfText(${JSON.stringify({ dwarfId, text, attachments: [], requestId: uuidv7() })})`
  )
  return sent?.ok === true && sent.value?.ok !== false
}

/** Gives a dwarf a person-set name (A-N08 `renameDwarf`), as the dwarf menu's Rename does. */
export async function renameDwarf(window, dwarfId, name) {
  const renamed = await window.evaluate(
    `window.api.renameDwarf(${JSON.stringify({ dwarfId, name, requestId: uuidv7() })})`
  )
  return renamed?.ok === true
}

/** Writes one UI preference (A-N21), as the app's own controls do. */
export function setPreference(window, key, value) {
  return window.evaluate(`window.api.setUiPreference(${JSON.stringify({ key, value })})`)
}

/**
 * Electron's `Notification` in the main process records instead of drawing, as the E2E needs-you case does: no toast,
 * no chime on the machine running the demo. What would have shown is kept for the log.
 */
export async function recordNotifications(app) {
  await app.evaluate(({ Notification }) => {
    const shown = []
    globalThis.dwarfaiDemoShown = shown
    Notification.isSupported = () => true
    Notification.prototype.show = function () {
      shown.push({ title: this.title, body: this.body })
    }
  })
}

/**
 * Answers the first-run consent step if the Host says it is due (US-SET-012; `e2e/_harness/firstRunStep.ts`): every
 * option off, then Activate, so the demo writes nothing into any tool's config.
 */
export async function answerFirstRunStep(window) {
  const preferences = await section(window, 'preferences')
  if (!preferences.some((data) => data?.welcome?.due === true)) return false
  const step = window.locator('.dm-scrim').filter({ has: window.locator('.welcome-step__options') })
  await step.waitFor({ state: 'visible', timeout: 30_000 })
  const toggles = step.getByRole('switch')
  for (let at = 0; at < (await toggles.count()); at++) {
    const toggle = toggles.nth(at)
    if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click()
  }
  await step.getByRole('button', { name: 'Activate' }).click()
  await step.waitFor({ state: 'hidden', timeout: 30_000 })
  return true
}

/** Moves to `mode` from `from` (A-N13 `moveToMode`) and answers the mode window's page once its root is drawn. */
export async function showMode(app, from, mode) {
  const moved = await from.evaluate(`window.api.moveToMode({ mode: ${JSON.stringify(mode)} })`)
  if (!moved?.ok) throw new Error(`the build does not list ${mode}: ${JSON.stringify(moved)}`)
  if (mode === 'panel') return null
  const page = await poll(
    async () => app.windows().find((p) => p.url().includes(`mode=${mode}`)),
    (found) => found !== undefined,
    `the ${mode} window opens`,
    15_000
  )
  await page.waitForSelector(mode === 'valle' ? '[data-valle-root]' : '[data-veta-root]')
  return page
}

/**
 * The A-35 `launchAgent` request of a foreman: its provider's supplier way, never "Let Jev choose" (`jevOn: false`).
 * So no launch asks Jev, nothing reaches TypeSafe, and the delegation gate (`delegation/domain/delegationGate.ts`:
 * a launch made with Let Jev choose) never opens.
 */
export function launchParamsOf(mineId, provider, prompt, requestId) {
  return {
    mineId,
    way: { kind: 'supplier', providerId: PROVIDER_IDS[provider] },
    prompt,
    jevOn: false,
    jevAutoAccept: false,
    requestId
  }
}

/**
 * Opens a mine's column in the Panel, as a person does from its card on the Mines page (the docked Panel can be too
 * narrow for every Map marker). The press goes to the card's own button.
 */
export async function openMineColumn(window, mineId) {
  await window.locator('.dm-nav .dm-slot[data-label="Mines"]').click({ timeout: 15_000 })
  const card = window.locator(`.dm-card[data-mine="${mineId}"] .dm-card__hit`)
  await card.waitFor({ state: 'attached', timeout: 15_000 })
  await card.dispatchEvent('click')
  await window.locator('.shell-mine').waitFor({ timeout: 30_000 })
}
