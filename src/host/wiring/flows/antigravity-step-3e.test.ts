// layer: L2
// L2 flow of step 3e (17 §1.2; 15 §9.2; 21 §2 cut 3e "Parity / exit"; ISSUE-188): an Antigravity launch through the
// wired Host of a development build, composed as host/main.ts composes it (flows/testing/cut3aHost.ts, the Host the
// 3a, 3b and 3d flows boot), runs launch → turn → send → turn on the person's own `agy` through
// `AntigravityNdjsonDriver`, then "Stop dwarf…" ends the session. ISSUE-156 built the driver and left its Host
// composition to this switch. The `agy` process replays `fixtures/antigravity/ndjson/1.1.26-synthetic/c-05-send-turn`
// (synthetic: a real recording is pending, owner waiver 2026-10-18), `--help` answers the agy 1.4.2 option lines the
// probe reads; no real process. The `ui` client is a FrameClient behind an in-process duplex, every frame checked
// against its 14 §3.5 schema.
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import { readFixtureSet, type FixtureProcess } from '../../modules/suppliers/testing/fixtureSet'
import { FixtureTransport } from '../../modules/suppliers/testing/fixtureTransport'
import { RecordingSpawn } from '../../modules/suppliers/testing/recordingSpawn'
import { bootHost, cleanUp, evts, world } from './testing/cut3aHost'

const FIXTURES = new URL(
  '../../../../fixtures/antigravity/ndjson/1.1.26-synthetic/',
  import.meta.url
)

/** The option lines of `agy --help` the probe reads (agy 1.4.2, 2026-10-18). */
const HELP = [
  'Usage of agy:',
  '  --conversation                  Resume a previous conversation by ID',
  '  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json (default text)',
  '  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
  ''
].join('\n')

afterEach(cleanUp)

/** The synthetic C-05 session: one agy whose first turn answers "pong" and whose second answers "ping". */
function sendTurnRecording(): FixtureProcess {
  const set = readFixtureSet(fileURLToPath(FIXTURES))
  const own = set.cases.find((c) => c.name === 'c-05-send-turn')
  const process = own?.variants[0]?.processes?.[0] ?? own?.variants[0]
  if (process === undefined) throw new Error('the C-05 recording is missing')
  return process as FixtureProcess
}

interface LaunchChanged {
  launch: { launchId: LaunchId; state: string; dwarfId?: DwarfId }
}

describe('step 3e Antigravity flow (21 §2 cut 3e)', () => {
  it('[ADR-001, C-01, C-05] in a development build an Antigravity launch through the wired Host runs a turn, takes a sent message and stops', async () => {
    const w = world()
    const recorded = sendTurnRecording()
    let spawn: RecordingSpawn | undefined
    const transports: FixtureTransport[] = []
    const h = await bootHost(w, {
      epoch: 'epoch-188-a',
      processes: ({ clock, scheduler }) => {
        spawn = new RecordingSpawn({
          clock,
          scheduler,
          decide: (spec) => {
            if (spec.args.includes('--help')) {
              return { kind: 'exit', afterMs: 0, code: 0, stdout: HELP }
            }
            if (spec.args.includes('stream-json')) {
              const transport = new FixtureTransport({
                received: recorded.received,
                format: 'jsonl',
                gates: recorded.gates
              })
              transports.push(transport)
              return { kind: 'fixture', transport }
            }
            return { kind: 'exit', afterMs: 0, code: 1, stdout: '' }
          }
        })
        return spawn
      },
      installed: ['agy']
    })
    const mineId = await h.mine()
    const ui = await h.attach()

    const answered = await h.call(ui, 'launching.launch', {
      mineId,
      way: { kind: 'supplier', providerId: 'antigravity' },
      prompt: 'first prompt',
      jevOn: false,
      jevAutoAccept: false,
      requestId: h.rid()
    })
    expect(answered).toMatchObject({ ok: true })
    await h.run(6_000, ui)
    const states = evts<LaunchChanged>(ui, 'launch.changed').map((frame) => frame.launch.state)
    expect(states, 'the Host launched agy').toContain('succeeded')
    const dwarfId = evts<LaunchChanged>(ui, 'launch.changed').find(
      (frame) => frame.launch.state === 'succeeded'
    )?.launch.dwarfId as DwarfId

    // The launch spawned the person's agy with stream-json in and out and no prompt flag (15 §4.8).
    const agy = spawn?.spawns.find((s) => s.args.includes('stream-json'))
    expect(agy?.args).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json'])

    // The second turn: the sent text goes on stdin as one user line, and the reply lands in the dwarf's chat.
    const sent = await h.call(ui, 'conversation.send', {
      dwarfId,
      text: 'second prompt',
      attachments: [],
      requestId: h.rid()
    })
    expect(sent).toMatchObject({ ok: true })
    await h.run(4_000, ui)
    const lines = transports.flatMap((t) => t.sent.map((line) => JSON.parse(line) as unknown))
    expect(lines).toHaveLength(2)
    const feed = h.conversation.conversation.queries.feed(dwarfId, { limit: 50 }).messages
    // The feed reads newest first: the second turn's reply, then the first turn's two messages.
    expect(feed.filter((m) => m.role === 'dwarf').map((m) => m.text.trim())).toEqual([
      'ping',
      'pong',
      'Checking the parser first.'
    ])
    // "Stop dwarf…" ends the session through the Host (ADR-014) and the dwarf departs stopped.
    const stopped = await h.call(ui, 'crew.stop', { dwarfId, requestId: h.rid() })
    expect(stopped).toMatchObject({ ok: true })
    await h.run(10_000, ui)
    expect(
      h
        .events<{ dwarfId: DwarfId; cause: string }>('DwarfDeparted')
        .filter((e) => e.dwarfId === dwarfId)
    ).toMatchObject([{ dwarfId, cause: 'stopped' }])
  })
})
