// L3: the console viewer process (ADR-031 item 2; ADR-003 item 12; 13 FM-040) against a scripted
// Host end of an in-process duplex pair, with its files, clock and terminal faked.
import { dirname, join, sep } from 'node:path'
import { duplexPair, PassThrough, Writable, type Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder } from '../../../../../../contracts/host-protocol/frameCodec'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { HELLO_OK_WAIT_MS, plainText, runViewer, type ViewerDeps } from './viewerMain'
import { formatViewerTokenFile } from './viewerTokenFile'

const ROOT = sep === '\\' ? 'C:\\data\\host' : '/data/host'
const VIEW = '01920000-0000-7000-9000-00000000c0de'
const DWARF_A = '01920000-0000-7000-9000-0000000000a1'
const DWARF_B = '01920000-0000-7000-9000-0000000000b1'
const TOKEN = '5e'.repeat(32)
const TOKEN_FILE = join(ROOT, 'run', 'viewers', `${VIEW}.token`)

const msg = (id: string, role: string, text: string, dwarfId = DWARF_A) => ({
  id,
  dwarfId,
  role,
  text,
  attachments: [],
  providerTime: null,
  createdAt: 1
})

/** The Host end of the viewer's connection: what it received, and a way to answer. */
class ScriptedHost {
  readonly frames: Array<Record<string, unknown>> = []
  private readonly decoder = new FrameDecoder()
  constructor(readonly end: Duplex) {
    this.decoder.helloOk()
    end.on('data', (chunk: Uint8Array) => {
      this.decoder.push(chunk)
      for (let next = this.decoder.next(); next !== null; next = this.decoder.next()) {
        if (next.kind === 'frame') this.frames.push(next.message as Record<string, unknown>)
      }
    })
  }
  send(message: unknown): void {
    this.end.write(encodeFrame(message))
  }
  requests(method?: string) {
    return this.frames.filter(
      (f) => f.type === 'req' && (method === undefined || f.method === method)
    )
  }
}

function harness(options: { file?: string | null; args?: string[]; tty?: boolean } = {}) {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const [viewerEnd, hostEnd] = duplexPair()
  const host = new ScriptedHost(hostEnd)
  const out: string[] = []
  const logs: Array<{ dir: string; line: string }> = []
  const removed: string[] = []
  const read: string[] = []
  const stdin = Object.assign(new PassThrough(), {
    isTTY: options.tty ?? false,
    rawMode: [] as boolean[],
    setRawMode(on: boolean) {
      this.rawMode.push(on)
      return this
    }
  })
  const deps: ViewerDeps = {
    args: options.args ?? [TOKEN_FILE],
    readTokenFile: (path) => {
      read.push(path)
      const file =
        options.file === undefined
          ? formatViewerTokenFile({ token: TOKEN, dwarfId: DWARF_A })
          : options.file
      return file === null ? Promise.reject(new Error('ENOENT')) : Promise.resolve(file)
    },
    removeTokenFile: (path) => {
      removed.push(path)
      return Promise.resolve()
    },
    resolveEndpoint: () => Promise.resolve({ ok: true, value: 'endpoint' }),
    connect: () => Promise.resolve(viewerEnd),
    stdin,
    stdout: new Writable({
      write(chunk: Buffer, _enc, callback) {
        out.push(chunk.toString('utf8'))
        callback()
      }
    }),
    writeLog: (dir, line) => {
      logs.push({ dir, line })
      return Promise.resolve()
    },
    now: () => new Date(clock.now()),
    pid: 777,
    appVersion: '0.21.0',
    buildId: 'abc1234',
    scheduler
  }
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r))
  }
  return {
    deps,
    host,
    out,
    logs,
    removed,
    read,
    stdin,
    clock,
    settle,
    start: () => runViewer(deps)
  }
}

describe('the console viewer', () => {
  it('[ADR-003] reads and deletes its token file before its hello, and hellos as viewer with that view and token', async () => {
    const h = harness()
    const exit = h.start()
    await h.settle()

    expect(h.read).toEqual([TOKEN_FILE])
    expect(h.removed).toEqual([TOKEN_FILE])
    expect(h.host.frames[0]).toMatchObject({
      type: 'hello',
      endpointGeneration: 1,
      role: 'viewer',
      viewId: VIEW,
      token: TOKEN,
      client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 777 }
    })
    h.host.send({ type: 'error', code: 'AUTH_FAILED' })
    expect(await exit).toBe(1)
  })

  it('[FM-040] a hello refused AUTH_FAILED ends the viewer non-zero with one shim line and never the token', async () => {
    const h = harness()
    const exit = h.start()
    await h.settle()
    h.host.send({ type: 'error', code: 'AUTH_FAILED' })

    expect(await exit).toBe(1)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]?.dir).toBe(join(dirname(ROOT), 'logs'))
    const line = JSON.parse(h.logs[0]?.line ?? '{}') as Record<string, unknown>
    expect(line).toMatchObject({
      proc: 'shim',
      event: 'viewer.attach.failed',
      subsystem: 'console-viewer',
      causeClass: 'AUTH_FAILED',
      role: 'viewer',
      dwarfId: DWARF_A
    })
    expect(h.logs[0]?.line).not.toContain(TOKEN)
    expect(h.out.join('')).toBe('')
  })

  it('[FM-040] a Host that never answers the hello ends it after the hello budget', async () => {
    const h = harness()
    const exit = h.start()
    await h.settle()
    h.clock.advance(HELLO_OK_WAIT_MS)

    expect(await exit).toBe(1)
    expect(JSON.parse(h.logs[0]?.line ?? '{}')).toMatchObject({ causeClass: 'hello-timeout' })
  })

  it('[ADR-003] a path outside run/viewers, a second argument or a malformed file is refused before any hello', async () => {
    for (const args of [
      [join(ROOT, 'run', 'mcp', `${VIEW}.token`)],
      [TOKEN_FILE, 'extra'],
      ['relative.token'],
      []
    ]) {
      const h = harness({ args })
      expect(await h.start(), JSON.stringify(args)).toBe(1)
      expect(h.read).toEqual([])
      expect(h.host.frames).toEqual([])
    }
    const bad = harness({ file: `${TOKEN}\n` })
    expect(await bad.start()).toBe(1)
    expect(bad.removed).toEqual([TOKEN_FILE])
    expect(bad.host.frames).toEqual([])
  })

  it('[US-MSG-007.AC06, ADR-031] renders its dwarf live and read-only: the page oldest first, then appended messages and tool steps of its dwarf only', async () => {
    const h = harness()
    const exit = h.start()
    await h.settle()
    h.host.send({ type: 'hello.ok' })
    await h.settle()

    expect(h.host.requests().map((r) => [r.method, r.params])).toEqual([
      ['events.subscribe', {}],
      ['conversation.feed', { dwarfId: DWARF_A }]
    ])
    const feed = h.host.requests('conversation.feed')[0]
    h.host.send({
      type: 'res',
      id: feed?.id,
      ok: true,
      result: {
        dwarfId: DWARF_A,
        reachedStart: true,
        messages: [msg('m2', 'dwarf', 'Done.'), msg('m1', 'person', 'Run the tests')]
      }
    })
    h.host.send({
      type: 'evt',
      seq: 1,
      epoch: 'e',
      name: 'conversation.appended',
      data: { dwarfId: DWARF_B, messages: [msg('b1', 'dwarf', 'not mine', DWARF_B)] }
    })
    h.host.send({
      type: 'evt',
      seq: 2,
      epoch: 'e',
      name: 'activity.changed',
      data: {
        dwarfId: DWARF_A,
        disclosureId: 'r1',
        open: true,
        stepCount: 1,
        summaries: ['Ran pnpm test']
      }
    })
    h.host.send({
      type: 'evt',
      seq: 3,
      epoch: 'e',
      name: 'conversation.appended',
      data: {
        dwarfId: DWARF_A,
        messages: [msg('m2', 'dwarf', 'Done.'), msg('m3', 'dwarf', 'All green')]
      }
    })
    await h.settle()

    expect(h.out.join('')).toBe('› Run the tests\n\nDone.\n\n  · Ran pnpm test\nAll green\n\n')
    h.host.send({
      type: 'evt',
      seq: 4,
      epoch: 'e',
      name: 'dwarf.departed',
      data: { dwarfId: DWARF_A, mineId: DWARF_B, cause: 'exited' }
    })
    expect(await exit).toBe(0)
    expect(h.logs).toEqual([])
  })

  it('[US-MSG-007.AC06, OQ-39] accepts no input: typed keys reach no Host frame, are not echoed, and Ctrl+C closes the view', async () => {
    const h = harness({ tty: true })
    const exit = h.start()
    await h.settle()
    h.host.send({ type: 'hello.ok' })
    await h.settle()
    const before = h.host.frames.length

    h.stdin.write('rm -rf /\r')
    h.stdin.write('please send this to the dwarf\n')
    await h.settle()

    expect(h.stdin.rawMode[0]).toBe(true)
    expect(h.host.frames).toHaveLength(before)
    expect(JSON.stringify(h.host.frames)).not.toContain('please send')
    h.stdin.write(Buffer.from([0x03]))
    expect(await exit).toBe(0)
    expect(h.stdin.rawMode.at(-1)).toBe(false)
  })

  it('[ADR-031] pings the Host every 5 s while it views', async () => {
    const h = harness()
    const exit = h.start()
    await h.settle()
    h.host.send({ type: 'hello.ok' })
    await h.settle()
    h.clock.advance(5_000)
    h.clock.advance(5_000)
    await h.settle()

    expect(h.host.requests('ping')).toHaveLength(2)
    h.host.end.end()
    expect(await exit).toBe(0)
  })

  it('[ADR-031] drops every control character a provider text holds, so no text can steer the terminal', () => {
    expect(plainText('ok\u001b]0;pwned\u0007 \u001b[2Jdone\r\nnext\u009b\ttab')).toBe(
      'ok]0;pwned [2Jdone\nnext\ttab'
    )
  })
})
