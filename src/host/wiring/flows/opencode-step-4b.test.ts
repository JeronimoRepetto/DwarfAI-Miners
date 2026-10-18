// layer: L2
// L2 flow of step 4b (17 §1.2; 15 §9.2; 21 §2 cut 4b "Parity / exit"; ADR-011 items 3, 7; ISSUE-238): an OpenCode launch
// through the wired Host, composed as host/main.ts composes it (flows/testing/cut3aHost.ts, the Host the 3a…3e flows
// boot), runs launch → turn → ask → answer → turn end on the person's own `opencode acp` through the generic
// `AcpDriver` configured by `OPENCODE_ACP` (S-031-3 failed, so ADR-009 D4 option (c) launches OpenCode). The Host
// reads its own `opencode-permissions` state (owned since 4a, ADR-016 item 5): while it is `on-verified` the permission
// request is a card the person answers; otherwise it is denied by the Host with one chat line and no card. The
// `opencode acp` process replays the synthetic C-06 case of `fixtures/opencode/acp/1.18.32-synthetic/` (its handshake
// is the recorded 1.18.32 one); `--help` answers the S-031-3 record's `opencode --help`. No real process.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import { readFixtureSet, type FixtureProcess } from '../../modules/suppliers/testing/fixtureSet'
import { FixtureTransport } from '../../modules/suppliers/testing/fixtureTransport'
import { RecordingSpawn } from '../../modules/suppliers/testing/recordingSpawn'
import { bootHost, cleanUp, evts, world } from './testing/cut3aHost'

const FIXTURES = new URL('../../../../fixtures/opencode/acp/1.18.32-synthetic/', import.meta.url)
/** `opencode --help` as OpenCode 1.18.32 printed it (the S-031-3 record): it lists `acp` and `serve`. */
const HELP = readFileSync(
  new URL('../../../../spike-results/S-031-3/help/help-root.txt', import.meta.url),
  'utf8'
)

afterEach(cleanUp)

/** The synthetic C-06 session: one `opencode acp` whose first turn asks to write a file, then ends the turn. */
function permissionRecording(): FixtureProcess {
  const set = readFixtureSet(fileURLToPath(FIXTURES))
  const own = set.cases.find((c) => c.name === 'c-06-permission-allow')
  const process = own?.variants[0]?.processes?.[0] ?? own?.variants[0]
  if (process === undefined) throw new Error('the C-06 recording is missing')
  return process as FixtureProcess
}

interface LaunchChanged {
  launch: { launchId: LaunchId; state: string; dwarfId?: DwarfId }
}

/** Boots the 4b Host with `opencode` installed and the integration in `state`, and launches one OpenCode dwarf. */
async function launchOpenCode(state: 'off' | 'on-unverified' | 'on-verified', epoch: string) {
  const w = world()
  const recorded = permissionRecording()
  let spawn: RecordingSpawn | undefined
  const transports: FixtureTransport[] = []
  const h = await bootHost(w, {
    epoch,
    processes: ({ clock, scheduler }) => {
      spawn = new RecordingSpawn({
        clock,
        scheduler,
        decide: (spec) => {
          if (spec.args.includes('--help')) {
            return { kind: 'exit', afterMs: 0, code: 0, stdout: HELP }
          }
          if (spec.args.includes('acp')) {
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
    installed: ['opencode']
  })
  h.openCodePermissions(state)
  const mineId = await h.mine()
  const ui = await h.attach()
  const answered = await h.call(ui, 'launching.launch', {
    mineId,
    way: { kind: 'supplier', providerId: 'opencode' },
    prompt: 'Write the notes.',
    jevOn: false,
    jevAutoAccept: false,
    requestId: h.rid()
  })
  expect(answered).toMatchObject({ ok: true })
  await h.run(6_000, ui)
  const launched = evts<LaunchChanged>(ui, 'launch.changed').find(
    (frame) => frame.launch.state === 'succeeded'
  )?.launch
  const sent = () => transports.flatMap((t) => t.sent.map((line) => JSON.parse(line) as unknown))
  return { h, ui, launched, spawn: () => spawn, sent }
}

describe('step 4b OpenCode flow (21 §2 cut 4b)', () => {
  it('[ADR-011, C-27, C-06] a Host-launched OpenCode session shows a card while the integration is on-verified, and the Allow goes back as allow_once', async () => {
    const { h, ui, launched, sent, spawn } = await launchOpenCode('on-verified', 'epoch-238-a')
    const dwarfId = launched?.dwarfId
    expect(dwarfId, 'the Host launched opencode acp').toBeDefined()
    // The person's own `opencode acp` (15 §4.7), never `opencode serve` (S-031-3: no Host-launched server).
    const agent = spawn()?.spawns.find((s) => s.args.includes('acp'))
    expect(agent?.args).toEqual(['acp'])
    expect(spawn()?.spawns.some((s) => s.args.includes('serve'))).toBe(false)

    // One card of the launched dwarf (ADR-010), answered Allow: `allow_once`, never `allow_always` (ADR-008 item 3).
    const opened = evts<{ ask: { id: string; dwarfId: string; kind: string } }>(ui, 'ask.opened')
    expect(opened.map((f) => [f.ask.dwarfId, f.ask.kind])).toEqual([[dwarfId, 'permission']])
    const allowed = await h.call(ui, 'asking.answerPermission', {
      askId: opened[0]?.ask.id,
      decision: 'allow',
      requestId: h.rid()
    })
    await h.run(2_000, ui)
    expect(allowed).toMatchObject({ ok: true, result: { kind: 'accepted' } })
    expect(sent()).toContainEqual({
      jsonrpc: '2.0',
      id: 100,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } }
    })
    expect(evts(ui, 'turn.ended')).toHaveLength(1)

    // C-23 (INV-59, ADR-013): no delegation token or secret in the agent's argv or inherited env.
    expect(Object.keys(agent?.env ?? {})).not.toContain('DWARFAI_DELEGATION_TOKEN')
    expect(Object.keys(agent?.env ?? {})).not.toContain('OPENCODE_CONFIG_CONTENT')
    expect(JSON.stringify(agent?.args)).not.toMatch(/token/i)
  })

  it('[ADR-011, C-27] a Host-launched OpenCode session auto-denies its permission request with one chat line while the integration is off or unverified', async () => {
    for (const [state, epoch] of [
      ['off', 'epoch-238-b'],
      ['on-unverified', 'epoch-238-c']
    ] as const) {
      const { h, ui, launched, sent } = await launchOpenCode(state, epoch)
      const dwarfId = launched?.dwarfId
      expect(dwarfId, `${state}: the Host launched opencode acp`).toBeDefined()
      // No card: the Host is the one answerer, and it denies (`reject_once`) with one line in the dwarf's chat.
      expect(evts(ui, 'ask.opened'), state).toEqual([])
      expect(sent(), state).toContainEqual({
        jsonrpc: '2.0',
        id: 100,
        result: { outcome: { outcome: 'selected', optionId: 'reject' } }
      })
      const feed = h.conversation.conversation.queries.feed(dwarfId as DwarfId, { limit: 50 })
      expect(
        feed.messages.filter((m) => m.role === 'system-line').length,
        `${state}: one chat line`
      ).toBe(1)
      cleanUp()
    }
  })
})
