// layer: L2
// L2 flow of step 3b (17 §1.2; 15 §9.2; 21 §2 cut 3b "Parity / exit"; ISSUE-002): a Codex launch through the wired
// Host, composed as host/main.ts composes it (flows/testing/cut3aHost.ts, the same Host the 3a flows boot), runs
// launch → turn → ask → answer → turn end on the person's own Codex app-server driver. The `codex app-server` process
// is the C-06 recording of `fixtures/codex/app-server-rpc/0.153.4-synthetic/c-06-allow` (a command approval inside the
// first turn), replayed by the conformance harness's `RecordingSpawn`; `--help` answers the recorded 0.153.4 help.
// The `ui` client is a FrameClient behind an in-process duplex, every frame checked against its 14 §3.5 schema.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import { readFixtureSet, type FixtureProcess } from '../../modules/suppliers/testing/fixtureSet'
import { FixtureTransport } from '../../modules/suppliers/testing/fixtureTransport'
import { RecordingSpawn } from '../../modules/suppliers/testing/recordingSpawn'
import { bootHost, cleanUp, evts, world } from './testing/cut3aHost'

const CODEX_FIXTURES = new URL('../../../../fixtures/codex/app-server-rpc/', import.meta.url)

afterEach(cleanUp)

/** The recorded C-06 session: one `codex app-server` process whose first turn asks to run a command. */
function allowRecording(): { process: FixtureProcess; help: string; prompt: string } {
  const set = readFixtureSet(fileURLToPath(new URL('0.153.4-synthetic/', CODEX_FIXTURES)))
  const own = set.cases.find((c) => c.name === 'c-06-allow')
  const process = own?.variants[0]?.processes?.[0] ?? own?.variants[0]
  if (process === undefined) throw new Error('the C-06 recording is missing')
  return {
    process: process as FixtureProcess,
    help: readFileSync(new URL('0.153.4/probe-help.jsonl', CODEX_FIXTURES), 'utf8'),
    prompt: 'first prompt'
  }
}

/** `codex app-server` replays `recorded`; `--help` answers the recorded help; nothing else runs. */
function codexSpawn(
  clock: Parameters<Parameters<typeof bootHost>[1]['processes']>[0]['clock'],
  scheduler: Parameters<Parameters<typeof bootHost>[1]['processes']>[0]['scheduler'],
  recorded: { process: FixtureProcess; help: string },
  transports: FixtureTransport[]
): RecordingSpawn {
  return new RecordingSpawn({
    clock,
    scheduler,
    decide: (spec) => {
      if (spec.args.includes('--help')) {
        return { kind: 'exit', afterMs: 0, code: 0, stdout: recorded.help }
      }
      if (spec.args.includes('app-server')) {
        const transport = new FixtureTransport({
          received: recorded.process.received,
          format: 'jsonl',
          gates: recorded.process.gates
        })
        transports.push(transport)
        return { kind: 'fixture', transport }
      }
      return { kind: 'exit', afterMs: 0, code: 1, stdout: '' }
    }
  })
}

interface LaunchChanged {
  launch: { launchId: LaunchId; state: string; dwarfId?: DwarfId }
}

describe('step 3b Codex flow (21 §2 cut 3b)', () => {
  it('[ADR-001, ADR-010, C-06, C-23] a Codex launch through the wired Host runs a turn whose permission ask goes back allowed and ends the turn, with no delegation token in its argv or env', async () => {
    const w = world()
    const recorded = allowRecording()
    let spawn: RecordingSpawn | undefined
    const transports: FixtureTransport[] = []
    const h = await bootHost(w, {
      epoch: 'epoch-002-a',
      processes: ({ clock, scheduler }) => {
        spawn = codexSpawn(clock, scheduler, recorded, transports)
        return spawn
      },
      installed: ['codex']
    })
    const mineId = await h.mine()
    const ui = await h.attach()

    const answered = await h.call(ui, 'launching.launch', {
      mineId,
      way: { kind: 'supplier', providerId: 'codex' },
      prompt: recorded.prompt,
      jevOn: false,
      jevAutoAccept: false,
      requestId: h.rid()
    })
    expect(answered).toMatchObject({ ok: true })
    await h.run(4_000, ui)
    const launched = evts<LaunchChanged>(ui, 'launch.changed').find(
      (frame) => frame.launch.state === 'succeeded'
    )?.launch
    const dwarfId = launched?.dwarfId
    if (dwarfId === undefined) throw new Error('codex did not launch')

    // The turn's command approval reaches the person as one permission ask of the launched dwarf (ADR-010).
    const opened = evts<{ ask: { id: string; dwarfId: string; kind: string } }>(ui, 'ask.opened')
    expect(opened.map((f) => [f.ask.dwarfId, f.ask.kind])).toEqual([[dwarfId, 'permission']])
    const allowed = await h.call(ui, 'asking.answerPermission', {
      askId: opened[0]?.ask.id,
      decision: 'allow',
      requestId: h.rid()
    })
    await h.run(2_000, ui)

    // Allow goes back as `accept` (never the session-wide accept), and the turn ends with the dwarf's reply.
    expect(allowed).toMatchObject({ ok: true, result: { kind: 'accepted' } })
    const sent = transports.flatMap((t) => t.sent.map((line) => JSON.parse(line) as unknown))
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 0, result: { decision: 'accept' } })
    expect(evts(ui, 'turn.ended')).toHaveLength(1)
    const feed = h.conversation.conversation.queries.feed(dwarfId, { limit: 50 }).messages
    expect(feed.filter((m) => m.role === 'dwarf').map((m) => m.text)).toEqual(['The tests pass.'])

    // C-23 (INV-59, ADR-013): no delegation token or secret in the provider process's argv or inherited env.
    const server = spawn?.spawns.find((s) => s.args.includes('app-server'))
    expect(server).toBeDefined()
    expect(Object.keys(server?.env ?? {})).not.toContain('DWARFAI_DELEGATION_TOKEN')
    expect(JSON.stringify(server?.args)).not.toMatch(/token/i)
  })
})
