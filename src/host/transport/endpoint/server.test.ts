import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostEndpoint } from '@dwarfai/contracts'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { NodeScheduler } from '../../platform/clock/NodeScheduler'
import { decideBind } from '../../wiring/singleInstance'
import {
  bindEndpoint,
  EndpointBindError,
  type BoundEndpoint,
  type EndpointServerDeps
} from './server'

// L6 (17 §1.6), in process: the real endpoint server on this OS's real transport — a named pipe on
// Windows, a Unix socket in a temp directory elsewhere. The POSIX-only cases run on the macOS and
// Linux legs of `pnpm test`; their mode checks are the L8 server.os.test.ts.

const WINDOWS = process.platform === 'win32'

/** How long a connection is watched for a byte the Host must not send. */
const SILENCE_MS = 300

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
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-022-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'run')
  return { kind: 'unix-socket', dir, path: join(dir, 'host-0123456789ab.sock') }
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

/** Everything the socket receives in `ms`, and whether it was closed meanwhile. */
function watch(socket: Socket, ms: number): Promise<{ bytes: number; closed: boolean }> {
  return new Promise((resolve) => {
    let bytes = 0
    let closed = false
    socket.on('data', (chunk: Buffer) => (bytes += chunk.length))
    socket.once('close', () => (closed = true))
    setTimeout(() => resolve({ bytes, closed }), ms)
  })
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
}

describe('the Host UI endpoint server (ADR-003 items 1–2, ADR-002 D3)', () => {
  it('[ADR-003, C-11] an accepted connection receives no byte before authentication', async () => {
    const endpoint = testEndpoint()
    const server = await bound(endpoint)

    const socket = await client(endpoint.path)
    const seen = await watch(socket, SILENCE_MS)

    expect(seen).toEqual({ bytes: 0, closed: false })
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
    await bound(endpoint)
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
    expect(await watch(socket, 50)).toEqual({ bytes: 0, closed: false })
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
    const seen = watch(socket, SILENCE_MS)

    await outcome.endpoint.close()

    expect((await seen).closed).toBe(true)
    await expect(client(endpoint.path)).rejects.toMatchObject({ code: expect.any(String) })
    if (!WINDOWS) expect(existsSync(endpoint.path)).toBe(false)
  })

  it.runIf(!WINDOWS)(
    '[FM-037] a stale socket file with no listener is removed and the bind succeeds once',
    async () => {
      const endpoint = testEndpoint()
      if (endpoint.kind !== 'unix-socket') throw new Error('POSIX only')
      mkdirSync(endpoint.dir, { recursive: true, mode: 0o700 })
      // A socket file whose listener is gone: bound under another name, renamed into place, then
      // closed (the close removes only the old name), as a crashed Host leaves it.
      const decoy = createServer()
      const decoyPath = join(endpoint.dir, 'decoy.sock')
      await listen(decoy, decoyPath)
      renameSync(decoyPath, endpoint.path)
      await new Promise<void>((resolve) => decoy.close(() => resolve()))
      expect(lstatSync(endpoint.path).isSocket()).toBe(true)
      const d = deps()

      await bound(endpoint, d)

      expect(d.log.byEvent('host.endpoint.stale-removed')).toEqual([
        expect.objectContaining({ level: 'info', subsystem: 'host' })
      ])
      const socket = await client(endpoint.path)
      expect(await watch(socket, 50)).toEqual({ bytes: 0, closed: false })
    }
  )

  it.runIf(!WINDOWS)(
    '[ADR-003, FM-037] a file at the socket path that is not a socket is never removed',
    async () => {
      const endpoint = testEndpoint()
      if (endpoint.kind !== 'unix-socket') throw new Error('POSIX only')
      mkdirSync(endpoint.path, { recursive: true })

      const error = await bindEndpoint(endpoint, deps()).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: 'ENDPOINT_IN_USE_WITHOUT_HELLO' })
      expect(lstatSync(endpoint.path).isDirectory()).toBe(true)
    }
  )

  it.runIf(WINDOWS)(
    '[ADR-003, FM-036] until the SP-05 pipe helper exists the default pipe DACL is never silent: the bind logs it as degraded',
    async () => {
      const d = deps()

      await bound(testEndpoint(), d)

      expect(d.log.byEvent('host.endpoint.acl')).toEqual([
        expect.objectContaining({
          level: 'warn',
          subsystem: 'host',
          outcome: 'degraded',
          causeClass: 'sp05-helper-pending'
        })
      ])
    }
  )
})
