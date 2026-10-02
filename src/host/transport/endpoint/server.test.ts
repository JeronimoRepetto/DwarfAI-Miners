import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSocketPathLength, type HostEndpoint } from '@dwarfai/contracts'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { NodeScheduler } from '../../platform/clock/NodeScheduler'
import { decideBind } from '../../wiring/singleInstance'
import { createFakeOwnerOnlyPipe } from './fakes/FakeOwnerOnlyPipe'
import {
  bindEndpoint,
  EndpointBindError,
  type BoundEndpoint,
  type EndpointServerDeps
} from './server'
import { PIPE_ACL_UNAVAILABLE } from './windowsPipeSecurity'

// L6 (17 §1.6), in process: the real endpoint server on this OS's real transport — a named pipe on
// Windows, a Unix socket in a temp directory elsewhere. The cases that run on one platform only, and
// the mode checks, are the L8 server.os.test.ts.

const WINDOWS = process.platform === 'win32'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let pipeCounter = 0

/** A fresh endpoint of this OS's kind, removed after the test. */
function testEndpoint(): HostEndpoint {
  if (WINDOWS) {
    pipeCounter += 1
    const suffix = `${process.pid}-${pipeCounter}-${Math.random().toString(16).slice(2, 10)}`
    return { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-test-022-${suffix}` }
  }
  // Directly under /tmp: the socket path must fit `sun_path` (104 bytes on macOS), and the macOS
  // runner's os.tmpdir() (`/var/folders/<2>/<30>/T`) leaves too little room for it.
  const root = mkdtempSync('/tmp/dw022-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'run')
  const path = join(dir, 'host-0123456789ab.sock')
  const fits = checkSocketPathLength(process.platform === 'darwin' ? 'darwin' : 'linux', path)
  if (!fits.ok) throw new Error(`test socket path too long for this OS: ${JSON.stringify(fits)}`)
  return { kind: 'unix-socket', dir, path }
}

function deps(overrides: Partial<EndpointServerDeps> = {}): EndpointServerDeps & {
  log: RecordingDiagnosticsLog
} {
  return {
    log: new RecordingDiagnosticsLog(),
    scheduler: new NodeScheduler({
      onTaskError: (error) => {
        throw error
      }
    }),
    decide: decideBind,
    probeExisting: () => Promise.resolve('no-hello'),
    ownerOnlyPipe: createFakeOwnerOnlyPipe().listen,
    ...overrides
  } as EndpointServerDeps & { log: RecordingDiagnosticsLog }
}

async function bound(endpoint: HostEndpoint, d = deps()): Promise<BoundEndpoint> {
  const outcome = await bindEndpoint(endpoint, d)
  if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
  cleanups.push(() => outcome.endpoint.close())
  return outcome.endpoint
}

function client(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      cleanups.push(() => void socket.destroy())
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

// AMENDED for the cut-0 conformance audit (was: `watch(socket, ms)`, which counted the bytes a client received during a
// real-timer window of 50 or 300 ms, 17 §2.2, §5.3): silence is now read back from the endpoint's own side of the
// connection once a marker the client sent has reached it, so no clock decides the outcome.

interface AcceptLog {
  /** The endpoint's `accept`: each connection it hands to the auth layer. */
  accept: (connection: Socket) => void
  served: Socket[]
  /** Calls `listener` for every connection served so far and for each one still to come. */
  onServed: (listener: (connection: Socket) => void) => void
}

/** Every connection the endpoint hands to the auth layer (`accept`), and a hook for the ones still to come. */
function acceptLog(): AcceptLog {
  const served: Socket[] = []
  const listeners: Array<(connection: Socket) => void> = []
  return {
    served,
    accept: (connection) => {
      served.push(connection)
      for (const listener of listeners) listener(connection)
    },
    onServed: (listener) => {
      listeners.push(listener)
      for (const connection of served) listener(connection)
    }
  }
}

let markers = 0

/**
 * Whether the endpoint holds `socket` open and silent: the client sends a marker, the held connection that receives it
 * is the client's own, and what the endpoint wrote to it is read back from that connection (`bytesWritten`), along with
 * what the client received and whether it was closed.
 */
async function heldSilently(
  socket: Socket,
  log: AcceptLog
): Promise<{ written: number; received: number; closed: boolean }> {
  let received = 0
  let closed = false
  socket.on('data', (chunk: Buffer) => (received += chunk.length))
  socket.once('close', () => (closed = true))
  markers += 1
  const marker = `marker-${markers}`
  const served = new Promise<Socket>((resolve) =>
    log.onServed((connection) =>
      connection.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes(marker)) resolve(connection)
      })
    )
  )
  socket.write(marker)
  const connection = await served
  return { written: connection.bytesWritten, received, closed }
}

/** Resolves when `socket` closes. */
function closeOf(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

describe('the Host UI endpoint server (ADR-003 items 1–2, ADR-002 D3)', () => {
  it('[ADR-003, C-11] an accepted connection receives no byte before authentication', async () => {
    const endpoint = testEndpoint()
    const log = acceptLog()
    const server = await bound(endpoint, deps({ accept: log.accept }))

    const socket = await client(endpoint.path)
    const seen = await heldSilently(socket, log)

    expect(seen).toEqual({ written: 0, received: 0, closed: false })
    // Accepted and held, not refused: the auth layer (ISSUE-023) takes it from here.
    expect(server.heldConnections).toBe(1)
  })

  it('[ADR-003, NFR-SEC-06] the endpoint is never a TCP or HTTP listener', async () => {
    const endpoint = testEndpoint()
    const server = await bound(endpoint)

    // A path (pipe name or socket file), never a port.
    expect(server.address()).toBe(endpoint.path)
    expect(typeof server.address()).toBe('string')
  })

  it('[ADR-002, S12.02] a second bind on a live endpoint that answers hello reports already-running and leaves the first one serving', async () => {
    const endpoint = testEndpoint()
    const log = acceptLog()
    await bound(endpoint, deps({ accept: log.accept }))
    const probed: string[] = []

    const second = await bindEndpoint(
      endpoint,
      deps({
        probeExisting: (connection) => {
          probed.push(connection.readyState)
          return Promise.resolve('answers-hello')
        }
      })
    )

    expect(second).toEqual({ kind: 'already-running' })
    // The probe ran over a real connection to the first Host.
    expect(probed).toEqual(['open'])
    const socket = await client(endpoint.path)
    expect(await heldSilently(socket, log)).toEqual({ written: 0, received: 0, closed: false })
  })

  it('[ADR-002, FM-009] a live endpoint that does not answer hello fails the bind and nothing is removed', async () => {
    const endpoint = testEndpoint()
    await bound(endpoint)
    const d = deps()

    const error = await bindEndpoint(endpoint, d).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(EndpointBindError)
    expect(error).toMatchObject({ code: 'ENDPOINT_IN_USE_WITHOUT_HELLO' })
    if (!WINDOWS) expect(lstatSync(endpoint.path).isSocket()).toBe(true)
    expect(d.log.byEvent('host.endpoint.stale-removed')).toEqual([])
    await client(endpoint.path)
  })

  it('[FM-037] closing the endpoint ends held connections and removes the socket file', async () => {
    const endpoint = testEndpoint()
    const outcome = await bindEndpoint(endpoint, deps())
    if (outcome.kind !== 'bound') throw new Error('expected a bind')
    const socket = await client(endpoint.path)
    const closed = closeOf(socket)

    await outcome.endpoint.close()

    await expect(closed).resolves.toBeUndefined()
    await expect(client(endpoint.path)).rejects.toMatchObject({ code: expect.any(String) })
    if (!WINDOWS) expect(existsSync(endpoint.path)).toBe(false)
  })

  // MOVED for the cut-0 conformance audit to server.os.test.ts (17 §1.8: a test that runs on one platform only is an OS
  // lane test, marked by its file, not an `it.runIf` in `pnpm test`), assertions unchanged:
  // - "[FM-037] a stale socket file with no listener is removed and the bind succeeds once" (POSIX);
  // - "[ADR-003, FM-037] a file at the socket path that is not a socket is never removed" (POSIX);
  // - "[ADR-003, FM-036] a named pipe is created by the owner-only pipe helper and the bind logs no degraded ACL record"
  //   (Windows).
  // Recorded in docs/test-removals.md.

  it('[ADR-003, FM-036] a named-pipe endpoint without the owner-only pipe helper is never served: the bind fails closed', async () => {
    const endpoint: HostEndpoint = {
      kind: 'named-pipe',
      path: `\\\\.\\pipe\\dwarfai-test-022-nohelper-${process.pid}`
    }
    const d = deps({ ownerOnlyPipe: undefined })

    const error = await bindEndpoint(endpoint, d).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(EndpointBindError)
    expect(error).toMatchObject({ code: PIPE_ACL_UNAVAILABLE })
    if (WINDOWS) await expect(client(endpoint.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('[ADR-003, FM-036] a helper that cannot load fails the bind and logs why, never falling back to a default DACL pipe', async () => {
    const endpoint: HostEndpoint = {
      kind: 'named-pipe',
      path: `\\\\.\\pipe\\dwarfai-test-022-noload-${process.pid}`
    }
    const d = deps({
      ownerOnlyPipe: () =>
        Promise.resolve({ ok: false, code: PIPE_ACL_UNAVAILABLE, causeClass: 'binary-missing' })
    })

    const error = await bindEndpoint(endpoint, d).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: PIPE_ACL_UNAVAILABLE })
    expect(d.log.byEvent('host.endpoint.acl')).toEqual([
      expect.objectContaining({
        level: 'error',
        subsystem: 'host',
        outcome: 'failed',
        causeClass: 'binary-missing'
      })
    ])
    if (WINDOWS) await expect(client(endpoint.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
