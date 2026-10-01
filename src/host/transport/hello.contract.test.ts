// layer: L6
// L6 (17 §1.6): the real seam-B transport — frame codec, hello-first authentication, roles and the
// method dispatcher — behind an in-process duplex, with faked modules (ADR-003 items 3–6, 12;
// 14 §1.5, §2.3, §2.4, §3.3). hello.os.test.ts runs the authentication cases over a real pipe or
// socket (L8).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  encodeFrame,
  FRAME_CAP_AFTER_HELLO_OK,
  FRAME_CAP_BEFORE_HELLO_OK,
  helloOkSchema,
  PROTOCOL_VERSION,
  requestIdSchema,
  resFrameSchema,
  type HelloOk
} from '@dwarfai/contracts'
import { CANARY_CORPUS } from '../../contracts/logging/testing/canaryCorpus'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { UI_TOKEN_FILE, UiToken } from './auth/uiToken'
import { collectCapabilities } from './capabilities'
import { acceptConnection, HELLO_TIMEOUT_MS } from './connection'
import { Dispatcher } from './dispatcher'
import { ConnectionRegistry } from './connectionRegistry'
import { HostStateHolder } from './lifecycle/hostState'
import { METHOD_ROLES } from './roles'
import { FrameClient } from './testing/frameClient'
import { inProcessDuplex } from './testing/inProcessDuplex'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const IDENTITY = { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION }
const EPOCH = 'epoch-0001'

/** A fresh run directory for one Host boot. */
function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-023-hello-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'run')
}

/** One Host boot: a token issued into its run directory, a dispatcher with faked modules. */
async function boot(dir = runDir()) {
  const token = new UiToken()
  await token.issue(dir)
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const dispatcher = new Dispatcher({ log, clock, state: () => state.current().state })
  // Faked modules: one protocol method, one ui method with strict params, one ui-only mutation.
  dispatcher.register('ping', z.object({}).strict(), METHOD_ROLES['ping'] ?? [], () => ({
    at: clock.now()
  }))
  dispatcher.register(
    'preferences.get',
    z.object({ text: z.string() }).strict(),
    METHOD_ROLES['preferences.get'] ?? [],
    (params) => ({ length: params.text.length })
  )
  // AMENDED for ISSUE-027 (was: `register` with params `{ mode }`): host.shutdown mutates (14 §1.6),
  // so it registers as mutating and its params carry the requestId, as HostShutdownParams does.
  dispatcher.registerMutating(
    'host.shutdown',
    z.object({ mode: z.literal('stop-all'), requestId: requestIdSchema }).strict(),
    METHOD_ROLES['host.shutdown'] ?? [],
    () => ({ accepted: true })
  )
  const ids = new SequenceIdGenerator()

  /** Opens one connection to this boot's transport and returns its test client. */
  const connect = (): FrameClient => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: IDENTITY,
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () => collectCapabilities({ methods: dispatcher.methods() }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections
    })
    return new FrameClient(pair.client)
  }
  return { dir, token: readFileSync(join(dir, UI_TOKEN_FILE), 'utf8'), clock, log, state, connect }
}

function hello(token: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'ui',
    token,
    client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 },
    ...overrides
  }
}

/** Connects and authenticates with `role`; returns the client once hello.ok arrived. */
async function authenticated(
  host: Awaited<ReturnType<typeof boot>>,
  role = 'ui'
): Promise<FrameClient> {
  const client = host.connect()
  client.send(hello(host.token, { role }))
  await client.settle()
  expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
  return client
}

/** Sends one req and returns its validated res. */
async function call(client: FrameClient, id: string, method: string, params: unknown) {
  const before = client.frames.length
  client.send({ type: 'req', id, method, params })
  await client.settle()
  expect(client.frames.length).toBe(before + 1)
  return resFrameSchema.parse(client.frames[before])
}

/** A frame header announcing `length` bytes, with no body. */
function header(length: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, length, true)
  return bytes
}

describe('the seam-B transport: hello first, roles, dispatcher (ADR-003 items 3–6, 12)', () => {
  it('[ADR-003, C-11] no byte is sent before a valid hello', async () => {
    const host = await boot()
    const client = host.connect()
    const frame = encodeFrame(hello(host.token))

    // Connected, then most of a valid hello: the Host stays silent and keeps the connection.
    await client.settle()
    client.sendRaw(frame.subarray(0, frame.length - 1))
    await client.settle()
    expect({ bytes: client.bytes, closed: client.closed }).toEqual({ bytes: 0, closed: false })

    // The last byte completes the hello: the first bytes the Host ever sends are hello.ok.
    client.sendRaw(frame.subarray(frame.length - 1))
    await client.settle()
    expect(client.frames).toHaveLength(1)
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
  })

  it('[ADR-003, FM-026] a bad token gets one AUTH_FAILED error frame and the connection closes', async () => {
    const host = await boot()
    for (const token of ['0'.repeat(64), '', host.token.toUpperCase(), `${host.token}00`]) {
      const client = host.connect()

      client.send(hello(token))
      await client.settle()

      // Exactly one frame, with no detail beyond its code, then the close.
      expect(client.frames, JSON.stringify(token)).toEqual([{ type: 'error', code: 'AUTH_FAILED' }])
      expect(client.closed).toBe(true)
    }
    expect(host.log.byEvent('channel.hello.refused')).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({ level: 'warn', causeClass: 'AUTH_FAILED' })
      )
    )
  })

  it('[ADR-003] a viewer hello gets AUTH_FAILED until the per-view token issuer exists', async () => {
    const host = await boot()
    const client = host.connect()

    // Even with the uiToken: a viewer authenticates only with a per-view token (later: ISSUE-170).
    client.send(hello(host.token, { role: 'viewer', viewId: 'view-1' }))
    await client.settle()

    expect(client.frames).toEqual([{ type: 'error', code: 'AUTH_FAILED' }])
    expect(client.closed).toBe(true)
  })

  it('[ADR-003] a second hello gets PROTOCOL_ERROR and close; a req before hello gets PROTOCOL_ERROR and close', async () => {
    const host = await boot()

    const twice = await authenticated(host)
    twice.send(hello(host.token))
    await twice.settle()
    expect(twice.frames.slice(1)).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])
    expect(twice.closed).toBe(true)

    const early = host.connect()
    early.send({ type: 'req', id: '1', method: 'ping', params: {} })
    await early.settle()
    expect(early.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])
    expect(early.closed).toBe(true)

    // A first frame that is not JSON, or not a hello shape, is the same refusal, never a crash.
    const body = new TextEncoder().encode('{"type":"hel')
    const garbage = host.connect()
    garbage.sendRaw(new Uint8Array([...header(body.length), ...body]))
    await garbage.settle()
    expect(garbage.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])
    expect(garbage.closed).toBe(true)

    const extraKey = host.connect()
    extraKey.send(hello(host.token, { admin: true }))
    await extraKey.settle()
    expect(extraKey.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])
  })

  it('[ADR-003] no hello within 5 s gets HELLO_TIMEOUT', async () => {
    const host = await boot()
    const client = host.connect()
    // A partial hello does not stop the clock.
    client.sendRaw(encodeFrame(hello(host.token)).subarray(0, 10))
    await client.settle()

    host.clock.advance(HELLO_TIMEOUT_MS - 1)
    await client.settle()
    expect({ frames: client.frames, closed: client.closed }).toEqual({ frames: [], closed: false })

    host.clock.advance(1)
    await client.settle()
    expect(HELLO_TIMEOUT_MS).toBe(5_000)
    expect(client.frames).toEqual([{ type: 'error', code: 'HELLO_TIMEOUT' }])
    expect(client.closed).toBe(true)
    expect(host.log.byEvent('channel.hello.refused')).toEqual([
      expect.objectContaining({ level: 'warn', causeClass: 'HELLO_TIMEOUT' })
    ])
  })

  it('[ADR-003, NFR-SEC-05] an McpHello on the UI endpoint gets PROTOCOL_ERROR', async () => {
    const host = await boot()
    const client = host.connect()

    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'mcp',
      launchId: '00000000-0000-7000-8000-000000000001',
      credential: host.token
    })
    await client.settle()

    expect(client.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])
    expect(client.closed).toBe(true)
  })

  it('[ADR-003] a hello with endpointGeneration 2 gets INCOMPATIBLE_GENERATION', async () => {
    const host = await boot()
    const client = host.connect()

    client.send(hello(host.token, { endpointGeneration: 2 }))
    await client.settle()

    expect(client.frames).toEqual([{ type: 'error', code: 'INCOMPATIBLE_GENERATION' }])
    expect(client.closed).toBe(true)
  })

  it('[ADR-003] a valid ui hello gets hello.ok with epoch, state, jobStatus, capabilities and a clientId', async () => {
    const host = await boot()
    host.state.report({ state: 'migrating', jobStatus: 'in-job' })
    const client = host.connect()

    client.send(hello(host.token))
    await client.settle()

    expect(client.frames).toEqual([expect.objectContaining({ type: 'hello.ok' })])
    const ok: HelloOk = helloOkSchema.parse(client.frames[0])
    expect(ok).toEqual({
      type: 'hello.ok',
      hostVersion: '0.20.0',
      buildId: 'abc1234',
      protocolVersion: PROTOCOL_VERSION,
      endpointGeneration: 1,
      epoch: EPOCH,
      state: 'migrating',
      jobStatus: 'in-job',
      // Every method the Host serves, as exact names (14 §1.3).
      capabilities: ['host.shutdown', 'ping', 'preferences.get'],
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    })
    expect(client.closed).toBe(false)
    expect(host.log.byEvent('channel.attach')).toEqual([
      expect.objectContaining({ level: 'info', role: 'ui', connId: ok.clientId })
    ])

    // Each connection gets its own id; a notifier authenticates with the same uiToken.
    const second = await authenticated(host, 'notifier')
    expect(helloOkSchema.parse(second.frames[0]).clientId).not.toBe(ok.clientId)

    client.stream.destroy()
    await client.settle()
    expect(host.log.byEvent('channel.detach')).toEqual([
      expect.objectContaining({ level: 'info', role: 'ui', connId: ok.clientId })
    ])
  })

  it('[ADR-003, FM-035] a notifier calling a method outside its scope gets FORBIDDEN and an error record', async () => {
    const host = await boot()
    const notifier = await authenticated(host, 'notifier')
    const connId = helloOkSchema.parse(notifier.frames[0]).clientId

    const refused = await call(notifier, '7', 'host.shutdown', { mode: 'stop-all' })
    expect(refused).toEqual({
      type: 'res',
      id: '7',
      ok: false,
      error: { code: 'FORBIDDEN', message: expect.any(String), retryable: false }
    })
    expect(host.log.byEvent('channel.forbidden')).toEqual([
      expect.objectContaining({
        level: 'error',
        method: 'host.shutdown',
        role: 'notifier',
        connId
      })
    ])
    // The connection stays open and a method in its scope is served.
    expect(await call(notifier, '8', 'ping', {})).toEqual({
      type: 'res',
      id: '8',
      ok: true,
      result: { at: 1_000 }
    })
    // The same method on a ui connection is allowed.
    const ui = await authenticated(host)
    expect(
      await call(ui, '9', 'host.shutdown', { mode: 'stop-all', requestId: REQUEST_ID })
    ).toMatchObject({ ok: true })
  })

  it('[ADR-003, FM-031, FM-033] an unknown method gets METHOD_NOT_FOUND; invalid params get INVALID_PARAMS; during starting or migrating a non-protocol method gets HOST_NOT_READY', async () => {
    const host = await boot()
    const client = await authenticated(host)

    expect(await call(client, '1', 'mines.teleport', {})).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', retryable: false }
    })
    for (const params of [{}, { text: 1 }, { text: 'a', extra: true }, null, 'text']) {
      expect(
        await call(client, '2', 'preferences.get', params),
        JSON.stringify(params)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', retryable: false } })
    }
    expect(await call(client, '3', 'preferences.get', { text: 'abc' })).toEqual({
      type: 'res',
      id: '3',
      ok: true,
      result: { length: 3 }
    })

    for (const state of ['starting', 'migrating'] as const) {
      host.state.report({ state, jobStatus: 'none' })
      expect(await call(client, '4', 'preferences.get', { text: 'abc' }), state).toMatchObject({
        ok: false,
        error: { code: 'HOST_NOT_READY', retryable: true }
      })
      // The protocol set is served whatever the state.
      expect(await call(client, '5', 'ping', {}), state).toMatchObject({ ok: true })
    }
    // Every request is logged by name only, at debug.
    expect(host.log.byEvent('channel.req').length).toBeGreaterThan(0)
  })

  it('[ADR-003, FM-030] an oversized frame closes the connection without a frame, before and after hello.ok', async () => {
    const host = await boot()

    const early = host.connect()
    early.sendRaw(header(FRAME_CAP_BEFORE_HELLO_OK + 1))
    await early.settle()
    expect({ frames: early.frames, closed: early.closed }).toEqual({ frames: [], closed: true })

    // After hello.ok a frame above 1 MiB is fine, and one above 8 MiB closes the connection.
    const late = await authenticated(host)
    const big = await call(late, '1', 'preferences.get', { text: 'x'.repeat(2 * 1_048_576) })
    expect(big).toMatchObject({ ok: true, result: { length: 2 * 1_048_576 } })
    late.sendRaw(header(FRAME_CAP_AFTER_HELLO_OK + 1))
    await late.settle()
    expect(late.frames).toHaveLength(2)
    expect(late.closed).toBe(true)

    expect(host.log.byEvent('channel.frame.oversize')).toEqual([
      expect.objectContaining({ level: 'error', bytes: FRAME_CAP_BEFORE_HELLO_OK + 1 }),
      expect.objectContaining({ level: 'error', bytes: FRAME_CAP_AFTER_HELLO_OK + 1 })
    ])
  })

  it('[ADR-003] a hello and a req coalesced in one chunk are answered in order', async () => {
    const host = await boot()
    const client = host.connect()

    client.sendRaw(
      new Uint8Array([
        ...encodeFrame(hello(host.token)),
        ...encodeFrame({ type: 'req', id: '1', method: 'ping', params: {} })
      ])
    )
    await client.settle()

    expect(client.frames).toEqual([
      expect.objectContaining({ type: 'hello.ok' }),
      { type: 'res', id: '1', ok: true, result: { at: 1_000 } }
    ])
  })

  it('[NFR-SEC-12] the token never appears in a log record, an error frame or a hello.ok', async () => {
    const host = await boot()
    const seen: FrameClient[] = []

    // A valid session that is refused once and calls outside its scope.
    const ui = await authenticated(host)
    seen.push(ui)
    for (const canary of CANARY_CORPUS) {
      // Corpus values as client-chosen method names and params: never logged, never echoed.
      await call(ui, '1', canary.value, { text: canary.value })
      await call(ui, '2', 'preferences.get', { text: canary.value, extra: canary.value })
    }
    const notifier = await authenticated(host, 'notifier')
    seen.push(notifier)
    await call(notifier, '3', 'host.shutdown', { mode: canary(0) })
    // Refused hellos carrying the corpus as a token, a view id and a client field.
    for (const value of CANARY_CORPUS.map((entry) => entry.value)) {
      for (const frame of [
        hello(value),
        hello(host.token, { role: 'viewer', viewId: value }),
        hello(value, { client: { appVersion: value, buildId: value, pid: 1 } })
      ]) {
        const client = host.connect()
        seen.push(client)
        client.send(frame)
        await client.settle()
      }
    }
    host.clock.advance(HELLO_TIMEOUT_MS)

    const logged = JSON.stringify(host.log.entries)
    const sent = JSON.stringify(seen.map((client) => client.frames))
    for (const forbidden of [host.token, ...CANARY_CORPUS.map((entry) => entry.value)]) {
      expect(logged.includes(JSON.stringify(forbidden).slice(1, -1)), forbidden).toBe(false)
      expect(sent.includes(JSON.stringify(forbidden).slice(1, -1)), forbidden).toBe(false)
    }
    // Nor in this process's argv or environment.
    expect(process.argv.some((arg) => arg.includes(host.token))).toBe(false)
    expect(Object.values(process.env).some((value) => value?.includes(host.token))).toBe(false)
  })

  it("[ADR-003] the token rotates on every boot; the previous boot's token is refused", async () => {
    const dir = runDir()
    const first = await boot(dir)
    const second = await boot(dir)
    expect(second.token).not.toBe(first.token)

    const stale = second.connect()
    stale.send(hello(first.token))
    await stale.settle()
    expect(stale.frames).toEqual([{ type: 'error', code: 'AUTH_FAILED' }])
    expect(stale.closed).toBe(true)

    const fresh = second.connect()
    fresh.send(hello(second.token))
    await fresh.settle()
    expect(fresh.frames[0]).toMatchObject({ type: 'hello.ok' })
  })
})

function canary(index: number): string {
  return CANARY_CORPUS[index]?.value ?? 'canary'
}
