// layer: L6
// L6 (17 §1.6): B-M32 `asking.setStep` (14 §2.3, §3.4 `SetAskStepParams`, frozen; ADR-003 items 6,
// 12; ADR-010 item 9; OQ-03) over the real seam-B transport — frame codec, hello-first
// authentication, roles, the dispatcher and the connection registry — behind in-process duplexes,
// serving the broker's real `setStep` over its in-memory doubles (asking/testing/answerHarness.ts),
// with its `AskStepChanged` projected as B-F17 `ask.step` (frames/askFrames.ts). Every frame is
// checked against its 14 §3.5 strict() schema (14 §1.4).
//
// TC-129-01 (one `ask.step` frame follows a new step), TC-129-02 (a closed, unknown or queued ask
// answers `{}` with nothing written).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_FRAME_SCHEMAS, PROTOCOL_VERSION, resFrameSchema } from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import {
  ANSWER_DWARF,
  ANSWER_EPOCH,
  ANSWER_T0,
  answerHarness
} from '../../modules/asking/testing/answerHarness'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { publishAskFrames } from '../frames/askFrames'
import { HostStateHolder } from '../lifecycle/hostState'
import type { ChannelRole } from '../roles'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerAskingSetStep } from './askingSetStep'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, { parse(value: unknown): unknown } | undefined>> =
    HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

interface Received {
  name: string
  data: unknown
}

/** One Host transport serving B-M32 over the broker's real `setStep`, its frames routed. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-129-step-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(ANSWER_T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const ids = new SequenceIdGenerator()
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  const asking = answerHarness()
  registerAskingSetStep(dispatcher, { broker: asking.steps })
  cleanups.push(
    publishAskFrames({
      events: asking.bus,
      asks: { openAskOf: (dwarfId) => asking.asks.openFor(dwarfId) },
      frames: connections
    })
  )

  const throttle = new HelloThrottle(clock)
  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.21.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: ANSWER_EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({ methods: dispatcher.methods(), frames: [], sections: [] }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  /** Attaches a recording connection of `role` (a viewer bound to `dwarfId`). */
  const listen = (role: ChannelRole, clientId: string, dwarfId?: string): Received[] => {
    const received: Received[] = []
    connections.attach({
      role,
      clientId,
      ...(dwarfId === undefined ? {} : { dwarfId }),
      send: (name, data) => {
        received.push({ name, data })
      },
      end: () => Promise.resolve()
    })
    return received
  }

  return { attach, listen, dispatcher, asking }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

function isRes(frame: unknown, id: string): boolean {
  return (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === id
}

/** Sends one request and returns its `res` frame. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

describe('asking.setStep over seam B (B-M32)', () => {
  it('[ADR-003] asking.setStep answers {} for a closed ask, never an error', async () => {
    const { attach, asking } = await host()
    const ui = await attach('ui')
    const closed = asking.question(1, { state: 'cancelled', closedAt: ANSWER_T0 + 1 })
    const front = asking.question(2)
    const queued = asking.question(3)
    const rowsBefore = structuredClone([...asking.rows.asks])

    for (const askId of [closed.id, asking.askId(99), queued.id]) {
      expect(await call(ui, 'asking.setStep', { askId, step: 1 }), askId).toMatchObject({
        ok: true,
        result: {}
      })
    }
    // The step the front ask is already on.
    expect(await call(ui, 'asking.setStep', { askId: front.id, step: 0 })).toMatchObject({
      ok: true,
      result: {}
    })

    expect([...asking.rows.asks]).toEqual(rowsBefore)
    expect(asking.eventTypes()).toEqual([])
  })

  it('[ADR-003] a negative or non-integer step or an extra key gets INVALID_PARAMS; notifier and viewer get FORBIDDEN', async () => {
    const { attach, dispatcher, asking } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')
    const ask = asking.question(1)

    for (const params of [
      { askId: ask.id, step: -1 },
      { askId: ask.id, step: 1.5 },
      { askId: ask.id, step: '1' },
      { askId: ask.id },
      { askId: 'ask-1', step: 1 },
      { askId: ask.id, step: 1, requestId: '01890a5d-ac96-774b-bcce-b302099a812a' },
      { askId: ask.id, step: 1, picks: [{ step: 0, option: 'All' }] }
    ]) {
      expect(codeOf(await call(ui, 'asking.setStep', params)), JSON.stringify(params)).toBe(
        'INVALID_PARAMS'
      )
    }
    expect(codeOf(await call(notifier, 'asking.setStep', { askId: ask.id, step: 1 }))).toBe(
      'FORBIDDEN'
    )
    const viewer = await dispatcher.dispatch(
      { id: 'v1', method: 'asking.setStep', params: { askId: ask.id, step: 1 } },
      { role: 'viewer', clientId: 'viewer-1' }
    )
    expect(codeOf(viewer)).toBe('FORBIDDEN')

    expect(asking.asks.byId(asking.askId(1))?.currentStep).toBe(0)
    expect(asking.eventTypes()).toEqual([])
  })

  it('[ADR-003] ask.step reaches every ui connection', async () => {
    const { attach, listen, asking } = await host()
    const ui = await attach('ui')
    const windows = [listen('ui', 'ui-window-1'), listen('ui', 'ui-window-2')]
    const notifier = listen('notifier', 'notifier-1')
    const viewer = listen('viewer', 'viewer-1', ANSWER_DWARF)
    const ask = asking.question(1)

    expect(await call(ui, 'asking.setStep', { askId: ask.id, step: 2 })).toMatchObject({
      ok: true,
      result: {}
    })

    for (const window of windows) {
      expect(window).toEqual([{ name: 'ask.step', data: { askId: ask.id, currentStep: 2 } }])
    }
    expect(notifier).toEqual([])
    expect(viewer).toEqual([])
    expect(asking.asks.byId(asking.askId(1))?.currentStep).toBe(2)
  })
})
