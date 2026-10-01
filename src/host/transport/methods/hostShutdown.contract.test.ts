// layer: L6
// L6 (17 §1.6): B-M05 `host.shutdown` over the real seam-B transport — frame codec, hello-first
// authentication, roles, the dispatcher and its requestId de-duplication, the connection registry
// and the clean exit — behind an in-process duplex, with every port faked (14 §2.3 B-M05, §3.4,
// §1.7; ADR-002 D7; ADR-003 items 6, 12; AMENDMENT-5; 13 FM-035; 06 INV-120…INV-122).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  type DwarfId
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { createCleanExit } from '../lifecycle/cleanExit'
import { HostStateHolder } from '../lifecycle/hostState'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerHostShutdown } from './hostShutdown'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0029'
const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const OTHER_REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8059'
const FAILED_DWARF = '01890a5d-ac96-774b-bcce-b302099a8058' as DwarfId

/** One Host transport serving host.shutdown: real connections, faked ports. */
async function host(stopAll = new RecordingStopAll()) {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-029-shutdown-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const journal: string[] = []
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'n/a' })
  const dispatcher = new Dispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => state.current().state
  })
  const ids = new SequenceIdGenerator()
  const checkpoint = new RecordingShutdownCheckpoint(journal)
  const exits: number[] = []
  const endpoint = {
    closed: false,
    close() {
      this.closed = true
      journal.push('endpoint.close')
      return Promise.resolve()
    }
  }
  const lifecycle = createCleanExit({
    checkpoint,
    connections,
    endpoint,
    scheduler,
    log,
    exit: (code) => {
      exits.push(code)
      journal.push(`exit:${code}`)
    }
  })
  registerHostShutdown(dispatcher, { stopAll, lifecycle, log })

  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () => [],
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle: new HelloThrottle(clock)
    })
    const client = new FrameClient(pair.client)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    // Every frame a client receives is journaled as it arrives (the in-process pair delivers a
    // write at once): a `res` by its type, an `evt` by its name, and the close.
    const seen = { count: 1 }
    pair.client.on('data', () => {
      for (; seen.count < client.frames.length; seen.count += 1) {
        const frame = client.frames[seen.count] as { type?: string; name?: string }
        journal.push(`${role}:${frame.name ?? frame.type ?? 'frame'}`)
      }
    })
    pair.client.once('close', () => journal.push(`${role}:closed`))
    return client
  }

  /** Sends `host.shutdown` with `params` and resolves with its `res` frame. */
  const shutdown = async (
    client: FrameClient,
    params: unknown,
    id = 'r1'
  ): Promise<ReturnType<typeof resFrameSchema.parse>> => {
    client.send({ type: 'req', id, method: 'host.shutdown', params })
    await client.until(() => resOf(client, id) !== undefined)
    await client.settle()
    const res = resOf(client, id)
    if (res === undefined) throw new Error(`no res for ${id}`)
    return res
  }

  return {
    journal,
    log,
    connections,
    state,
    checkpoint,
    exits,
    endpoint,
    stopAll,
    attach,
    shutdown
  }
}

function resOf(
  client: FrameClient,
  id: string
): ReturnType<typeof resFrameSchema.parse> | undefined {
  for (const frame of client.frames) {
    const res = resFrameSchema.safeParse(frame)
    if (res.success && res.data.id === id) return res.data
  }
  return undefined
}

/** The evt frame names a client received after hello.ok. */
function evtNames(client: FrameClient): string[] {
  return client.frames
    .slice(1)
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => (frame as { name: string }).name)
}

describe('host.shutdown (14 B-M05; ADR-002 D7; ADR-003 item 12)', () => {
  it('[ADR-003, FM-035, INV-122] host.shutdown from a notifier connection gets FORBIDDEN and changes nothing', async () => {
    const h = await host()
    const notifier = await h.attach('notifier')

    const res = await h.shutdown(notifier, { mode: 'stop-all', requestId: REQUEST_ID })

    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', retryable: false } })
    expect(h.stopAll.calls).toEqual([])
    expect(h.checkpoint.calls).toEqual([])
    expect(h.exits).toEqual([])
    expect(evtNames(notifier)).toEqual([])
    expect(notifier.closed).toBe(false)
    expect(h.state.current()).toEqual({ state: 'ready', jobStatus: 'n/a' })
    expect(h.log.byEvent('channel.forbidden')).toEqual([
      expect.objectContaining({ level: 'error', method: 'host.shutdown', role: 'notifier' })
    ])
  })

  it('[ADR-002] mode when-idle gets INVALID_PARAMS and the Host keeps running', async () => {
    const h = await host()
    const ui = await h.attach('ui')

    const res = await h.shutdown(ui, { mode: 'when-idle', requestId: REQUEST_ID })

    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', retryable: false } })
    expect(h.stopAll.calls).toEqual([])
    expect(h.checkpoint.calls).toEqual([])
    expect(h.exits).toEqual([])
    expect(evtNames(ui)).toEqual([])
    expect(ui.closed).toBe(false)
    expect(h.endpoint.closed).toBe(false)
    expect(h.state.current()).toEqual({ state: 'ready', jobStatus: 'n/a' })
  })

  it('[ADR-002] mode upgrade-drain gets INVALID_PARAMS until the drain is served, and the Host keeps running', async () => {
    const h = await host()
    const ui = await h.attach('ui')

    const res = await h.shutdown(ui, { mode: 'upgrade-drain', requestId: REQUEST_ID })

    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(h.stopAll.calls).toEqual([])
    expect(h.exits).toEqual([])
    expect(ui.closed).toBe(false)
  })

  it('[ADR-002] the response arrives after every end settled and before host.closing', async () => {
    const stopAll = new RecordingStopAll()
    const h = await host(stopAll)
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')
    stopAll.hold()

    ui.send({
      type: 'req',
      id: 'r1',
      method: 'host.shutdown',
      params: { mode: 'stop-all', requestId: REQUEST_ID }
    })
    await ui.settle()
    // Every end is still in flight: nothing is answered, nothing closes.
    expect(stopAll.calls).toEqual([REQUEST_ID])
    expect(resOf(ui, 'r1')).toBeUndefined()
    expect(h.checkpoint.calls).toEqual([])

    stopAll.release()
    await ui.until(() => h.exits.length > 0)
    await ui.settle()
    await notifier.settle()

    const res = resOf(ui, 'r1')
    expect(res).toEqual({
      type: 'res',
      id: 'r1',
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [], failed: [] } }
    })
    expect(
      HOST_METHOD_SCHEMAS['host.shutdown'].result.safeParse(res?.ok === true ? res.result : null)
        .success
    ).toBe(true)
    // 14 §1.7: the effects first, then the `res`, then host.closing and the close.
    expect(h.journal).toEqual([
      'ui:res',
      'checkpoint.flush',
      'checkpoint.markClean:stop-all',
      'ui:host.closing',
      'notifier:host.closing',
      'ui:closed',
      'notifier:closed',
      'endpoint.close',
      'exit:0'
    ])
    expect(evtNames(ui)).toEqual(['host.closing'])
  })

  it('[S12.21, INV-121] with a failed end the Host answers the outcome and keeps every connection open', async () => {
    const stopAll = new RecordingStopAll({ owned: [FAILED_DWARF], failing: [FAILED_DWARF] })
    const h = await host(stopAll)
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')

    const res = await h.shutdown(ui, { mode: 'stop-all', requestId: REQUEST_ID })

    expect(res).toEqual({
      type: 'res',
      id: 'r1',
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [], failed: [FAILED_DWARF] } }
    })
    expect(h.checkpoint.calls).toEqual([])
    expect(h.exits).toEqual([])
    expect(evtNames(ui)).toEqual([])
    expect(evtNames(notifier)).toEqual([])
    expect(ui.closed || notifier.closed).toBe(false)
    expect(h.endpoint.closed).toBe(false)
    expect(h.state.current()).toEqual({ state: 'ready', jobStatus: 'n/a' })
  })

  it('[ADR-003] the same requestId sent twice produces one stop-all', async () => {
    const stopAll = new RecordingStopAll()
    const h = await host(stopAll)
    const ui = await h.attach('ui')
    stopAll.hold()

    ui.send({
      type: 'req',
      id: 'r1',
      method: 'host.shutdown',
      params: { mode: 'stop-all', requestId: REQUEST_ID }
    })
    ui.send({
      type: 'req',
      id: 'r2',
      method: 'host.shutdown',
      params: { mode: 'stop-all', requestId: REQUEST_ID }
    })
    await ui.settle()
    stopAll.release()
    await ui.until(() => h.exits.length > 0)
    await ui.settle()

    expect(stopAll.calls).toEqual([REQUEST_ID])
    const answers = [resOf(ui, 'r1'), resOf(ui, 'r2')]
    expect(answers.map((res) => res?.ok === true && res.result)).toEqual([
      { mode: 'stop-all', outcome: { ended: [], failed: [] } },
      { mode: 'stop-all', outcome: { ended: [], failed: [] } }
    ])
    expect(evtNames(ui)).toEqual(['host.closing'])
    expect(h.checkpoint.calls).toEqual([
      { kind: 'flush' },
      { kind: 'markClean', reason: 'stop-all' }
    ])
    expect(h.exits).toEqual([0])
    expect(h.log.byEvent('channel.dedupe')).toEqual([
      expect.objectContaining({ requestId: REQUEST_ID })
    ])
  })

  it('[ADR-003] a stop-all whose ends failed is not repeated by the same requestId, and a new requestId asks again', async () => {
    const stopAll = new RecordingStopAll({ owned: [FAILED_DWARF], failing: [FAILED_DWARF] })
    const h = await host(stopAll)
    const ui = await h.attach('ui')

    const first = await h.shutdown(ui, { mode: 'stop-all', requestId: REQUEST_ID }, 'r1')
    const repeat = await h.shutdown(ui, { mode: 'stop-all', requestId: REQUEST_ID }, 'r2')
    await h.shutdown(ui, { mode: 'stop-all', requestId: OTHER_REQUEST_ID }, 'r3')

    expect(repeat).toEqual({ ...first, id: 'r2' })
    expect(stopAll.calls).toEqual([REQUEST_ID, OTHER_REQUEST_ID])
    expect(h.exits).toEqual([])
  })
})
