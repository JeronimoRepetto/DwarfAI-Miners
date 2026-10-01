// L8 OS lane (17 §1.8): the clean exit over this OS's real UI endpoint — a named pipe on Windows, a
// Unix socket elsewhere (ADR-002 D7: close sockets, remove the POSIX socket file; S12.17). Runs
// only in `pnpm test:os`.
//
// The process exit itself is the composition root's (host/main.ts binds `exit` to process.exit
// after the log flush); here `exit` is recorded, and the case proves it is called with 0 once the
// endpoint is released.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSocketPathLength, PROTOCOL_VERSION, type HostEndpoint } from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { NodeScheduler } from '../../platform/clock/NodeScheduler'
import { createNativeOwnerOnlyPipe } from '../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { decideBind } from '../../wiring/singleInstance'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { bindEndpoint, type BoundEndpoint } from '../endpoint/server'
import { FrameClient } from '../testing/frameClient'
import { createCleanExit } from './cleanExit'
import { HostStateHolder } from './hostState'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { HelloThrottle } from '../auth/throttle'

const WINDOWS = process.platform === 'win32'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh folder; on POSIX directly under /tmp so the socket path fits `sun_path` on macOS. */
function caseRoot(): string {
  const root = WINDOWS ? mkdtempSync(join(tmpdir(), 'dwarfai-028-os-')) : mkdtempSync('/tmp/dw028-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function endpointUnder(root: string): HostEndpoint {
  if (WINDOWS) {
    const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    return { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-test-028-${suffix}` }
  }
  const dir = join(root, 'run')
  const path = join(dir, 'host-0123456789ab.sock')
  const fits = checkSocketPathLength(process.platform === 'darwin' ? 'darwin' : 'linux', path)
  if (!fits.ok) throw new Error(`test socket path too long for this OS: ${JSON.stringify(fits)}`)
  return { kind: 'unix-socket', dir, path }
}

const scheduler = (): NodeScheduler => new NodeScheduler({ onTaskError: () => {} })

/** Binds `endpoint` with the auth layer attaching each connection to `connections`. */
async function bind(endpoint: HostEndpoint, connections: ConnectionRegistry, runDir: string) {
  const clock = new FakeClock(1_000)
  const log = new RecordingDiagnosticsLog()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: WINDOWS ? 'none' : 'n/a' })
  const token = new UiToken()
  const outcome = await bindEndpoint(endpoint, {
    log,
    scheduler: scheduler(),
    decide: decideBind,
    probeExisting: () => Promise.resolve('no-hello'),
    // AMENDED for the ISSUE-022 Windows half (was: no helper): a named pipe is created only by
    // the native owner-only pipe helper (built by `pnpm build:native`); a Unix socket ignores it.
    ownerOnlyPipe: createNativeOwnerOnlyPipe({
      prebuildsDir: fileURLToPath(new URL('../../../../prebuilds', import.meta.url))
    }),
    accept: (connection) =>
      acceptConnection(connection, {
        token,
        ids: new SequenceIdGenerator(),
        identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
        epoch: 'epoch-028',
        state: () => state.current(),
        capabilities: () => [],
        scheduler: scheduler(),
        clock,
        log,
        dispatcher: new Dispatcher({
          log,
          clock,
          scheduler: new FakeScheduler(clock),
          state: () => state.current().state
        }),
        connections,
        throttle: new HelloThrottle(clock)
      })
  })
  if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
  await token.issue(runDir)
  return { endpoint: outcome.endpoint, token: readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8') }
}

/** Connects with `role` over the real endpoint and waits for hello.ok. */
async function attach(path: string, token: string, role: 'ui' | 'notifier'): Promise<FrameClient> {
  const socket = connect(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  cleanups.push(() => void socket.destroy())
  const client = new FrameClient(socket)
  client.send({
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role,
    token,
    client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
  })
  await client.until(() => client.frames.length > 0)
  expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
  return client
}

/** One bound Host with a ui and a notifier attached, and its clean exit. */
async function hostWithClients() {
  const root = caseRoot()
  const endpoint = endpointUnder(root)
  const connections = new ConnectionRegistry()
  const bound = await bind(endpoint, connections, join(root, 'run'))
  cleanups.push(() => bound.endpoint.close())
  const ui = await attach(endpoint.path, bound.token, 'ui')
  const notifier = await attach(endpoint.path, bound.token, 'notifier')
  const exits: number[] = []
  const cleanExit = createCleanExit({
    checkpoint: new RecordingShutdownCheckpoint(),
    connections,
    endpoint: bound.endpoint,
    scheduler: scheduler(),
    log: new RecordingDiagnosticsLog(),
    exit: (code) => exits.push(code)
  })
  return { root, endpoint, connections, ui, notifier, exits, cleanExit, bound: bound.endpoint }
}

/** Both clients took host.closing and saw their connection close. */
async function expectClosedCleanly(clients: FrameClient[], reason: string): Promise<void> {
  for (const client of clients) {
    await client.until(() => client.closed)
    expect(client.frames.slice(1)).toEqual([
      expect.objectContaining({ type: 'evt', name: 'host.closing', data: { reason, clean: true } })
    ])
  }
}

describe.runIf(!WINDOWS)('the clean exit on POSIX', () => {
  it('[ADR-002] a clean exit removes the POSIX socket file and the process exits 0', async () => {
    const host = await hostWithClients()
    expect(existsSync(host.endpoint.path)).toBe(true)

    await host.cleanExit.closeCleanly('stop-all')

    await expectClosedCleanly([host.ui, host.notifier], 'stop-all')
    expect(existsSync(host.endpoint.path)).toBe(false)
    expect(host.bound.heldConnections).toBe(0)
    expect(host.exits).toEqual([0])
  })
})

describe.runIf(WINDOWS)('the clean exit on Windows', () => {
  it('[ADR-002] a clean exit releases the pipe name so a new Host can bind it', async () => {
    const host = await hostWithClients()

    await host.cleanExit.closeCleanly('os-session-end')

    await expectClosedCleanly([host.ui, host.notifier], 'os-session-end')
    expect(host.exits).toEqual([0])
    // A new Host binds the same pipe name: nothing of the old one holds it.
    const next: BoundEndpoint = (
      await bind(host.endpoint, new ConnectionRegistry(), join(host.root, 'run-next'))
    ).endpoint
    cleanups.push(() => next.close())
    expect(next.address()).toBe(host.endpoint.path)
  })
})
