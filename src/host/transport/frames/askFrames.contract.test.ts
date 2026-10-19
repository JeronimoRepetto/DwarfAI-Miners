// layer: L6
// L6 (17 §1.6): the ask frames of seam B — B-F15 `ask.opened {ask}`, B-F16 `ask.closed {askId,
// dwarfId, reason}` and B-F17 `ask.step {askId, currentStep}` (14 §2.4, §3.5, frozen; ADR-010
// item 6; 08 §2.7) — projected by frames/askFrames.ts. The answer paths are the real ones over
// their in-memory doubles (testing/answerHarness.ts: its bus refuses a publish inside a
// transaction, 16 §2.3), so the reopen and the close are the broker's own events; `AskOpened` and
// `AskStepChanged` are published here as the broker's `open` and `setStep` will (later:
// ISSUE-129, ISSUE-140). Every frame is checked against its 14 §3.5 strict() schema (14 §1.4).
//
// TC-130-02 (one frame per event, `ui` only, none for `auto-denied`), TC-130-03 (no ask payload
// in a log line).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evtFrameSchema, HOST_FRAME_SCHEMAS, PROTOCOL_VERSION } from '@dwarfai/contracts'
import type { AskId, EventId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeDrainGate } from '../../kernel/fakes/FakeDrainGate'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { AskingEvent, AskRecord } from '../../modules/asking'
import {
  ANSWER_DWARF,
  ANSWER_EPOCH,
  ANSWER_T0,
  answerHarness,
  OTHER_DWARF
} from '../../modules/asking/testing/answerHarness'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { createUpgradeTargetRule } from '../methods/hostUpgradeRequest'
import type { ChannelRole } from '../roles'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { fixedSnapshotMeta } from '../testing/fixedSnapshotMeta'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { ASK_FRAMES, publishAskFrames } from './askFrames'

/** Question text that must never reach a log line (NFR-SEC-12). */
const CANARY = 'canary-0130-ask-question-text'
const REFUSING = '01890a5d-ac96-774b-bcce-000000000131'
const ACCEPTED = '01890a5d-ac96-774b-bcce-000000000132'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

interface Received {
  name: string
  data: unknown
  seq: number
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, { parse(value: unknown): unknown } | undefined>> =
    HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** Attaches one connection of `role` (a viewer bound to `dwarfId`) and returns what it receives. */
function connect(
  connections: ConnectionRegistry,
  role: ChannelRole,
  clientId: string,
  dwarfId?: string,
  onSend?: (name: string) => void
): Received[] {
  const received: Received[] = []
  connections.attach({
    role,
    clientId,
    ...(dwarfId === undefined ? {} : { dwarfId }),
    send: (name, data, seq) => {
      onSend?.(name)
      received.push({ name, data, seq })
    },
    end: () => Promise.resolve()
  })
  return received
}

let eventSeq = 0

/** An ask's id as the events carry it (ADR-010 spells `AskRecord.id` as `string`). */
const idOf = (ask: AskRecord): AskId => ask.id as AskId

/** An asking event in the kernel envelope (08 §1.2), as the broker publishes it after its commit. */
function event<E extends AskingEvent>(type: E['type'], payload: E['payload']): E {
  eventSeq += 1
  return {
    type,
    v: 1,
    id: `event-0130-${eventSeq}` as EventId,
    at: ANSWER_T0,
    hostEpoch: ANSWER_EPOCH,
    payload
  } as E
}

/** The asking harness with the ask frames routed to a real connection registry. */
function asking(onSend?: (name: string) => void) {
  const h = answerHarness()
  const connections = new ConnectionRegistry({ validateFrame })
  const stop = publishAskFrames({
    events: h.bus,
    asks: { openAskOf: (dwarfId) => h.asks.openFor(dwarfId) },
    frames: connections
  })
  const ui = connect(connections, 'ui', 'ui-1', undefined, onSend)
  const notifier = connect(connections, 'notifier', 'notifier-1')
  const viewer = connect(connections, 'viewer', 'viewer-1', ANSWER_DWARF)
  /** Publishes `AskOpened` for a seeded ask, as the broker's `open` will. */
  const opened = (ask: AskRecord) => h.bus.publish(event('AskOpened', { ask }))
  return { h, connections, stop, ui, notifier, viewer, opened }
}

describe('the ask frames (14 §2.4 B-F15…B-F17; 08 §2.7; ADR-010 item 6)', () => {
  it('[ADR-010] an opened ask, a reopened ask with the same askId, a closed ask and a step change each produce their frame once, after the commit', async () => {
    // At each send, the ask's stored state: the frame follows the commit of what it reports.
    const storedAtSend: Array<string | undefined> = []
    const ref: { h?: ReturnType<typeof answerHarness> } = {}
    const t = asking(() => storedAtSend.push(ref.h?.asks.byId(idOf(ask))?.state))
    ref.h = t.h
    const ask = t.h.question(1, {
      payload: { steps: [{ text: CANARY, options: ['Yes'], allowsFreeText: true }] }
    })

    t.opened(ask)
    t.h.bus.publish(event('AskStepChanged', { askId: idOf(ask), currentStep: 1 }))
    t.h.channel.script({ kind: 'refused', reason: 'channel-rejected' })
    await t.h.paths.answerQuestion(ask.id, [{ step: 0, option: 'Yes' }], REFUSING)
    await t.h.paths.answerQuestion(ask.id, [{ step: 0, option: 'Yes' }], ACCEPTED)

    expect(t.h.eventTypes().filter((type) => type.startsWith('Ask'))).toEqual([
      'AskOpened',
      'AskStepChanged',
      'AskReopened',
      'AskClosed'
    ])
    expect(t.ui.map((frame) => frame.name)).toEqual([
      'ask.opened',
      'ask.step',
      'ask.opened',
      'ask.closed'
    ])
    expect(storedAtSend).toEqual(['open', 'open', 'open', 'answered-in-app'])

    const first = HOST_FRAME_SCHEMAS['ask.opened'].parse(t.ui[0]?.data)
    expect(first.ask).toEqual(ask)
    expect(HOST_FRAME_SCHEMAS['ask.step'].parse(t.ui[1]?.data)).toEqual({
      askId: ask.id,
      currentStep: 1
    })
    // The reopened card is the same ask, back to open (PO #91; US-ASK-007).
    const reopened = HOST_FRAME_SCHEMAS['ask.opened'].parse(t.ui[2]?.data)
    expect(reopened.ask.id).toBe(ask.id)
    expect(reopened.ask.state).toBe('open')
    expect(HOST_FRAME_SCHEMAS['ask.closed'].parse(t.ui[3]?.data)).toEqual({
      askId: ask.id,
      dwarfId: ANSWER_DWARF,
      reason: 'answered-in-app'
    })
    // Seq rises by one per frame: nothing was sent twice.
    expect(t.ui.map((frame) => frame.seq)).toEqual([1, 2, 3, 4])
    expect(ASK_FRAMES).toEqual(['ask.opened', 'ask.closed', 'ask.step'])

    t.stop()
    t.opened(t.h.question(2))
    expect(t.ui).toHaveLength(4)
  })

  it('[ADR-010] an auto-denied ask produces no ask.opened frame', () => {
    const t = asking()
    const ask = t.h.permission(3, { state: 'auto-denied', closedAt: ANSWER_T0 + 3 })

    // ADR-010 item 12; 08 §2.7: an auto-denied ask publishes AskClosed directly, never AskOpened.
    t.h.bus.publish(
      event('AskClosed', { askId: idOf(ask), dwarfId: ANSWER_DWARF, reason: 'auto-denied' })
    )

    expect(t.ui.map((frame) => frame.name)).toEqual(['ask.closed'])
    expect(t.ui[0]?.data).toEqual({ askId: ask.id, dwarfId: ANSWER_DWARF, reason: 'auto-denied' })
  })

  it('[ADR-003] ask frames reach ui connections only, never notifier or viewer', async () => {
    const t = asking()
    const otherViewer = connect(t.connections, 'viewer', 'viewer-2', OTHER_DWARF)
    const ask = t.h.permission(4)

    t.opened(ask)
    t.h.bus.publish(event('AskStepChanged', { askId: idOf(ask), currentStep: 0 }))
    t.h.channel.script({ kind: 'refused', reason: 'invalid-answer' })
    await t.h.paths.answerPermission(ask.id, 'allow', REFUSING)
    await t.h.paths.answerPermission(ask.id, 'deny', ACCEPTED)

    expect(t.ui.map((frame) => frame.name)).toEqual([
      'ask.opened',
      'ask.step',
      'ask.opened',
      'ask.closed'
    ])
    expect(t.notifier).toEqual([])
    expect(t.viewer).toEqual([])
    expect(otherViewer).toEqual([])
  })

  it('[NFR-SEC-12] an ask payload never reaches a log line', async () => {
    const h = answerHarness()
    const transport = await realTransport()
    const stop = publishAskFrames({
      events: h.bus,
      asks: { openAskOf: (dwarfId) => h.asks.openFor(dwarfId) },
      frames: transport.connections
    })
    cleanups.push(stop)
    const ui = await transport.attach()
    ui.send({ type: 'req', id: 's1', method: 'events.subscribe', params: {} })
    const question = h.question(5, {
      payload: { steps: [{ text: CANARY, options: [`${CANARY} option`], allowsFreeText: true }] }
    })
    const permission = h.permission(6, {
      dwarfId: OTHER_DWARF,
      payload: { toolName: 'Bash', requestText: `${CANARY} rm -rf build` }
    })

    h.bus.publish(event('AskOpened', { ask: question }))
    h.bus.publish(event('AskOpened', { ask: permission }))
    h.channel.script({ kind: 'refused', reason: 'channel-rejected' })
    await h.paths.answerQuestion(question.id, [{ step: 0, freeText: CANARY }], REFUSING)
    await ui.settle()

    const asks = ui.frames
      .filter((frame) => (frame as { type?: string }).type === 'evt')
      .map((frame) => evtFrameSchema.parse(frame))
      .filter((evt) => evt.name === 'ask.opened')
    expect(asks).toHaveLength(3)
    expect(JSON.stringify(asks)).toContain(CANARY)
    expect(transport.log.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(transport.log.entries)).not.toContain(CANARY)
  })
})

/** One Host transport: real connections, dispatcher and outbound queue, faked ports (as subscribe.contract.test.ts). */
async function realTransport() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-130-asks-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch: ANSWER_EPOCH,
    drain: createUpgradeDrain({
      gate: new FakeDrainGate([{ kind: 'in-flight' }]),
      state,
      scheduler,
      lifecycle,
      log
    }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    }),
    ids: new SequenceIdGenerator(),
    sections: new SectionRegistry(),
    snapshotMeta: fixedSnapshotMeta(() => state.current().state)
  })
  const ids = new SequenceIdGenerator()
  const throttle = new HelloThrottle(clock)

  /** Connects a `ui` client and returns it once hello.ok arrived. */
  const attach = async (): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: ANSWER_EPOCH,
      state: () => state.current(),
      capabilities: () => [],
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'ui',
      token: secret,
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  return { log, connections, attach }
}
