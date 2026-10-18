import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  isProcessAlive,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { dwarfsOf, launchesOf, seedMine, uuidv7 } from '../cut-3a/claudeStreamWorld.ts'

/**
 * L9, step 3d (ISSUE-186 test 3; 21 §2 cut 3d exit: the "Other…" session no longer dies with the window): with the
 * step-3d router, an "Other…" launch (A-39 `launchHostedProcess`, the `14` `LaunchCustomParams`) goes to the Host,
 * whose `HostedCommandDriver` starts the person's own command (`otherCommandStub.mjs`, run by node, no shell). The dwarf
 * is the Host's, Owned. The app then quits — the window closes and the Host stays — and the command keeps running; the
 * app opens again on the same profile and the dwarf is still there, the same process behind it.
 *
 * Before the 3d switch A-39 reaches today's runtime with today's shape, so this case fails at the launch (today's
 * `{ launched }` answer, never a LaunchId), and today's hosted process ends with the window.
 */

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'otherCommandStub.mjs')
/** The "Other…" driver's provider id (`15` §3 H1), outside the catalog. */
const OTHER = 'other'

test.describe.configure({ timeout: 300_000 })

/** The pid the stub wrote down, once it did. */
async function stubPid(pidFile: string): Promise<number> {
  await expect
    .poll(() => existsSync(pidFile), { timeout: 30_000, message: 'the command wrote its pid' })
    .toBe(true)
  return Number(readFileSync(pidFile, 'utf8'))
}

/** Launches `command` through A-39 and waits until the Host settles it with a new "Other…" dwarf of `mineId`. */
async function launchOther(window: Page, mineId: string, command: string): Promise<string> {
  const before = new Set((await dwarfsOf(window)).map((d) => d.id))
  const accepted = (await window.evaluate(
    `window.api.launchHostedProcess(${JSON.stringify({
      mineId,
      command,
      prompt: 'Survey the north seam.',
      requestId: uuidv7()
    })})`
  )) as { ok: boolean; value?: { launchId: string } }
  expect(accepted, 'A-39 accepts the Other… launch: ' + JSON.stringify(accepted)).toMatchObject({
    ok: true
  })
  const launchId = accepted.value!.launchId
  let dwarfId: string | undefined
  // The snapshot's `launches` lists only in-flight and failed launches (14 §3.7): a succeeded one left it while its
  // dwarf arrived.
  await expect
    .poll(
      async () => {
        const launch = (await launchesOf(window)).find((row) => row.launchId === launchId)
        if (launch !== undefined) {
          return launch.state === 'failed' ? `failed ${JSON.stringify(launch)}` : launch.state
        }
        dwarfId = (await dwarfsOf(window)).find(
          (d) => d.mineId === mineId && d.providerId === OTHER && !before.has(d.id)
        )?.id
        return dwarfId === undefined ? 'left the launches with no dwarf' : 'succeeded'
      },
      { timeout: 60_000, message: 'the Host settles the Other… launch' }
    )
    .toBe('succeeded')
  return dwarfId!
}

test.describe('step 3d: an Other… dwarf through the Host (ISSUE-186)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[ADR-001] an Other session launched through the Host survives closing the window', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({ profile: owned, tracePath: test.info().outputPath('trace.zip') })
    await waitForHostAttached(owned)
    const { mineId } = await seedMine(launched.window, owned)

    // Launch (A-39): node runs the stub, quoted as a person types a path with spaces; no shell anywhere.
    const pidFile = path.join(owned.root, 'other-command.pid')
    const command = `"${process.execPath}" "${STUB}" "${pidFile}"`
    const dwarfId = await launchOther(launched.window, mineId, command)
    expect((await dwarfsOf(launched.window)).find((d) => d.id === dwarfId)).toMatchObject({
      providerId: OTHER,
      owned: true,
      presence: 'present'
    })
    const pid = await stubPid(pidFile)
    expect(isProcessAlive(pid), 'the Host started the command').toBe(true)

    // The window closes: the app quits and the detached Host stays (the case owns the profile, so the teardown leaves
    // the Host running). The command keeps running with no window.
    await launched.teardown()
    launched = undefined
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect(isProcessAlive(pid), 'the command outlived the window').toBe(true)

    // The window reopens on the same profile: the same dwarf is on the board, present and Owned, the same process.
    launched = await launchApp({
      profile: owned,
      tracePath: test.info().outputPath('trace-reopened.zip')
    })
    await waitForHostAttached(owned)
    await expect
      .poll(async () => (await dwarfsOf(launched!.window)).find((d) => d.id === dwarfId), {
        timeout: 60_000,
        message: 'the reopened window shows the Other… dwarf'
      })
      .toMatchObject({ providerId: OTHER, owned: true, presence: 'present' })
    expect(isProcessAlive(pid), 'still the process the Host started').toBe(true)
  })
})
