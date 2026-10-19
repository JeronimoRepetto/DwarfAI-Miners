import { expect, test, type Page } from '@playwright/test'
import { CATALOG_PROVIDER_IDS } from '../../src/contracts/catalog/ids.ts'
import {
  createIsolatedProfile,
  disposeProfile,
  isProcessAlive,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import {
  asksOf,
  chatOf,
  dwarfsOf,
  launchesOf,
  seedMine,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { integrationState } from '../cut-4a/openCodeWorld.ts'
import {
  createOpenCodeWorld,
  OPENCODE_REPLIES,
  openCodeOnlyPath,
  type OpenCodeWorld
} from './openCodeAcpWorld.ts'

/**
 * L9, step 4b (ISSUE-238 test 6; 21 §2 cut 4b "Parity / exit"; ADR-011 items 3, 7; ADR-014 stop): the step-4b router
 * sends an OpenCode dwarf's launch (A-35), send (A-23) and stop (A-N29) to the Host, whose generic `AcpDriver` drives
 * the stub `opencode acp` (`opencodeAcpStub.mjs`; S-031-3 failed, so OpenCode launches through `acp`). The Host reads
 * its own `opencode-permissions` state for the stub's permission request: while the integration is off the request is
 * denied by the Host with one line in the chat and no card; once the person turned it on (A-53, written and read back,
 * `on-verified`) it is a card the person answers. "Let Jev choose" chooses among the Host's launchable providers, which
 * list OpenCode again (the narrowing of 3a…4a ends).
 *
 * Synthetic: the stub stands in for OpenCode 1.18.32 (no real CLI on the E2E runners); the real-CLI check stays pending
 * in `docs/strangler/parity-cut-4b.md`. The person's actions are the renderer's own `window.api` members with the `14`
 * shapes. Before the 4b switch A-35 reached today's runtime for OpenCode through `PerProviderShapeAdapter` (today's
 * one-shot `opencode run`, never the Host's), as the 4a router cases pin.
 */

/** The OpenCode catalog id, from the one list (R12: never a hand-typed literal outside it). */
const OPENCODE = CATALOG_PROVIDER_IDS[3]

/** Launches an OpenCode dwarf into `mineId` through A-35 and waits until the Host settles it with its Owned dwarf. */
async function launchOpenCode(window: Page, mineId: string): Promise<string> {
  const before = new Set((await dwarfsOf(window)).map((d) => d.id))
  const accepted = (await window.evaluate(
    `window.api.launchAgent(${JSON.stringify({
      mineId,
      way: { kind: 'supplier', providerId: OPENCODE },
      prompt: 'Write the notes.',
      jevOn: false,
      jevAutoAccept: false,
      requestId: uuidv7()
    })})`
  )) as { ok: boolean; value?: { launchId: string } }
  expect(accepted, 'A-35 accepts the OpenCode launch: ' + JSON.stringify(accepted)).toMatchObject({
    ok: true
  })
  const launchId = accepted.value!.launchId
  let dwarfId: string | undefined
  await expect
    .poll(
      async () => {
        const launch = (await launchesOf(window)).find((row) => row.launchId === launchId)
        if (launch !== undefined) {
          return launch.state === 'failed' ? `failed ${JSON.stringify(launch)}` : launch.state
        }
        dwarfId = (await dwarfsOf(window)).find(
          (d) => d.mineId === mineId && d.providerId === OPENCODE && !before.has(d.id)
        )?.id
        return dwarfId === undefined ? 'left the launches with no dwarf' : 'succeeded'
      },
      { timeout: 60_000, message: 'the Host settles the launch' }
    )
    .toBe('succeeded')
  expect((await dwarfsOf(window)).find((d) => d.id === dwarfId)).toMatchObject({
    providerId: OPENCODE,
    owned: true
  })
  return dwarfId!
}

/** The one `opencode acp` run the Host started after `known`. */
async function newRun(world: OpenCodeWorld, known: ReadonlySet<number>) {
  let pid: number | undefined
  await expect
    .poll(
      () => {
        pid = world.runs().find((run) => !known.has(run.pid) && run.argv.includes('acp'))?.pid
        return pid !== undefined
      },
      { timeout: 30_000, message: 'the Host started opencode acp' }
    )
    .toBe(true)
  return world.runs().find((run) => run.pid === pid)!
}

/** Stops `dwarfId` (A-N29) and waits until its `opencode acp` run ended. */
async function stop(window: Page, dwarfId: string, pid: number): Promise<void> {
  const stopped = await window.evaluate(
    `window.api.stopDwarf(${JSON.stringify({ dwarfId, requestId: uuidv7() })})`
  )
  expect(stopped, 'A-N29 ends the session').toMatchObject({ ok: true, value: { ok: true } })
  await expect
    .poll(() => isProcessAlive(pid), { timeout: 30_000, message: 'the stub opencode ended' })
    .toBe(false)
}

test.describe.configure({ timeout: 300_000 })

test.describe('step 4b: an OpenCode dwarf through the Host (ISSUE-238)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[ADR-011] a Host-launched OpenCode session shows a card while the integration is on-verified and one chat line when it is off', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createOpenCodeWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: openCodeOnlyPath(world),
      pathOnly: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched
    await waitForHostAttached(owned)
    // OpenCode is installed, so the first-run step is due (OQ-68): answered with nothing ticked, the integration stays
    // off and no plugin file is written.
    expect(await answerFirstRunStep(window), 'the step offers OpenCode').toBe(true)
    expect(await integrationState(window, 'opencode-permissions')).toBe('off')
    const { mineId } = await seedMine(window, owned)

    // Off: the Host denies the stub's permission request itself, with one line in the chat and no card.
    const offDwarf = await launchOpenCode(window, mineId)
    const offRun = await newRun(world, new Set())
    expect(offRun.argv).toEqual(['acp'])
    expect(offRun.tokenInEnv, 'no token or OPENCODE_CONFIG_CONTENT in the agent environment').toBe(
      false
    )
    await expect
      .poll(() => world.answerOf(offRun.pid), { timeout: 60_000, message: 'the Host answered' })
      .toBe('reject')
    await expect
      .poll(async () => (await chatOf(window, offDwarf)).map((m) => m.text.trim()), {
        timeout: 60_000,
        message: 'the stub ended its turn after the denial'
      })
      .toContain(OPENCODE_REPLIES.denied)
    expect(
      (await chatOf(window, offDwarf)).filter((m) => m.role === 'system-line'),
      'one chat line says the request was declined'
    ).toHaveLength(1)
    expect((await asksOf(window)).filter((ask) => ask.dwarfId === offDwarf)).toEqual([])

    // Send (A-23): the text is a second ACP turn, answered in the chat.
    const sent = (await window.evaluate(
      `window.api.sendDwarfText(${JSON.stringify({
        dwarfId: offDwarf,
        text: 'Carry on.',
        attachments: [],
        requestId: uuidv7()
      })})`
    )) as { ok: boolean; value?: { ok: boolean } }
    expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true, value: { ok: true } })
    await expect
      .poll(async () => (await chatOf(window, offDwarf)).map((m) => m.text.trim()), {
        timeout: 60_000,
        message: 'the stub answered the sent message'
      })
      .toContain(OPENCODE_REPLIES.next)
    await stop(window, offDwarf, offRun.pid)

    // On: the person turns the permission requests on (A-53); the Host writes its plugin file and reads it back.
    const turnedOn = (await window.evaluate(
      `window.api.setOpenCodePluginEnabled(${JSON.stringify({
        on: true,
        origin: 'settings',
        requestId: uuidv7()
      })})`
    )) as { ok: boolean; value?: { ok: boolean } }
    expect(turnedOn, 'A-53 turns the integration on').toMatchObject({
      ok: true,
      value: { ok: true }
    })
    await expect
      .poll(() => integrationState(window, 'opencode-permissions'), { timeout: 30_000 })
      .toBe('on-verified')

    // On-verified: the same request is a card of the launched dwarf, answered Allow in the app (A-41).
    const onDwarf = await launchOpenCode(window, mineId)
    const onRun = await newRun(world, new Set([offRun.pid]))
    let askId: string | undefined
    await expect
      .poll(
        async () => {
          const ask = (await asksOf(window)).find(
            (row) => row.dwarfId === onDwarf && row.state === 'open'
          )
          askId = ask?.id
          return ask === undefined ? null : { kind: ask.kind, channel: ask.channel }
        },
        { timeout: 60_000, message: 'the stub’s permission request opens a card' }
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
    await expect.poll(() => world.answerOf(onRun.pid), { timeout: 60_000 }).toBe('allow')
    await expect
      .poll(async () => (await chatOf(window, onDwarf)).map((m) => m.text.trim()), {
        timeout: 60_000,
        message: 'the session used the tool the person allowed and ended its turn'
      })
      .toContain(OPENCODE_REPLIES.allowed)
    await stop(window, onDwarf, onRun.pid)
  })

  test('[US-LAUNCH-003.AC11] with Let Jev choose OpenCode is among the candidates again', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createOpenCodeWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: openCodeOnlyPath(world),
      pathOnly: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched
    await waitForHostAttached(owned)
    await answerFirstRunStep(window)
    // Jev's candidates are the Host's launchable providers (`suppliers.launchable`, 05 §3.9 `RoutingCatalogSource`;
    // 21 §2 "Let Jev choose (each step)" row 4b). A-36 answers exactly that list from 4b, where 3a…4a merged
    // OpenCode's entry in from today's catalog (`CatalogMergeAdapter`) while the Host could not launch it.
    await expect
      .poll(
        async () => {
          const listed = (await window.evaluate(
            'window.api.listAgentProviders({ refresh: true })'
          )) as {
            ok: boolean
            value?: Array<{ providerId: string; installed: boolean; publicLaunch: string }>
          }
          const entry = listed.value?.find((candidate) => candidate.providerId === OPENCODE)
          return entry === undefined
            ? null
            : { installed: entry.installed, launch: entry.publicLaunch }
        },
        { timeout: 60_000, message: 'the Host lists the stub opencode as launchable' }
      )
      .toEqual({ installed: true, launch: 'enabled' })
    // A "Let Jev choose" launch reaches the Host (no legacy launch row remains, 21 §2 cut 4b), which owns the choice.
    const { mineId } = await seedMine(window, owned)
    const accepted = (await window.evaluate(
      `window.api.launchAgent(${JSON.stringify({
        mineId,
        way: { kind: 'jev' },
        prompt: 'Write the notes.',
        jevOn: true,
        jevAutoAccept: false,
        requestId: uuidv7()
      })})`
    )) as { ok: boolean; value?: { launchId: string } }
    expect(accepted, 'A-35 hands the Jev launch to the Host').toMatchObject({ ok: true })
  })
})
