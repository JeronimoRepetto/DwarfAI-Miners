// L3 tests of the shared ACP client's opt-in hooks (15 §2.2 row acp, §2.7, §4.10): a driver whose
// ceiling has no question channel declares no form elicitation, and a driver may pick a
// permission option by its native `_meta` decision. Without either option the client behaves as
// every ACP driver's conformance run proves (ISSUE-151, ISSUE-154).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../../kernel/fakes/FakeScheduler'
import { SIMULATED_CAPABILITIES } from '../../../catalog/profiles'
import type { DriverEvent } from '../../../../ports/providerDriver'
import { FixtureTransport } from '../../../../testing/fixtureTransport'
import { RecordingSpawn } from '../../../../testing/recordingSpawn'
import { startAcpSession, type AcpSession, type AcpStart } from './AcpClient'
import type { PermissionReplyHook } from './permissionMapping'

const SESSION = '00000000-0000-4000-8000-00000000ac01'

async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await new Promise<void>((resolve) => process.nextTick(resolve))
  }
}

interface Started {
  readonly session: AcpSession
  readonly events: DriverEvent[]
  readonly sent: () => unknown[]
}

/** Starts one session over `lines` (each gated on the frames sent before it). */
async function start(
  lines: readonly unknown[],
  gates: readonly number[],
  options: Partial<Pick<AcpStart, 'elicitation' | 'permissionReply'>> = {}
): Promise<Started> {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const transport = new FixtureTransport({
    received: lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    format: 'jsonl',
    gates
  })
  const processControl = new RecordingSpawn({
    clock,
    scheduler,
    decide: () => ({ kind: 'fixture', transport })
  })
  const pending = startAcpSession(
    { processControl, clock, scheduler, redact: (text) => text },
    {
      providerId: 'acp-generic',
      executable: '/home/j/.local/bin/synthetic-agent',
      args: ['acp'],
      cwd: '/work/mine',
      env: {},
      mcpServers: [],
      mode: { kind: 'new', prompt: 'first prompt' },
      capabilitiesFor: () => ({ ...SIMULATED_CAPABILITIES }),
      onExit: () => undefined,
      ...options
    }
  )
  await settle()
  const session = await pending
  const events: DriverEvent[] = []
  void (async () => {
    for await (const event of session.events()) events.push(event)
  })()
  await settle()
  return {
    session,
    events,
    sent: () => transport.sent.map((frame) => JSON.parse(frame) as unknown)
  }
}

const INIT = { jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: {} } }
const NEW = { jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } }
const ENDED = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }

const QUESTION = {
  jsonrpc: '2.0',
  id: 50,
  method: 'elicitation/create',
  params: {
    sessionId: SESSION,
    mode: 'form',
    message: 'Which one?',
    requestedSchema: {
      type: 'object',
      properties: { question_0: { type: 'string', title: 'Pick', enum: ['A', 'B'] } },
      required: []
    }
  }
}

const PERMISSION = {
  jsonrpc: '2.0',
  id: 60,
  method: 'session/request_permission',
  params: {
    sessionId: SESSION,
    toolCall: { toolCallId: 'tool_1', title: 'rm -rf build', kind: 'execute' },
    options: [
      { optionId: 'yes', name: 'Yes', kind: 'allow_once', _meta: { native: 'accept' } },
      { optionId: 'stop', name: 'Stop', kind: 'reject_once', _meta: { native: 'cancel' } },
      { optionId: 'no', name: 'No', kind: 'reject_once', _meta: { native: 'decline' } }
    ]
  }
}

const initialize = (sent: unknown[]) => sent[0] as { params: { clientCapabilities: unknown } }

describe('the shared ACP client', () => {
  it('[ADR-009, C-09] by default initialize declares form elicitation and a form question opens an ask', async () => {
    const run = await start([INIT, NEW, QUESTION], [1, 2, 3])
    expect(initialize(run.sent()).params.clientCapabilities).toEqual({ elicitation: { form: {} } })
    expect(run.events.some((event) => event.t === 'ask.opened')).toBe(true)
  })

  it('[ADR-009, C-11] a driver without a question channel declares no elicitation and refuses one with Method not found', async () => {
    const run = await start([INIT, NEW, QUESTION], [1, 2, 3], { elicitation: 'none' })
    expect(initialize(run.sent()).params.clientCapabilities).toEqual({})
    expect(run.events.some((event) => event.t === 'ask.opened')).toBe(false)
    expect(run.sent().find((frame) => (frame as { id?: unknown }).id === 50)).toMatchObject({
      error: { code: -32601 }
    })
  })

  it('[C-07] by default a Deny selects the first reject_once option', async () => {
    const run = await start([INIT, NEW, PERMISSION, ENDED], [1, 2, 3, 4])
    const outcome = await run.session.answerPermission({
      providerRequestId: 'tool_1',
      decision: 'deny'
    })
    expect(outcome).toEqual({ kind: 'accepted' })
    expect(run.sent().find((frame) => (frame as { id?: unknown }).id === 60)).toEqual({
      jsonrpc: '2.0',
      id: 60,
      result: { outcome: { outcome: 'selected', optionId: 'stop' } }
    })
  })

  it('[C-07, ADR-008] a driver hook picks the option of its native _meta decision', async () => {
    const seen: unknown[] = []
    const declineFirst: PermissionReplyHook = (options, decision) => {
      seen.push(options)
      if (decision !== 'deny') return null
      return options.find((option) => option.meta?.native === 'decline')?.optionId ?? null
    }
    const run = await start([INIT, NEW, PERMISSION, ENDED], [1, 2, 3, 4], {
      permissionReply: declineFirst
    })
    const outcome = await run.session.answerPermission({
      providerRequestId: 'tool_1',
      decision: 'deny'
    })
    expect(outcome).toEqual({ kind: 'accepted' })
    expect(seen[0]).toContainEqual({
      optionId: 'no',
      kind: 'reject_once',
      meta: { native: 'decline' }
    })
    expect(run.sent().find((frame) => (frame as { id?: unknown }).id === 60)).toEqual({
      jsonrpc: '2.0',
      id: 60,
      result: { outcome: { outcome: 'selected', optionId: 'no' } }
    })
  })
})
