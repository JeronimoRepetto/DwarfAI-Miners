// L8 OS lane (17 §1.8): the Host's MCP endpoint bound at its own per-OS path (ADR-013 item 3) with
// the real server helpers, on this OS. Runs only in `pnpm test:os`.
//
// POSIX: the socket `mcp-<profileKey>.sock` is `0600` in its `0700` run directory. Windows: the
// pipe `dwarfai-mcp-…` is created by the native owner-only pipe helper (`pnpm build:native`), and
// Windows' own access check says what another local user and remote clients would be granted (the
// SP-05 method of server.os.test.ts: synthesized principals, so no second account is needed);
// a real remote client through the SMB loopback is refused. On every OS a relay that reaches the
// endpoint receives nothing before its McpHello, and a wrong credential gets one AUTH_FAILED.
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from '@dwarfai/contracts'
import type { LaunchId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { NodeScheduler } from '../../platform/clock/NodeScheduler'
import { createNativeOwnerOnlyPipe } from '../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import {
  createPipeAccessProbe,
  type PipeAccessProbe
} from '../../platform/endpoint/win-pipe/testing/pipeAccessProbe'
import { hashOf } from '../../modules/delegation/testing/drawCredential'
import { HelloThrottle } from '../auth/throttle'
import { createMcpEndpoint } from './mcpEndpoint'
import { mcpEndpointFor } from './mcpEndpointPath'

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** The MCP endpoint of a fresh Host data dir on this OS, bound and listening. */
async function boundEndpoint() {
  // Directly under /tmp on POSIX: the socket path must fit `sun_path` (104 bytes on macOS).
  const root =
    process.platform === 'win32'
      ? mkdtempSync(join(process.env['TEMP'] ?? '.', 'dw199-'))
      : mkdtempSync('/tmp/dw199-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const hostDataDir = join(root, 'DwarfAI-test', 'host')
  const platform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const endpoint = mcpEndpointFor({
    platform,
    hostDataDir,
    // A per-run user key keeps the machine-wide pipe namespace free of collisions.
    userSid: `S-1-5-21-${randomBytes(4).readUInt32LE()}`,
    home: root,
    sha256
  })
  if (!endpoint.ok) throw new Error(`no MCP endpoint: ${JSON.stringify(endpoint.error)}`)
  const clock = new FakeClock(1_000)
  const accepted: unknown[] = []
  const mcp = createMcpEndpoint({
    endpoint: endpoint.value,
    tokens: {
      byLaunch: (id) =>
        id === LAUNCH
          ? {
              launchId: LAUNCH,
              parentDwarfId: null,
              mechanism: 'ticket-file',
              credentialHash: hashOf(randomBytes(32).toString('hex')),
              issuedAt: 1_000
            }
          : null
    },
    scheduler: new NodeScheduler({ onTaskError: () => {} }),
    log: new RecordingDiagnosticsLog(),
    ids: new SequenceIdGenerator(),
    identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    epoch: 'epoch-0001',
    state: () => ({ state: 'ready', jobStatus: 'none' }),
    throttle: new HelloThrottle(clock),
    ...(platform === 'win32'
      ? {
          ownerOnlyPipe: createNativeOwnerOnlyPipe({
            prebuildsDir: fileURLToPath(new URL('../../../../prebuilds', import.meta.url))
          })
        }
      : {})
  })
  const listening = await mcp.listen((connection) => accepted.push(connection))
  cleanups.push(() => listening.close())
  return { path: listening.endpoint.path, endpoint: endpoint.value, accepted }
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

/** Frames received in `ms` (real time is the L8 lane's, 17 §5.3), and whether it closed. */
function watch(socket: Socket, ms: number): Promise<{ frames: unknown[]; closed: boolean }> {
  return new Promise((resolve) => {
    const decoder = new FrameDecoder()
    const frames: unknown[] = []
    let closed = false
    socket.on('data', (chunk: Buffer) => {
      decoder.push(chunk)
      for (let next = decoder.next(); next !== null; next = decoder.next()) {
        frames.push(next.kind === 'frame' ? next.message : next)
      }
    })
    socket.once('close', () => (closed = true))
    setTimeout(() => resolve({ frames, closed }), ms)
  })
}

/** Nothing before the hello; one AUTH_FAILED for a credential that is not the launch's own. */
async function refusesStrangers(path: string, accepted: unknown[]): Promise<void> {
  const silent = await client(path)
  expect(await watch(silent, 100)).toEqual({ frames: [], closed: false })
  const relay = await client(path)
  const answer = watch(relay, 300)
  relay.write(
    encodeFrame({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'mcp',
      launchId: LAUNCH,
      credential: randomBytes(32).toString('hex')
    })
  )
  expect(await answer).toEqual({ frames: [{ type: 'error', code: 'AUTH_FAILED' }], closed: true })
  expect(accepted).toEqual([])
}

describe.runIf(process.platform !== 'win32')('the MCP endpoint on POSIX', () => {
  it('[ADR-013] the MCP endpoint binds at its own per-OS path and refuses a remote or other-user client', async () => {
    const { path, endpoint, accepted } = await boundEndpoint()
    if (endpoint.kind !== 'unix-socket') throw new Error('POSIX only')

    expect(path).toMatch(/\/mcp-[0-9a-f]{12}\.sock$/)
    // Another user cannot connect: the socket is owner-only and so is its directory (ADR-003
    // item 1); a Unix socket has no remote clients.
    expect((lstatSync(path).mode & 0o777).toString(8)).toBe('600')
    expect((lstatSync(endpoint.dir).mode & 0o777).toString(8)).toBe('700')
    await refusesStrangers(path, accepted)
  })
})

/** FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA (FILE_CREATE_PIPE_INSTANCE on a pipe). */
const DATA_RIGHTS = 0x7
/** GENERIC_READ | GENERIC_WRITE, what a client asks for. */
const GENERIC_READ_WRITE = 0xc0000000
const ERROR_ACCESS_DENIED = 'error 5'
const hex = (mask: number): string => `0x${(mask >>> 0).toString(16).padStart(8, '0')}`

describe.runIf(process.platform === 'win32')('the MCP endpoint on Windows', () => {
  let probe: PipeAccessProbe
  beforeAll(async () => {
    probe = await createPipeAccessProbe()
  }, 180_000)
  afterAll(() => probe?.dispose())

  it('[ADR-013] the MCP endpoint binds at its own per-OS path and refuses a remote or other-user client', async () => {
    const { path, accepted } = await boundEndpoint()

    expect(path).toMatch(/^\\\\\.\\pipe\\dwarfai-mcp-[0-9a-f]{16}-[0-9a-f]{12}$/)
    const report = await probe.check(path)
    expect(report.protectedDacl, 'the DACL is protected (nothing inherited)').toBe(true)
    expect(hex(report.granted.otherUser), 'another local user is granted nothing').toBe(hex(0))
    expect(hex(report.granted.anonymous), 'anonymous is granted nothing').toBe(hex(0))
    expect(hex(report.granted.remoteOtherUser), 'a remote client of another user').toBe(hex(0))
    expect(hex(report.granted.remoteOwner & DATA_RIGHTS), 'a remote client of the owner').toBe(
      hex(0)
    )
    const name = path.slice('\\\\.\\pipe\\'.length)
    for (const machine of ['127.0.0.1', 'localhost']) {
      expect(
        await probe.open(`\\\\${machine}\\pipe\\${name}`, GENERIC_READ_WRITE),
        `\\\\${machine}\\pipe\\…`
      ).toBe(ERROR_ACCESS_DENIED)
    }
    await refusesStrangers(path, accepted)
  }, 120_000)
})
