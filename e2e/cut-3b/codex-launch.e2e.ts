import { expect, test } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  isProcessAlive,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'
import {
  asksOf,
  chatOf,
  dwarfsOf,
  launchesOf,
  seedMine,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import {
  ASK_MARKER,
  CODEX,
  codexOnlyPath,
  createCodexAppServerWorld,
  launchCodex,
  launchedRun,
  REPLIES
} from './codexAppServerWorld.ts'

/**
 * L9, step 3b (ISSUE-002 test 4; 21 §2 cut 3b exit; 15 §9.2 launch → turn → ask → answer → turn end; ADR-014 stop;
 * ADR-013, C-23): with the step-3b router, a Codex dwarf's launch (A-35), send (A-23), permission answer (A-41) and
 * stop (A-N29) all go to the Host, and the Host's `CodexAppServerDriver` drives the interactive Codex stub
 * (`codexAppServerStub.mjs`): the launch is the Host's, the dwarf is Owned, the ask arrives on the driver channel as the
 * app-server's command approval request (C-06), and Stop dwarf ends the stub's process with the dwarf departing
 * `stopped`. The stub writes down the argv and the environment it was started with: no delegation token in either.
 *
 * The person's actions are the renderer's own `window.api` members with the `14` shapes. Before the 3b switch A-35 and
 * A-23 reach today's runtime for Codex through `PerProviderShapeAdapter`, so this case fails at the launch (today's
 * `codex exec` is never the stub's `app-server`).
 */

test.describe.configure({ timeout: 300_000 })

test.describe('step 3b: a Codex dwarf through the Host (ISSUE-002)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test("[ADR-001] with the Codex stub CLI a person launches, sends, answers a permission and stops a Codex dwarf through the Host, and the stub's argv and env hold no delegation token", async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createCodexAppServerWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: codexOnlyPath(world),
      pathOnly: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched
    await waitForHostAttached(owned)
    const { mineId } = await seedMine(window, owned)

    // Launch (A-35): the Host's launch, an Owned Codex dwarf, the stub's first turn in its chat.
    const { launchId, dwarfId } = await launchCodex(window, mineId)
    expect((await launchesOf(window)).find((row) => row.launchId === launchId)).toBeUndefined()
    expect((await dwarfsOf(window)).find((d) => d.id === dwarfId)).toMatchObject({
      providerId: CODEX,
      owned: true,
      presence: 'present'
    })
    expect(await chatOf(window, dwarfId)).toContainEqual({ role: 'dwarf', text: REPLIES.first })
    const run = launchedRun(world)
    expect(run.argv[0]).toBe('app-server')
    expect(isProcessAlive(run.pid), 'the Host launched the stub server').toBe(true)
    // C-23 (INV-59, ADR-013): no delegation token in the provider process's argv or inherited env.
    expect({ inEnv: run.tokenInEnv, inArgv: run.tokenInArgv }).toEqual({
      inEnv: false,
      inArgv: false
    })
    expect(run.argv.join(' ')).not.toMatch(/token/i)

    // Send (A-23): the text reaches the thread; the stub asks to run its command.
    const sent = (await window.evaluate(
      `window.api.sendDwarfText(${JSON.stringify({
        dwarfId,
        text: `Please write the ${ASK_MARKER}.`,
        attachments: [],
        requestId: uuidv7()
      })})`
    )) as { ok: boolean; value?: { ok: boolean } }
    expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true, value: { ok: true } })

    // Ask (driver channel, the app-server's command approval), answered Allow in the app (A-41).
    let askId: string | undefined
    await expect
      .poll(
        async () => {
          const ask = (await asksOf(window)).find(
            (row) => row.dwarfId === dwarfId && row.state === 'open'
          )
          askId = ask?.id
          return ask === undefined ? null : { kind: ask.kind, channel: ask.channel }
        },
        { timeout: 60_000, message: 'the stub’s approval request opens an ask' }
      )
      .toEqual({ kind: 'permission', channel: 'driver' })
    const answered = await window.evaluate(
      `window.api.answerDwarfPermission(${JSON.stringify({
        askId,
        decision: 'allow',
        requestId: uuidv7()
      })})`
    )
    expect(answered, 'A-41 delivers the Allow').toMatchObject({ ok: true })
    await expect
      .poll(async () => (await chatOf(window, dwarfId)).map((m) => m.text), {
        timeout: 60_000,
        message: 'the thread ran the command the person allowed and ended its turn'
      })
      .toContain(REPLIES.allowed)
    await expect
      .poll(async () => (await dwarfsOf(window)).find((d) => d.id === dwarfId)?.status, {
        timeout: 30_000
      })
      .toBe('idle')

    // Stop dwarf (A-N29): the whole session ends and the dwarf walks out.
    const stopped = await window.evaluate(
      `window.api.stopDwarf(${JSON.stringify({ dwarfId, requestId: uuidv7() })})`
    )
    expect(stopped, 'A-N29 ends the session').toMatchObject({ ok: true, value: { ok: true } })
    await expect
      .poll(() => isProcessAlive(run.pid), { timeout: 30_000, message: 'the stub server ended' })
      .toBe(false)
    await expect
      .poll(
        async () => {
          const dwarf = (await dwarfsOf(window)).find((d) => d.id === dwarfId)
          return dwarf === undefined || dwarf.presence === 'walking-out'
        },
        { timeout: 30_000, message: 'the dwarf walks out' }
      )
      .toBe(true)

    // Read only after the Host exited (the single writer, ADR-002 D1): the dwarf departed stopped.
    await launched.teardown({ stopEverything: true })
    launched = undefined
    const db = openHostDatabaseReadOnly(owned)
    try {
      const row = db
        .prepare('SELECT departure_cause AS cause FROM dwarfs WHERE id = ?')
        .get(dwarfId) as { cause: string | null } | undefined
      expect(row?.cause, 'the stopped dwarf departed stopped').toBe('stopped')
    } finally {
      db.close()
    }
  })
})
