// L2 (17 §1.2): the `dwarfai-mcp` relay (ADR-013 items 2–3; 16 §5.2 items 2–4; 15 §4 relay form)
// over an in-process duplex standing for the MCP endpoint, a credential file in memory and a fake
// stdio pair. No process, no socket, no real timer (the hello.ok wait runs on a FakeScheduler).
// TC-200-02: McpHello is the relay's first frame and every later message crosses unchanged, one per
// frame (ADR-013). TC-200-03: a revoked credential or a missing file makes it exit non-zero and the
// provider sees the tool fail (FM-039). The credential travels only in McpHello: never on stdout,
// never in a log line (C-16); the launchId is the credential file's name (C-15).
import { join, sep } from 'node:path'
import { duplexPair, PassThrough, Writable, type Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  FRAME_CAP_AFTER_HELLO_OK,
  FrameDecoder
} from '../../../../../../contracts/host-protocol/frameCodec'
import { PROTOCOL_VERSION } from '../../../../../../contracts/host-protocol/protocolVersion'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { CREDENTIAL_FILE_VARIABLE } from './relayEntry'
import { HELLO_OK_WAIT_MS, MAX_CREDENTIAL_FILE_BYTES, runRelay, type RelayDeps } from './relayMain'

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
  /** The same frames' JSON bodies, byte for byte. */
  bodies: Buffer[]
  /** The relay's end of the connection. */
  relaySide: Duplex
  hostSide: Duplex
  clock: FakeClock
  /** The byte limits the credential was read with. */
  readLimits: number[]
  /** Sends bytes from the endpoint to the relay. */
  hostWrite: (bytes: Uint8Array) => void
  hostEnd: () => void
  connects: string[]
  resolved: string[]
  logs: Array<{ dir: string; line: string }>
}

function harness(
  options: { files?: Map<string, string>; env?: RelayDeps['env']; stdout?: Writable } = {}
): Harness {
  const files = options.files ?? new Map([[CREDENTIAL_PATH, CREDENTIAL]])
  const [relaySide, hostSide]: [Duplex, Duplex] = duplexPair()
  const frames: unknown[] = []
  const bodies: Buffer[] = []
  const decoder = new FrameDecoder()
  let raw = Buffer.alloc(0)
  hostSide.on('data', (chunk: Buffer) => {
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      frames.push(next.kind === 'frame' ? next.message : next)
    }
    raw = Buffer.concat([raw, chunk])
    while (raw.length >= 4 && raw.length >= 4 + raw.readUInt32LE(0)) {
      const length = raw.readUInt32LE(0)
      bodies.push(raw.subarray(4, 4 + length))
      raw = raw.subarray(4 + length)
    }
  })
  hostSide.on('error', () => {})
  const stdin = new PassThrough()
  let out = ''
  const stdout = options.stdout ?? new PassThrough()
  if (options.stdout === undefined) {
    stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
  }
  const clock = new FakeClock(1_000)
  const readLimits: number[] = []
  const connects: string[] = []
  const resolved: string[] = []
  const logs: Array<{ dir: string; line: string }> = []
  const deps: RelayDeps = {
    env: options.env ?? { [CREDENTIAL_FILE_VARIABLE]: CREDENTIAL_PATH },
    readCredential: (path, maxBytes) => {
      readLimits.push(maxBytes)
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
    appVersion: '0.20.0',
    scheduler: new FakeScheduler(clock)
  }
  return {
    deps,
    stdin,
    stdout: () => out,
    frames,
    bodies,
    relaySide,
    hostSide,
    clock,
    readLimits,
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

  it('[ADR-013] messages cross byte for byte: an id above 2^53, 1.0, a batch array and odd spacing keep their exact bytes both ways', async () => {
    const h = harness()
    const exited = runRelay(h.deps)
    await flush()
    h.hostWrite(encodeFrame(HELLO_OK))
    await flush()

    const lines = [
      '{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":1.0,"method":"ping"}',
      '[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]',
      '{ "jsonrpc" : "2.0", "id" : 7 , "method":"spaced", "params":{"text":"Grüße \\u2713"} }'
    ]
    for (const line of lines) h.stdin.write(`${line}\n`)
    await flush()
    expect(h.bodies.slice(1).map((body) => body.toString('utf8'))).toEqual(lines)

    for (const line of lines) h.hostWrite(rawFrame(line))
    await flush()
    expect(h.stdout()).toBe(`${lines.join('\n')}\n`)

    h.stdin.end()
    expect(await exited).toBe(0)
  })

  it('[ADR-013] the Host closing the connection after hello.ok ends the relay with exit 0', async () => {
    const h = harness()
    const exited = runRelay(h.deps)
    await flush()
    h.hostWrite(encodeFrame(HELLO_OK))
    await flush()
    h.hostEnd()

    expect(await exited).toBe(0)
    expect(h.logs).toEqual([])
  })

  it('[ADR-013] stdin end flushes the last frame and ends the connection before the relay exits 0', async () => {
    const h = harness()
    const events: string[] = []
    h.hostSide.on('data', () => events.push('data'))
    h.hostSide.on('end', () => events.push('end'))
    const exited = runRelay(h.deps)
    await flush()
    h.hostWrite(encodeFrame(HELLO_OK))
    await flush()
    events.length = 0
    h.stdin.end(`${JSON.stringify(message(9))}\n`)

    expect(await exited).toBe(0)
    await flush()
    expect(h.frames.slice(1)).toEqual([message(9)])
    expect(events[0]).toBe('data')
    expect(events.at(-1)).toBe('end')
    expect(h.relaySide.writableFinished).toBe(true)
  })

  it('[ADR-013] an oversize or malformed frame from the Host, a stdin line that is not a JSON-RPC object or batch, or a stdin line over the frame cap ends the relay non-zero', async () => {
    const cases: Array<[string, (h: Harness) => void]> = [
      ['frame-oversize', (h) => h.hostWrite(prefix(FRAME_CAP_AFTER_HELLO_OK + 1))],
      ['frame-malformed', (h) => h.hostWrite(rawFrame('{"jsonrpc":"2.0",\n"id":1}'))],
      ['frame-malformed', (h) => h.hostWrite(rawFrame('{"jsonrpc":'))],
      ['frame-unexpected', (h) => h.hostWrite(rawFrame('42'))],
      ['stdio-malformed', (h) => h.stdin.write('not json\n')],
      ['stdio-malformed', (h) => h.stdin.write('42\n')],
      ['frame-oversize', (h) => h.stdin.write(Buffer.alloc(FRAME_CAP_AFTER_HELLO_OK + 1, 0x61))]
    ]
    for (const [cause, act] of cases) {
      const h = harness()
      const exited = runRelay(h.deps)
      await flush()
      h.hostWrite(encodeFrame(HELLO_OK))
      await flush()
      act(h)

      expect(await exited, cause).not.toBe(0)
      expect(h.stdout(), cause).toBe('')
      expect(
        h.logs.map((log) => JSON.parse(log.line).causeClass),
        cause
      ).toEqual([cause])
    }
  })

  it('[ADR-013] a connection error after hello.ok, or a stdout that fails (EPIPE), ends the relay non-zero with its cause logged', async () => {
    const reset = harness()
    const exited = runRelay(reset.deps)
    await flush()
    reset.hostWrite(encodeFrame(HELLO_OK))
    await flush()
    reset.relaySide.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    expect(await exited).not.toBe(0)
    expect(JSON.parse(reset.logs[0]?.line ?? '')).toMatchObject({
      causeClass: 'endpoint-error',
      errCode: 'ECONNRESET'
    })

    const broken = new Writable({
      write: (_chunk, _encoding, done) =>
        done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    })
    const epipe = harness({ stdout: broken })
    const ended = runRelay(epipe.deps)
    await flush()
    epipe.hostWrite(encodeFrame(HELLO_OK))
    epipe.hostWrite(encodeFrame(message(1)))
    expect(await ended).not.toBe(0)
    expect(JSON.parse(epipe.logs[0]?.line ?? '')).toMatchObject({
      causeClass: 'stdout-closed',
      errCode: 'EPIPE'
    })
  })

  it('[ADR-013] a full connection pauses stdin and a full stdout pauses the connection, each resumed on drain', async () => {
    let release: (() => void) | undefined
    const slow = new Writable({
      highWaterMark: 1,
      write: (_chunk, _encoding, done) => {
        release = () => done()
      }
    })
    const h = harness({ stdout: slow })
    const exited = runRelay(h.deps)
    await flush()
    h.hostWrite(encodeFrame(HELLO_OK))
    await flush()

    h.hostWrite(encodeFrame(message(1)))
    await flush()
    expect(h.relaySide.isPaused(), 'stdout full: the connection is paused').toBe(true)
    release?.()
    await flush()
    expect(h.relaySide.isPaused(), 'stdout drained: the connection resumes').toBe(false)

    const write = h.relaySide.write.bind(h.relaySide) as (chunk: Uint8Array) => boolean
    h.relaySide.write = ((chunk: Uint8Array) => {
      write(chunk)
      return false
    }) as typeof h.relaySide.write
    h.stdin.write(`${JSON.stringify(message(2))}\n`)
    await flush()
    expect(h.stdin.isPaused(), 'connection full: stdin is paused').toBe(true)
    h.relaySide.emit('drain')
    await flush()
    expect(h.stdin.isPaused(), 'connection drained: stdin resumes').toBe(false)

    h.stdin.end()
    expect(await exited).toBe(0)
  })

  it('[ADR-013] no hello.ok within HELLO_OK_WAIT_MS (the ADR-003 item 5 hello budget) ends the relay non-zero', async () => {
    expect(HELLO_OK_WAIT_MS).toBe(5_000)
    const h = harness()
    let settled = false
    const exited = runRelay(h.deps).then((code) => {
      settled = true
      return code
    })
    await flush()
    h.clock.advance(HELLO_OK_WAIT_MS - 1)
    await flush()
    expect(settled).toBe(false)
    h.clock.advance(1)

    expect(await exited).not.toBe(0)
    expect(h.stdout()).toBe('')
    expect(h.logs.map((log) => JSON.parse(log.line).causeClass)).toEqual(['hello-timeout'])
  })

  it('[C-16] the credential file is read with a byte cap, and a file that is not exactly one credential is refused before any connection', async () => {
    expect(MAX_CREDENTIAL_FILE_BYTES).toBe(256)
    const h = harness({
      files: new Map([[CREDENTIAL_PATH, `${CREDENTIAL}${'0'.repeat(300)}`]])
    })
    expect(await runRelay(h.deps)).not.toBe(0)
    expect(h.readLimits).toEqual([MAX_CREDENTIAL_FILE_BYTES])
    expect(h.connects).toEqual([])
    expect(h.logs.map((log) => JSON.parse(log.line).causeClass)).toEqual(['credential-invalid'])
  })
})

/** A frame whose JSON body is exactly `body` (ADR-003 item 4: uint32 LE length + UTF-8). */
function rawFrame(body: string): Buffer {
  const bytes = Buffer.from(body, 'utf8')
  return Buffer.concat([prefix(bytes.length), bytes])
}

function prefix(length: number): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(length, 0)
  return head
}
