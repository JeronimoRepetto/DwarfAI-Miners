// L2 (17 §1.2): the `dwarfai-mcp` relay (ADR-013 items 2–3; 16 §5.2 items 2–4; 15 §4 relay form)
// over an in-process duplex standing for the MCP endpoint, a credential file in memory and a fake
// stdio pair. No process, no socket, no timer.
// TC-200-02: McpHello is the relay's first frame and every later message crosses unchanged, one per
// frame (ADR-013). TC-200-03: a revoked credential or a missing file makes it exit non-zero and the
// provider sees the tool fail (FM-039). The credential travels only in McpHello: never on stdout,
// never in a log line (C-16); the launchId is the credential file's name (C-15).
import { join, sep } from 'node:path'
import { duplexPair, PassThrough, type Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder } from '../../../../../../contracts/host-protocol/frameCodec'
import { PROTOCOL_VERSION } from '../../../../../../contracts/host-protocol/protocolVersion'
import { runRelay, type RelayDeps } from './relayMain'

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01'
const CREDENTIAL = '3f'.repeat(32)
const ROOT = sep === '\\' ? 'C:\\' : '/'
const APP_DATA = join(ROOT, 'data', 'DwarfAI-Miners')
const HOST_DATA_DIR = join(APP_DATA, 'host')
const CREDENTIAL_PATH = join(HOST_DATA_DIR, 'run', 'mcp', `${LAUNCH}.cred`)
const ENDPOINT = '\\\\.\\pipe\\dwarfai-mcp-0123456789abcdef-0123456789ab'
const HELLO_OK = {
  type: 'hello.ok',
  hostVersion: '0.20.0',
  buildId: 'abc1234',
  protocolVersion: PROTOCOL_VERSION,
  endpointGeneration: 1,
  epoch: 'epoch-1',
  state: 'ready',
  jobStatus: 'none',
  capabilities: [],
  clientId: 'c-1'
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

interface Harness {
  deps: RelayDeps
  stdin: PassThrough
  /** Everything the relay wrote to its stdout. */
  stdout: () => string
  /** The frames the endpoint received, decoded. */
  frames: unknown[]
  /** Sends bytes from the endpoint to the relay. */
  hostWrite: (bytes: Uint8Array) => void
  hostEnd: () => void
  connects: string[]
  resolved: string[]
  logs: Array<{ dir: string; line: string }>
}

function harness(options: { files?: Map<string, string>; env?: RelayDeps['env'] } = {}): Harness {
  const files = options.files ?? new Map([[CREDENTIAL_PATH, CREDENTIAL]])
  const [relaySide, hostSide]: [Duplex, Duplex] = duplexPair()
  const frames: unknown[] = []
  const decoder = new FrameDecoder()
  hostSide.on('data', (chunk: Uint8Array) => {
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      frames.push(next.kind === 'frame' ? next.message : next)
    }
  })
  hostSide.on('error', () => {})
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let out = ''
  stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
  const connects: string[] = []
  const resolved: string[] = []
  const logs: Array<{ dir: string; line: string }> = []
  const deps: RelayDeps = {
    env: options.env ?? { DWARFAI_MCP_CREDENTIAL_FILE: CREDENTIAL_PATH },
    readCredential: (path) => {
      const text = files.get(path)
      return text === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(text)
    },
    resolveEndpoint: (hostDataDir) => {
      resolved.push(hostDataDir)
      return Promise.resolve({ ok: true, value: ENDPOINT })
    },
    connect: (path) => {
      connects.push(path)
      return Promise.resolve(relaySide)
    },
    stdin,
    stdout,
    writeLog: (dir, line) => {
      logs.push({ dir, line })
      return Promise.resolve()
    },
    now: () => new Date(Date.UTC(2026, 9, 15, 12, 0, 0)),
    pid: 4242,
    appVersion: '0.20.0'
  }
  return {
    deps,
    stdin,
    stdout: () => out,
    frames,
    hostWrite: (bytes) => hostSide.write(bytes),
    hostEnd: () => hostSide.end(),
    connects,
    resolved,
    logs
  }
}

const message = (id: number, method = 'tools/list') => ({ jsonrpc: '2.0', id, method })

describe('runRelay (ADR-013 item 3)', () => {
  it('[ADR-013] the relay sends McpHello with the launchId of the file name and the file credential before any other byte', async () => {
    const h = harness()
    // The provider writes before the relay is authenticated: nothing of it may precede the hello.
    h.stdin.write(`${JSON.stringify(message(1))}\n`)
    const exited = runRelay(h.deps)
    await flush()

    expect(h.resolved).toEqual([HOST_DATA_DIR])
    expect(h.connects).toEqual([ENDPOINT])
    expect(h.frames).toEqual([
      {
        type: 'hello',
        endpointGeneration: 1,
        protocolVersion: PROTOCOL_VERSION,
        role: 'mcp',
        launchId: LAUNCH,
        credential: CREDENTIAL
      }
    ])

    h.hostWrite(encodeFrame(HELLO_OK))
    await flush()
    expect(h.frames.slice(1)).toEqual([message(1)])
    expect(h.stdout()).toBe('')

    h.stdin.end()
    expect(await exited).toBe(0)
    expect(h.stdout()).not.toContain(CREDENTIAL)
    expect(h.logs).toEqual([])
  })

  it('[ADR-013] each stdio line becomes one frame and each frame one stdio line, split and coalesced chunks included', async () => {
    const h = harness()
    const exited = runRelay(h.deps)
    await flush()
    h.hostWrite(encodeFrame(HELLO_OK))
    await flush()

    // Two lines in two chunks, the second line split; a multi-byte character split across chunks.
    const text = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { task: 'Grüße ✓' } }
    h.stdin.write(`${JSON.stringify(message(1))}\n{"jsonrpc":"2.0",`)
    h.stdin.write(`"id":2,"method":"b"}\r\n\n`)
    const bytes = Buffer.from(`${JSON.stringify(text)}\n`, 'utf8')
    const cut = bytes.indexOf(Buffer.from('ü', 'utf8')) + 1
    h.stdin.write(bytes.subarray(0, cut))
    h.stdin.write(bytes.subarray(cut))
    await flush()
    expect(h.frames.slice(1)).toEqual([message(1), { jsonrpc: '2.0', id: 2, method: 'b' }, text])

    // Two frames coalesced in one chunk, then one frame split in two chunks.
    const answers = [
      { jsonrpc: '2.0', id: 1, result: { tools: [] } },
      { jsonrpc: '2.0', id: 2, result: {} },
      { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Grüße ✓' }] } }
    ]
    h.hostWrite(Buffer.concat([encodeFrame(answers[0]), encodeFrame(answers[1])]))
    const third = encodeFrame(answers[2])
    h.hostWrite(third.subarray(0, 7))
    h.hostWrite(third.subarray(7))
    await flush()
    expect(h.stdout().split('\n')).toEqual([...answers.map((a) => JSON.stringify(a)), ''])

    h.stdin.end()
    expect(await exited).toBe(0)
  })

  it('[FM-039] an AUTH_FAILED answer or a missing file makes the relay exit non-zero without writing to stdout', async () => {
    const refused = harness()
    refused.stdin.write(`${JSON.stringify(message(1))}\n`)
    const exited = runRelay(refused.deps)
    await flush()
    refused.hostWrite(encodeFrame({ type: 'error', code: 'AUTH_FAILED' }))
    refused.hostEnd()

    expect(await exited).not.toBe(0)
    expect(refused.stdout()).toBe('')
    expect(refused.frames).toHaveLength(1)
    expect(refused.logs).toHaveLength(1)
    expect(refused.logs[0]?.dir).toBe(join(APP_DATA, 'logs'))
    expect(JSON.parse(refused.logs[0]?.line ?? '')).toEqual({
      ts: '2026-10-15T12:00:00.000Z',
      level: 'error',
      proc: 'shim',
      pid: 4242,
      appVersion: '0.20.0',
      event: 'mcp.relay.failed',
      subsystem: 'mcp-relay',
      outcome: 'failed',
      causeClass: 'AUTH_FAILED',
      launchId: LAUNCH,
      role: 'mcp'
    })

    const missing = harness({ files: new Map() })
    expect(await runRelay(missing.deps)).not.toBe(0)
    expect(missing.stdout()).toBe('')
    expect(missing.connects).toEqual([])
    expect(missing.logs.map((log) => JSON.parse(log.line).causeClass)).toEqual([
      'credential-unreadable'
    ])
    for (const log of [...refused.logs, ...missing.logs]) {
      expect(log.line).not.toContain(CREDENTIAL)
    }
  })

  it('[ADR-013] an endpoint the relay cannot reach makes it exit non-zero with an allowlisted diagnostic and no credential', async () => {
    const h = harness()
    h.deps = {
      ...h.deps,
      connect: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    }
    expect(await runRelay(h.deps)).not.toBe(0)
    expect(h.stdout()).toBe('')
    expect(h.logs.map((log) => JSON.parse(log.line).causeClass)).toEqual(['endpoint-unreachable'])
    expect(h.logs[0]?.line).not.toContain(CREDENTIAL)
  })

  it('[C-15] a credential path that is not <hostDataDir>/run/mcp/<launchId>.cred, or none, is refused before any read or connection', async () => {
    const elsewhere = join(HOST_DATA_DIR, 'run', 'other', `${LAUNCH}.cred`)
    const misnamed = join(HOST_DATA_DIR, 'run', 'mcp', 'launch.cred')
    for (const env of [
      { DWARFAI_MCP_CREDENTIAL_FILE: elsewhere },
      { DWARFAI_MCP_CREDENTIAL_FILE: misnamed },
      { DWARFAI_MCP_CREDENTIAL_FILE: CREDENTIAL },
      {}
    ]) {
      const h = harness({
        env,
        files: new Map([
          [elsewhere, CREDENTIAL],
          [misnamed, CREDENTIAL]
        ])
      })
      expect(await runRelay(h.deps), JSON.stringify(env)).not.toBe(0)
      expect(h.connects).toEqual([])
      expect(h.stdout()).toBe('')
    }
  })
})
