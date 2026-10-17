// layer: L2
// L2 flow (17 §1.2; 16 §8.2, §8.3; 05 §4; 15 §9.2; ADR-015 item 3; ISSUE-182): the launching
// module and the conversation write side wired into the Host, composed as host/main.ts composes them
// (flows/testing/cut3aHost.ts): the real boot steps, every seam-B member served before the bind, the
// endpoint's frame list, the launched sessions' driver event routes, crew's session links over
// launching's ownership, the `LaunchAdvisor` bridge to the wired jev module, Stop everything and quit,
// and the Host recovery that boot step 5 awaits. The `ui` client is a FrameClient behind an
// in-process duplex, authenticated by the real `hello` (14 §1.3), every frame checked against its
// 14 §3.5 schema.
//
// Launches run on the development build's SimulatedDriver (15 §4.12) and, for the Host rebuilt after
// a crash, on the person's own Codex app-server driver over the recorded C-16 session of
// `fixtures/codex/app-server-rpc/0.153.4-synthetic/c-16-resume` (two processes: a launch, then the
// resume of the same thread), replayed by the conformance harness's `RecordingSpawn`.
//
// TC-182-01 (recovery at step 5), TC-182-02 (the 3a members and frames), TC-182-03 (launch, send,
// stop, stop-all and crash recovery end to end).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, LaunchId, MineId } from '../../kernel/domain/values'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { RESUME_SPACING_MS } from '../../modules/launching'
import { readFixtureSet, type FixtureProcess } from '../../modules/suppliers/testing/fixtureSet'
import { FixtureTransport } from '../../modules/suppliers/testing/fixtureTransport'
import { RecordingSpawn } from '../../modules/suppliers/testing/recordingSpawn'
import { bootHost, cleanUp, evts, INSTALL_ID, JEV_KEY, world, type Host } from './testing/cut3aHost'

const CODEX_FIXTURES = new URL('../../../../fixtures/codex/app-server-rpc/', import.meta.url)

/** Jev's first-request answers (16 §6.3), picking `provider` (flows/jevSuggest.test.ts). */
function jevAnswers(provider: string) {
  return {
    kind: 'answers' as const,
    provider: { choice: provider, confidence: 0.91 },
    tier: { choice: 'balanced' as const, confidence: 0.88 },
    trivial: { probability: 0.05 },
    largeContext: { probability: 0.05 },
    effort: { score: 1.5 },
    usage: { inputTokens: 42 }
  }
}

afterEach(cleanUp)

/** The seam-B members born in step 3a (21 §2 row 3a; 14 §2.3). */
const MEMBERS_3A = [
  'crew.stop', // B-M21
  'crew.rename', // B-M22
  'crew.resetName', // B-M23
  'conversation.send', // B-M24
  'conversation.retry', // B-M25
  'conversation.describeAttachments', // B-M28
  'conversation.resolveConsole', // B-M29
  'launching.launch', // B-M33
  'launching.launchCustom', // B-M34
  'launching.retryRecovery', // B-M35
  'launching.dismissRecovery', // B-M36
  'suppliers.launchable' // B-M37
]

/** The seam-B frames born in step 3a (14 §2.4). */
const FRAMES_3A = [
  'message.delivery', // B-F12
  'launch.changed', // B-F18
  'launch.failed', // B-F19
  'host.recovered', // B-F21
  'toast' // B-F28
]

interface LaunchChanged {
  launch: { launchId: LaunchId; state: string; dwarfId?: DwarfId }
}

/** A simulated launch into `mineId` over `ui`, settled: the dwarf it produced. */
async function launchSimulated(h: Host, ui: Parameters<Host['settle']>[0], mineId: MineId) {
  const answered = await h.call(ui, 'launching.launch', {
    mineId,
    way: { kind: 'supplier', providerId: 'simulated' },
    prompt: 'Survey the north seam',
    jevOn: false,
    jevAutoAccept: false,
    requestId: h.rid()
  })
  expect(answered).toMatchObject({ ok: true })
  // The simulated handshake, then the 3 s early-failure window (ADR-020 D4).
  await h.run(4_000, ui)
  const succeeded = evts<LaunchChanged>(ui, 'launch.changed').find(
    (frame) => frame.launch.state === 'succeeded'
  )
  const dwarfId = succeeded?.launch.dwarfId
  if (dwarfId === undefined) throw new Error('the launch produced no dwarf')
  return dwarfId
}

describe('launching and conversation write side wired', () => {
  it('[ADR-015] recoverAfterHostStart runs after the modules are constructed and before observation starts and before ready', async () => {
    const h = await bootHost(world(), {
      epoch: 'epoch-182-a',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })

    const step = (name: string): number => h.order.indexOf(name)
    expect(step('construct-modules')).toBeGreaterThanOrEqual(0)
    expect(step('recover-sessions')).toBeGreaterThan(step('construct-modules'))
    expect(step('start-endpoints')).toBeGreaterThan(step('recover-sessions'))
    expect(step('start-observation')).toBeGreaterThan(step('recover-sessions'))
    expect(step('state:ready')).toBeGreaterThan(step('recover-sessions'))
  })

  it('[ADR-001] every seam-B member and frame born in 3a is served by the wired transport', async () => {
    const h = await bootHost(world(), {
      epoch: 'epoch-182-a',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })
    const ui = await h.attach()

    const hello = ui.frames[0] as { capabilities: string[] }
    for (const member of MEMBERS_3A) expect(hello.capabilities).toContain(member)
    for (const frame of FRAMES_3A) expect(hello.capabilities).toContain(`frame:${frame}`)
    expect(hello.capabilities).toContain('section:launches')
    expect(hello.capabilities).toContain('section:recovery')
  })

  it('[C-05, S5.21, S7.04, INV-60] a launch through the wired Host produces a dwarf, a handed-over message and one turn end', async () => {
    const w = world()
    const h = await bootHost(w, {
      epoch: 'epoch-182-a',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })
    const mineId = await h.mine()
    const ui = await h.attach()

    const dwarfId = await launchSimulated(h, ui, mineId)
    expect(h.crew.crew.queries.get(dwarfId)).toMatchObject({
      owned: true,
      canReceiveMessages: true,
      departed: false
    })

    const sent = await h.call(ui, 'conversation.send', {
      dwarfId,
      text: 'Mark the face with chalk',
      attachments: [],
      requestId: h.rid()
    })
    expect(sent).toMatchObject({ ok: true, result: { ok: true } })
    // The simulated turn: the echo, a step, the reply, then the turn's end.
    await h.run(2_000, ui)

    const phases = evts<{ delivery: { phase: string } }>(ui, 'message.delivery').map(
      (frame) => frame.delivery.phase
    )
    expect(phases).toContain('delivered')
    const feed = h.conversation.conversation.queries.feed(dwarfId, { limit: 50 }).messages
    // The prompt is the dwarf's first message (US-LAUNCH-005.AC07); the driver's echo of the sent
    // message, which arrives while the hand-over is still in flight, merges into the sent row: no
    // second bubble (INV-60; amendment-16 lead decision of 2026-10-15).
    expect(
      feed
        .filter((m) => m.role === 'person')
        .map((m) => m.text)
        .sort()
    ).toEqual(['Mark the face with chalk', 'Survey the north seam'])
    expect(feed.filter((m) => m.role === 'dwarf')).toHaveLength(1)
    expect(h.events('TurnEnded')).toHaveLength(1)
    expect(evts(ui, 'turn.ended')).toHaveLength(1)
  })

  it('[S15.13] a stop through the wired Host ends the session and the dwarf departs stopped with no toast', async () => {
    const h = await bootHost(world(), {
      epoch: 'epoch-182-a',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })
    const mineId = await h.mine()
    const ui = await h.attach()
    const dwarfId = await launchSimulated(h, ui, mineId)

    const stopped = await h.call(ui, 'crew.stop', { dwarfId, requestId: h.rid() })
    await h.run(10_000, ui)

    expect(stopped).toMatchObject({ ok: true, result: { ok: true } })
    expect(h.events<{ dwarfId: DwarfId; cause: string }>('DwarfDeparted')).toEqual([
      expect.objectContaining({ dwarfId, cause: 'stopped' })
    ])
    expect(h.launching.launching.owned.liveRecordOf(dwarfId)).toBeNull()
    expect(h.events('LaunchedSessionCrashed')).toEqual([])
    expect(evts(ui, 'toast')).toEqual([])
  })

  it('[INV-120] Stop everything ends the owned session and the Host exits', async () => {
    const h = await bootHost(world(), {
      epoch: 'epoch-182-a',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })
    const mineId = await h.mine()
    const ui = await h.attach()
    const dwarfId = await launchSimulated(h, ui, mineId)

    const answer = h.call(ui, 'host.shutdown', { mode: 'stop-all', requestId: h.rid() })
    await h.run(10_000, ui)

    expect(await answer).toMatchObject({
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [dwarfId], failed: [] } }
    })
    expect(h.events<{ dwarfId: DwarfId; cause: string }>('DwarfDeparted')).toEqual([
      expect.objectContaining({ dwarfId, cause: 'stopped' })
    ])
    expect(h.exits).toEqual([0])
  })

  it('[ADR-028] a launch with "Let Jev choose" asks the wired jev module through the LaunchAdvisor bridge', async () => {
    const h = await bootHost(world(), {
      epoch: 'epoch-182-a',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' }),
      jevKey: JEV_KEY,
      installed: ['claude'],
      jevClaudeModels: ['sonnet']
    })
    h.router.queue(jevAnswers('claude'))
    const mineId = await h.mine()
    const ui = await h.attach()

    const answered = await h.call(ui, 'launching.launch', {
      mineId,
      way: { kind: 'jev' },
      prompt: 'Chart the lower tunnels',
      jevOn: true,
      jevAutoAccept: false,
      requestId: h.rid()
    })
    await h.run(20_000, ui)

    expect(answered).toMatchObject({ ok: true })
    // The jev module was reached with the launch's prompt (16 §4.9 `purpose: 'launch'`), and the
    // launch went out on Jev's pick (S5.12), which its `launches` row keeps (10 §`launches`).
    expect(h.router.requests).toHaveLength(1)
    expect(JSON.stringify(h.router.requests[0])).toContain('Chart the lower tunnels')
    const [launch] = evts<{ launch: { launchId: string } }>(ui, 'launch.changed')
    expect(
      h.db.all('SELECT way_kind, provider_id, model FROM launches WHERE id = ?', [
        launch?.launch.launchId ?? ''
      ])
    ).toEqual([{ way_kind: 'jev', provider_id: 'claude', model: 'sonnet' }])
  })

  it('[ADR-020] a JevAdvisor not-configured answer reaches the launch as jev-could-not-choose with jevReason no-key', async () => {
    const h = await bootHost(world(), {
      epoch: 'epoch-182-a',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' }),
      installed: ['claude'],
      jevClaudeModels: ['sonnet']
    })
    const mineId = await h.mine()
    const ui = await h.attach()

    await h.call(ui, 'launching.launch', {
      mineId,
      way: { kind: 'jev' },
      prompt: 'Chart the lower tunnels',
      jevOn: true,
      jevAutoAccept: false,
      requestId: h.rid()
    })
    await h.run(1_000, ui)

    expect(h.router.requests).toEqual([])
    expect(evts<{ failure: { cause: string; jevReason?: string } }>(ui, 'launch.failed')).toEqual([
      expect.objectContaining({
        failure: expect.objectContaining({ cause: 'jev-could-not-choose', jevReason: 'no-key' })
      })
    ])
  })

  it('[S4.18, CH-01] a Host rebuilt over the same DB resumes the owned session silently', async () => {
    const w = world()
    const recording = codexRecording()
    const spawnsOfB: RecordingSpawn[] = []
    // Host A launches the person's Codex over the recording's first process, which stays alive.
    const a = await bootHost(w, {
      epoch: 'epoch-182-a',
      processes: ({ clock, scheduler }) => codexSpawn(clock, scheduler, recording.launch),
      installed: ['codex']
    })
    const mineId = await a.mine()
    const uiA = await a.attach()
    const answered = await a.call(uiA, 'launching.launch', {
      mineId,
      way: { kind: 'supplier', providerId: 'codex' },
      prompt: 'Reply with exactly the word one.',
      jevOn: false,
      jevAutoAccept: false,
      requestId: a.rid()
    })
    expect(answered).toMatchObject({ ok: true })
    await a.run(4_000, uiA)
    const launched = evts<LaunchChanged>(uiA, 'launch.changed').find(
      (frame) => frame.launch.state === 'succeeded'
    )?.launch
    const dwarfId = launched?.dwarfId
    if (launched === undefined || dwarfId === undefined) throw new Error('codex did not launch')

    // Host A stops unexpectedly (no clean exit); Host B starts over the same database.
    const b = await bootHost(w, {
      epoch: 'epoch-182-b',
      processes: ({ clock, scheduler }) => {
        const spawn = codexSpawn(clock, scheduler, recording.resume)
        spawnsOfB.push(spawn)
        return spawn
      },
      installed: ['codex'],
      previousEpochEnd: { kind: 'crashed', rule: 'none' }
    })
    const uiB = await b.attach()
    await b.run(RESUME_SPACING_MS + 4_000, uiB)

    // The session was resumed in its folder, tagged with its launch and this Host's epoch.
    const resumed = spawnsOfB[0]?.spawns.filter((spawn) => spawn.args.includes('app-server'))
    expect(resumed?.map((spawn) => [spawn.cwd, spawn.env['DWARFAI_SPAWN']])).toEqual([
      [b.mines.mines.queries.folderOf(mineId), `v1:${INSTALL_ID}:${launched.launchId}:epoch-182-b`]
    ])
    // Silently: the dwarf stays, still owned and reachable, with no departure, toast or report.
    expect(b.crew.crew.queries.get(dwarfId)).toMatchObject({
      departed: false,
      owned: true,
      canReceiveMessages: true
    })
    expect(b.events('DwarfDeparted')).toEqual([])
    expect(b.events('LaunchedSessionCrashed')).toEqual([])
    expect(evts(uiB, 'toast')).toEqual([])
    expect(
      evts<{ report: { items: unknown[] } }>(uiB, 'host.recovered').flatMap((f) => f.report.items)
    ).toEqual([])
  })
})

/** The recorded Codex session of C-16 (15 §4.4): a launch, then the resume of the same thread. */
function codexRecording() {
  const set = readFixtureSet(fileURLToPath(new URL('0.153.4-synthetic/', CODEX_FIXTURES)))
  const probe = readFileSync(new URL('0.153.4/probe-help.jsonl', CODEX_FIXTURES), 'utf8')
  const variant = set.cases.find((c) => c.name === 'c-16-resume')?.variants[0]
  const [launch, resume] = variant?.processes ?? []
  if (launch === undefined || resume === undefined) {
    throw new Error('the C-16 recording is missing')
  }
  return { launch: { process: launch, help: probe }, resume: { process: resume, help: probe } }
}

/** `codex app-server` replays `process`; `--help` answers the recorded help; nothing else runs. */
function codexSpawn(
  clock: Parameters<Parameters<typeof bootHost>[1]['processes']>[0]['clock'],
  scheduler: Parameters<Parameters<typeof bootHost>[1]['processes']>[0]['scheduler'],
  recorded: { process: FixtureProcess; help: string }
): RecordingSpawn {
  return new RecordingSpawn({
    clock,
    scheduler,
    decide: (spec) => {
      if (spec.args.includes('--help')) {
        return { kind: 'exit', afterMs: 0, code: 0, stdout: recorded.help }
      }
      if (spec.args.includes('app-server')) {
        return {
          kind: 'fixture',
          transport: new FixtureTransport({
            received: recorded.process.received,
            format: 'jsonl',
            gates: recorded.process.gates
          })
        }
      }
      return { kind: 'exit', afterMs: 0, code: 1, stdout: '' }
    }
  })
}
