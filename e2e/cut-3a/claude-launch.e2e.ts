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
  ASK_MARKER,
  asksOf,
  chatOf,
  CLAUDE,
  createClaudeStreamWorld,
  dwarfsOf,
  launchClaude,
  launchedRun,
  launchesOf,
  REPLIES,
  seedMine,
  stubOnlyPath,
  uuidv7
} from './claudeStreamWorld.ts'

/**
 * L9, step 3a (ISSUE-001 test 4; 21 §2 cut 3a exit "L9 E2E with the Claude stub CLI"; 15 §9.2 launch → turn → ask →
 * answer → turn end; ADR-014 stop): with the step-3a router, a Claude dwarf's launch (A-35), send (A-23), permission
 * answer (A-41) and stop (A-N29) all go to the Host, and the Host's `ClaudeStreamJsonDriver` drives the interactive
 * Claude stub (`claudeStreamStub.mjs`): the launch is the Host's (`launches` section, `wayKind: 'supplier'`), the dwarf
 * is Owned, the ask arrives on the driver channel through the permission prompt tool the stub calls on the relay
 * (SP-08, AMENDMENT-21), and Stop dwarf ends the stub's process with the dwarf departing `stopped`.
 *
 * The person's actions are the renderer's own `window.api` members with the `14` shapes (the calls the 3a composables
 * make, ISSUE-179); the UI that makes them has its own L7 tests. Runs after the 3a switch (writer 1 of ISSUE-001 WU-D):
 * before it, A-35/A-23 route `legacy` with today's shape and this case fails at the launch.
 */

test.describe.configure({ timeout: 300_000 })

test.describe('step 3a: a Claude dwarf through the Host (ISSUE-001)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[ADR-001] with the Claude stub CLI a person launches, sends, answers a permission and stops a Claude dwarf, all through the Host', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createClaudeStreamWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: stubOnlyPath(world),
      pathOnly: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched
    await waitForHostAttached(owned)
    const { mineId } = await seedMine(window, owned)

    // Launch (A-35): the Host's launch, an Owned Claude dwarf, the stub's first turn in its chat.
    const { launchId, dwarfId } = await launchClaude(window, mineId)
    // A succeeded launch leaves the snapshot's `launches` section (14 §3.7: in-flight and failed only).
    expect((await launchesOf(window)).find((row) => row.launchId === launchId)).toBeUndefined()
    expect((await dwarfsOf(window)).find((d) => d.id === dwarfId)).toMatchObject({
      providerId: CLAUDE,
      owned: true,
      presence: 'present'
    })
    expect(await chatOf(window, dwarfId)).toContainEqual({ role: 'dwarf', text: REPLIES.first })
    const run = launchedRun(world)
    expect(run.kind).toBe('launch')
    expect(isProcessAlive(run.pid), 'the Host launched the stub session').toBe(true)

    // Send (A-23): the text reaches the session; the stub asks for its Write tool.
    const sent = (await window.evaluate(
      `window.api.sendDwarfText(${JSON.stringify({
        dwarfId,
        text: `Please write the ${ASK_MARKER}.`,
        attachments: [],
        requestId: uuidv7()
      })})`
    )) as { ok: boolean; value?: { ok: boolean } }
    expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true, value: { ok: true } })

    // Ask (driver channel, through the permission prompt tool), answered Allow in the app (A-41).
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
        { timeout: 60_000, message: 'the stub’s permission request opens an ask' }
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
        message: 'the session used the tool the person allowed and ended its turn'
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
      .poll(() => isProcessAlive(run.pid), { timeout: 30_000, message: 'the stub session ended' })
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
