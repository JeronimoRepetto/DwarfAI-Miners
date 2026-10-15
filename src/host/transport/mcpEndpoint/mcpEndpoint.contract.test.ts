// layer: L6
// L6 (17 §1.6): the real MCP endpoint transport (ADR-013 item 3; ADR-003 items 2, 4–5, 12; 16 §5.2
// as amended by owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15) behind an in-process duplex:
// the McpHello authentication, the frames after `hello.ok`, the throttle and `closeLaunch`.
// mcpEndpoint.os.test.ts binds it at its real per-OS path (L8).
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, helloOkSchema } from '@dwarfai/contracts'
import { CANARY_CORPUS } from '../../../contracts/logging/testing/canaryCorpus'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { DelegationRelayConnection, DelegationToken } from '../../modules/delegation'
import { drawCredential, hashOf } from '../../modules/delegation/testing/drawCredential'
import { HelloThrottle, THROTTLE_FAILURES } from '../auth/throttle'
import { acceptConnection, HELLO_TIMEOUT_MS } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { acceptMcpConnection, McpConnectionRegistry, type McpConnectionDeps } from './mcpEndpoint'
import { mcpEndpointFor } from './mcpEndpointPath'

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8001' as LaunchId
const OTHER_LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8002' as LaunchId
const PARENT = '01890a5d-ac96-774b-bcce-b302099a8d01' as DwarfId
const IDENTITY = { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION }

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** The token rows as the store answers them: `byLaunch` never returns a revoked row. */
class TokenRows {
  private readonly rows = new Map<LaunchId, DelegationToken & { revoked?: true }>()
  issue(launchId: LaunchId, credential: string, parent: DwarfId | null = PARENT): void {
    this.rows.set(launchId, {
      launchId,
      parentDwarfId: parent,
      mechanism: 'ticket-file',
      credentialHash: hashOf(credential),
      issuedAt: 1_000
    })
  }
  revoke(launchId: LaunchId): void {
    const row = this.rows.get(launchId)
    if (row !== undefined) this.rows.set(launchId, { ...row, revoked: true })
  }
  byLaunch(id: LaunchId): DelegationToken | null {
    const row = this.rows.get(id)
    if (row === undefined || row.revoked === true) return null
    return {
      launchId: row.launchId,
      parentDwarfId: row.parentDwarfId,
      mechanism: row.mechanism,
      ...(row.credentialHash === undefined ? {} : { credentialHash: row.credentialHash }),
      issuedAt: row.issuedAt
    }
  }
}

function setUp() {
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const tokens = new TokenRows()
  const throttle = new HelloThrottle(clock)
  const registry = new McpConnectionRegistry()
  const accepted: DelegationRelayConnection[] = []
  const compares: Array<[Uint8Array, Uint8Array]> = []
  const deps: McpConnectionDeps = {
    tokens,
    scheduler,
    log,
    ids: new SequenceIdGenerator(),
    identity: IDENTITY,
    epoch: 'epoch-0001',
    state: () => ({ state: 'ready', jobStatus: 'none' }),
    throttle,
    timingSafeEqual: (a, b) => {
      compares.push([a, b])
      return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
    }
  }
  const connect = (): FrameClient => {
    const pair = inProcessDuplex()
    acceptMcpConnection(pair.host, deps, (c) => accepted.push(c), registry)
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    return client
  }
  return { clock, log, tokens, connect, accepted, registry, compares }
}

function mcpHello(launchId: string, credential: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'mcp',
    launchId,
    credential,
    ...overrides
  }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'relay', version: '1' }
  }
}

describe('the MCP endpoint (ADR-013 item 3, 16 §5.2)', () => {
  it('[ADR-013, C-13, FM-039] a relay with a wrong launchId or a revoked credential gets one AUTH_FAILED frame and the connection closes', async () => {
    const s = setUp()
    const credential = drawCredential()
    const other = drawCredential()
    s.tokens.issue(LAUNCH, credential)
    s.tokens.issue(OTHER_LAUNCH, other)
    const revoked = drawCredential()
    const REVOKED = '01890a5d-ac96-774b-bcce-b302099a8003' as LaunchId
    s.tokens.issue(REVOKED, revoked)
    s.tokens.revoke(REVOKED)

    const cases = [
      // the credential of another launch: accepted only for its own launchId
      mcpHello(LAUNCH, other),
      // a launchId no token exists for
      mcpHello('01890a5d-ac96-774b-bcce-b302099a8009', credential),
      // a revoked credential, for its own launch
      mcpHello(REVOKED, revoked),
      // not a credential at all
      mcpHello(LAUNCH, 'not-hex')
    ]
    for (const hello of cases) {
      const client = s.connect()
      client.send(hello)
      await client.settle()
      expect(client.frames).toEqual([{ type: 'error', code: 'AUTH_FAILED' }])
      expect(client.closed).toBe(true)
    }
    expect(s.accepted).toEqual([])
    // Each refusal ran the constant-time compare (16 §5.2 (b)), the unknown and malformed ones too.
    expect(s.compares).toHaveLength(cases.length)
    const refused = s.log.byEvent('mcp.hello.refused')
    expect(refused.map((r) => r.causeClass)).toEqual(Array(cases.length).fill('AUTH_FAILED'))
    expect(refused[0]).toMatchObject({ launchId: LAUNCH, subsystem: 'delegation' })
    // NFR-SEC-12: no credential and no hash reaches a record.
    expect(s.log.refused).toEqual([])
    const logged = JSON.stringify(s.log.entries)
    for (const secret of [credential, other, revoked, hashOf(credential), hashOf(other)]) {
      expect(logged).not.toContain(secret)
    }
  })

  it('[ADR-013, C-13] the right credential for its launch gets hello.ok and the connection is bound to that launch with no hash and no credential', async () => {
    const s = setUp()
    const credential = drawCredential()
    s.tokens.issue(LAUNCH, credential)
    const client = s.connect()

    client.send(mcpHello(LAUNCH, credential))
    await client.settle()

    expect(client.frames).toHaveLength(1)
    expect(helloOkSchema.safeParse(client.frames[0]).success).toBe(true)
    expect(s.accepted.map((c) => c.token)).toEqual([
      { launchId: LAUNCH, parentDwarfId: PARENT, mechanism: 'ticket-file', issuedAt: 1_000 }
    ])
    expect(JSON.stringify(s.accepted[0]?.token)).not.toContain(hashOf(credential))
  })

  it('[ADR-003] no byte is sent before a valid McpHello; a ui hello on the MCP endpoint and an McpHello on the UI endpoint are refused', async () => {
    const s = setUp()
    const credential = drawCredential()
    s.tokens.issue(LAUNCH, credential)

    const silent = s.connect()
    await silent.settle()
    expect(silent.bytes).toBe(0)

    const ui = s.connect()
    ui.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'ui',
      token: credential,
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
    })
    await ui.settle()
    expect(ui.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])
    expect(ui.closed).toBe(true)

    // A JSON-RPC message before the hello is not a hello.
    const early = s.connect()
    early.send(INITIALIZE)
    await early.settle()
    expect(early.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])

    // The UI endpoint's own transport refuses the McpHello (ADR-003 item 12).
    const clock = new FakeClock(1_000)
    const pair = inProcessDuplex()
    cleanups.push(() => void pair.client.destroy())
    acceptConnection(pair.host, {
      token: { verify: () => true },
      ids: new SequenceIdGenerator(),
      identity: IDENTITY,
      epoch: 'epoch-0001',
      state: () => ({ state: 'ready', jobStatus: 'none' }),
      capabilities: () => [],
      scheduler: new FakeScheduler(clock),
      clock,
      log: new RecordingDiagnosticsLog(),
      dispatcher: new Dispatcher({
        log: new RecordingDiagnosticsLog(),
        clock,
        scheduler: new FakeScheduler(clock),
        state: () => 'ready'
      }),
      connections: new ConnectionRegistry(),
      throttle: new HelloThrottle(clock)
    })
    const onUi = new FrameClient(pair.client)
    onUi.send(mcpHello(LAUNCH, credential))
    await onUi.settle()
    expect(onUi.frames).toEqual([{ type: 'error', code: 'PROTOCOL_ERROR' }])

    // Nothing was accepted on the MCP endpoint, and silence ends with HELLO_TIMEOUT.
    expect(s.accepted).toEqual([])
    s.clock.advance(HELLO_TIMEOUT_MS)
    await silent.settle()
    expect(silent.frames).toEqual([{ type: 'error', code: 'HELLO_TIMEOUT' }])
  })

  it('[ADR-013] after hello.ok each frame carries exactly one MCP JSON-RPC message', async () => {
    const s = setUp()
    const credential = drawCredential()
    s.tokens.issue(LAUNCH, credential)
    const client = s.connect()
    client.send(mcpHello(LAUNCH, credential))
    await client.settle()
    const connection = s.accepted[0]
    if (connection === undefined) throw new Error('not accepted')
    const received: unknown[] = []
    connection.onMessage((m) => received.push(m))

    client.send(INITIALIZE)
    const notification = { jsonrpc: '2.0', method: 'notifications/initialized' }
    client.send(notification)
    await client.settle()
    expect(received).toEqual([INITIALIZE, notification])

    // The server's messages leave one per frame, unchanged.
    const reply = { jsonrpc: '2.0', id: 1, result: { tools: [] } }
    connection.send(reply)
    connection.send({ jsonrpc: '2.0', id: 2, result: {} })
    await client.settle()
    expect(client.frames.slice(1)).toEqual([reply, { jsonrpc: '2.0', id: 2, result: {} }])

    // A batch (two messages in one frame) is not one message: PROTOCOL_ERROR and the close.
    client.send([INITIALIZE, notification])
    await client.settle()
    expect(client.frames.at(-1)).toEqual({ type: 'error', code: 'PROTOCOL_ERROR' })
    expect(client.closed).toBe(true)
    expect(received).toHaveLength(2)
  })

  it('[ADR-013, FM-039] a revoked launch is closed: closeLaunch ends its connections without a frame, and a frame after revocation is never handed over', async () => {
    const s = setUp()
    const credential = drawCredential()
    s.tokens.issue(LAUNCH, credential)
    const first = s.connect()
    first.send(mcpHello(LAUNCH, credential))
    const second = s.connect()
    second.send(mcpHello(LAUNCH, credential))
    await first.settle()
    const closed: number[] = []
    s.accepted.forEach((c, i) => c.onClose(() => closed.push(i)))
    const received: unknown[] = []
    s.accepted[1]?.onMessage((m) => received.push(m))

    s.registry.closeLaunch(LAUNCH)
    await first.settle()
    expect(first.closed).toBe(true)
    expect(first.frames).toHaveLength(1) // hello.ok only
    expect(closed).toEqual([0, 1])
    expect(s.registry.size).toBe(0)

    // A connection whose token was revoked meanwhile hands nothing over.
    const third = s.connect()
    third.send(mcpHello(LAUNCH, credential))
    await third.settle()
    const late: unknown[] = []
    s.accepted[2]?.onMessage((m) => late.push(m))
    s.tokens.revoke(LAUNCH)
    third.send(INITIALIZE)
    await third.settle()
    expect(late).toEqual([])
    expect(third.closed).toBe(true)
    expect(received).toEqual([])
  })

  it('[ADR-003, 16 §5.2] five failed hellos within 60 s refuse new connections for 10 s with RATE_LIMITED', async () => {
    const s = setUp()
    for (let i = 0; i < THROTTLE_FAILURES; i += 1) {
      const client = s.connect()
      client.send(mcpHello(LAUNCH, drawCredential()))
      await client.settle()
    }
    const refused = s.connect()
    await refused.settle()
    expect(refused.frames).toEqual([{ type: 'error', code: 'RATE_LIMITED' }])
    expect(s.log.byEvent('channel.rate-limited')).toHaveLength(1)
  })

  it('[NFR-SEC-12] a refusal logs no frame content: a canary in the hello never reaches a record', async () => {
    const s = setUp()
    for (const canary of CANARY_CORPUS.slice(0, 3)) {
      const client = s.connect()
      client.send(mcpHello(LAUNCH, canary.value))
      await client.settle()
    }
    const logged = JSON.stringify([s.log.entries, s.log.refused])
    for (const canary of CANARY_CORPUS.slice(0, 3)) expect(logged).not.toContain(canary.value)
  })

  it('[ADR-013] the MCP endpoint path is the ADR-002 D2 pattern with mcp in place of host, per OS', () => {
    const sha256 = (text: string): string => hashOf(text) // lower-case hex SHA-256
    const win = mcpEndpointFor({
      platform: 'win32',
      hostDataDir: 'C:\\Users\\a\\AppData\\Roaming\\DwarfAI-Miners\\host',
      userSid: 'S-1-5-21-1',
      sha256
    })
    expect(win.ok && win.value.path).toMatch(
      /^\\\\\.\\pipe\\dwarfai-mcp-[0-9a-f]{16}-[0-9a-f]{12}$/
    )
    const mac = mcpEndpointFor({
      platform: 'darwin',
      hostDataDir: '/Users/a/Library/Application Support/DwarfAI-Miners/host',
      home: '/Users/a',
      sha256
    })
    expect(mac.ok && mac.value).toMatchObject({
      kind: 'unix-socket',
      dir: '/Users/a/Library/Application Support/DwarfAI-Miners/run'
    })
    expect(mac.ok && mac.value.path).toMatch(
      /^\/Users\/a\/Library\/Application Support\/DwarfAI-Miners\/run\/mcp-[0-9a-f]{12}\.sock$/
    )
    const linux = mcpEndpointFor({
      platform: 'linux',
      hostDataDir: '/home/a/.config/DwarfAI-Miners/host',
      xdgRuntimeDir: '/run/user/1000',
      sha256
    })
    expect(linux.ok && linux.value.path).toMatch(
      /^\/run\/user\/1000\/dwarfai\/mcp-[0-9a-f]{12}\.sock$/
    )
    const fallback = mcpEndpointFor({
      platform: 'linux',
      hostDataDir: '/home/a/.config/DwarfAI-Miners/host',
      sha256
    })
    expect(fallback.ok && fallback.value.path).toMatch(
      /^\/home\/a\/\.config\/DwarfAI-Miners\/host\/run\/mcp-[0-9a-f]{12}\.sock$/
    )
  })
})
