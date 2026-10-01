// L8 OS lane (17 §1.6, §1.8): the authentication cases of hello.contract.test.ts over this OS's real
// UI endpoint — a named pipe on Windows, a Unix socket elsewhere — plus the run/ui.token mode on
// POSIX. Runs only in `pnpm test:os`.
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkSocketPathLength,
  encodeFrame,
  FRAME_CAP_AFTER_HELLO_OK,
  FRAME_CAP_BEFORE_HELLO_OK,
  helloOkSchema,
  PROTOCOL_VERSION,
  type HostEndpoint
} from '@dwarfai/contracts'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { decideBind } from '../wiring/singleInstance'
import { UI_TOKEN_FILE, UiToken } from './auth/uiToken'
import { collectCapabilities } from './capabilities'
import { acceptConnection, HELLO_TIMEOUT_MS } from './connection'
import { Dispatcher } from './dispatcher'
import { bindEndpoint } from './endpoint/server'
import { ConnectionRegistry } from './connectionRegistry'
import { HostStateHolder } from './lifecycle/hostState'
import { FrameClient } from './testing/frameClient'

const WINDOWS = process.platform === 'win32'

/** How long a real connection is watched for bytes the Host must not send. */
const SILENCE_MS = 300

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh folder; on POSIX directly under /tmp so the socket path fits `sun_path` on macOS. */
function caseRoot(): string {
  const root = WINDOWS ? mkdtempSync(join(tmpdir(), 'dwarfai-023-os-')) : mkdtempSync('/tmp/dw023-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

let pipeCounter = 0

function endpointUnder(root: string): HostEndpoint {
  if (WINDOWS) {
    pipeCounter += 1
    const suffix = `${process.pid}-${pipeCounter}-${Math.random().toString(16).slice(2, 10)}`
    return { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-test-023-${suffix}` }
  }
  const dir = join(root, 'run')
  const path = join(dir, 'host-0123456789ab.sock')
  const fits = checkSocketPathLength(process.platform === 'darwin' ? 'darwin' : 'linux', path)
  if (!fits.ok) throw new Error(`test socket path too long for this OS: ${JSON.stringify(fits)}`)
  return { kind: 'unix-socket', dir, path }
}

/** One Host: the real endpoint server with the auth layer, its token in <root>/run/ui.token. */
async function realHost() {
  const root = caseRoot()
  const endpoint = endpointUnder(root)
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: WINDOWS ? 'none' : 'n/a' })
  const dispatcher = new Dispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => state.current().state
  })
  const token = new UiToken()
  const outcome = await bindEndpoint(endpoint, {
    log,
    scheduler,
    decide: decideBind,
    probeExisting: () => Promise.resolve('no-hello'),
    accept: (connection) =>
      acceptConnection(connection, {
        token,
        ids: new SequenceIdGenerator(),
        identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
        epoch: 'epoch-os',
        state: () => state.current(),
        capabilities: () => collectCapabilities({ methods: dispatcher.methods() }),
        scheduler,
        clock,
        log,
        dispatcher,
        connections
      })
  })
  if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
  cleanups.push(() => outcome.endpoint.close())
  const runDir = join(root, 'run')
  await token.issue(runDir)
  return {
    runDir,
    clock,
    token: readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8'),
    connect: (): Promise<FrameClient> =>
      new Promise((resolve, reject) => {
        const socket = connect(endpoint.path)
        socket.once('connect', () => {
          cleanups.push(() => void socket.destroy())
          resolve(new FrameClient(socket))
        })
        socket.once('error', reject)
      })
  }
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

function header(length: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, length, true)
  return bytes
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('hello-first authentication over the real UI endpoint (ADR-003 items 2–5)', () => {
  it('[ADR-003, C-11] no byte is sent before a valid hello', async () => {
    const host = await realHost()
    const client = await host.connect()
    const frame = encodeFrame(hello(host.token))

    client.sendRaw(frame.subarray(0, frame.length - 1))
    await pause(SILENCE_MS)
    expect({ bytes: client.bytes, closed: client.closed }).toEqual({ bytes: 0, closed: false })

    client.sendRaw(frame.subarray(frame.length - 1))
    await client.until(() => client.frames.length > 0)
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
  })

  it('[ADR-003, FM-026] a bad token gets one AUTH_FAILED error frame and the connection closes', async () => {
    const host = await realHost()
    const client = await host.connect()

    client.send(hello('0'.repeat(64)))
    await client.until(() => client.closed)

    expect(client.frames).toEqual([{ type: 'error', code: 'AUTH_FAILED' }])
  })

  it('[ADR-003] a second hello gets PROTOCOL_ERROR and close; a req before hello gets PROTOCOL_ERROR and close', async () => {
    const host = await realHost()

    const twice = await host.connect()
    twice.send(hello(host.token))
    await twice.until(() => twice.frames.length === 1)
    twice.send(hello(host.token))
    await twice.until(() => twice.closed)
    expect(twice.frames.slice(1)).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])

    const early = await host.connect()
    early.send({ type: 'req', id: '1', method: 'ping', params: {} })
    await early.until(() => early.closed)
    expect(early.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])
  })

  it('[ADR-003] no hello within 5 s gets HELLO_TIMEOUT', async () => {
    const host = await realHost()
    const client = await host.connect()
    await pause(50)

    host.clock.advance(HELLO_TIMEOUT_MS)
    await client.until(() => client.closed)

    expect(client.frames).toEqual([{ type: 'error', code: 'HELLO_TIMEOUT' }])
  })

  it('[ADR-003, FM-030] an oversized frame closes the connection without a frame, before and after hello.ok', async () => {
    const host = await realHost()

    const early = await host.connect()
    early.sendRaw(header(FRAME_CAP_BEFORE_HELLO_OK + 1))
    await early.until(() => early.closed)
    expect(early.frames).toEqual([])

    const late = await host.connect()
    late.send(hello(host.token))
    await late.until(() => late.frames.length === 1)
    late.sendRaw(header(FRAME_CAP_AFTER_HELLO_OK + 1))
    await late.until(() => late.closed)
    expect(late.frames).toHaveLength(1)
  })

  it('[ADR-003] a valid ui hello gets hello.ok with epoch, state, jobStatus, capabilities and a clientId', async () => {
    const host = await realHost()
    const client = await host.connect()

    client.send(hello(host.token))
    await client.until(() => client.frames.length === 1)

    expect(helloOkSchema.parse(client.frames[0])).toMatchObject({
      epoch: 'epoch-os',
      state: 'ready',
      endpointGeneration: 1,
      capabilities: []
    })
    await pause(50)
    expect(client.closed).toBe(false)
  })

  it.runIf(!WINDOWS)('[ADR-003, NFR-SEC-05] run/ui.token is created 0600 (POSIX)', async () => {
    const host = await realHost()

    expect((lstatSync(join(host.runDir, UI_TOKEN_FILE)).mode & 0o777).toString(8)).toBe('600')
    expect((lstatSync(host.runDir).mode & 0o777).toString(8)).toBe('700')
  })
})
