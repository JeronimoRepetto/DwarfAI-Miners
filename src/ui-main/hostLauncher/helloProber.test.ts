import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type HelloOk } from '@dwarfai/contracts'
import { createHelloProber, type HelloProberDeps } from './helloProber'
import { runHelloProberContract } from './testing/helloProber.contract'

const TOKEN = 'ab'.repeat(32)
const CLIENT = { appVersion: '0.20.0', buildId: 'abc1234', pid: 7 }
const HELLO_OK: HelloOk = {
  type: 'hello.ok',
  hostVersion: '0.20.0',
  buildId: 'abc1234',
  protocolVersion: PROTOCOL_VERSION,
  endpointGeneration: 1,
  epoch: 'epoch-1',
  state: 'migrating',
  jobStatus: 'none',
  capabilities: [],
  clientId: 'client-1'
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One end of an in-process connection: what it writes, its peer reads. */
class PipeEnd extends Duplex {
  peer: PipeEnd | null = null

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.peer?.push(chunk)
    done()
  }

  override _final(done: () => void): void {
    this.peer?.push(null)
    done()
  }
}

/** A connected pair: the prober's end and the Host's end. */
function pair(): { client: Duplex; host: Duplex } {
  const client = new PipeEnd()
  const host = new PipeEnd()
  client.peer = host
  host.peer = client
  return { client, host }
}

/** The first frame the Host end receives. */
function firstFrame(host: Duplex): Promise<unknown> {
  const decoder = new FrameDecoder()
  return new Promise((resolve) => {
    host.on('data', (chunk: Buffer) => {
      decoder.push(new Uint8Array(chunk))
      const frame = decoder.next()
      if (frame?.kind === 'frame') resolve(frame.message)
    })
  })
}

function tokenFile(token: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-030-probe-'))
  roots.push(root)
  const run = join(root, 'run')
  mkdirSync(run)
  const file = join(run, 'ui.token')
  if (token !== null) writeFileSync(file, `${token}\n`)
  return file
}

function prober(
  connect: HelloProberDeps['connect'],
  file: string,
  after?: HelloProberDeps['after']
) {
  return createHelloProber({
    connect,
    tokenFile: file,
    protocolVersion: PROTOCOL_VERSION,
    client: CLIENT,
    ...(after === undefined ? {} : { after })
  })
}

describe('hello prober (ADR-002 D4 item 1, ADR-003 item 5)', () => {
  it('[ADR-002, ADR-003] sends a notifier hello with the token of run/ui.token and reads the state and job status of hello.ok', async () => {
    const { client, host } = pair()
    const received = firstFrame(host)
    const answer = prober(() => Promise.resolve(client), tokenFile(TOKEN))()
    expect(await received).toEqual({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'notifier',
      token: TOKEN,
      client: CLIENT
    })
    host.write(encodeFrame(HELLO_OK))
    expect(await answer).toEqual({ kind: 'hello-ok', state: 'migrating', jobStatus: 'none' })
    expect(client.destroyed).toBe(true)
  })

  it('[ADR-002] nothing listening is unreachable', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(await prober(() => Promise.reject(refused), tokenFile(TOKEN))()).toEqual({
      kind: 'unreachable'
    })
  })

  it('[ADR-002, ADR-003] a protocol error frame is a refusal by a Host; a missing token is sent empty', async () => {
    const { client, host } = pair()
    const received = firstFrame(host)
    const answer = prober(() => Promise.resolve(client), tokenFile(null))()
    expect(await received).toMatchObject({ token: '' })
    host.write(encodeFrame({ type: 'error', code: 'AUTH_FAILED' }))
    expect(await answer).toEqual({ kind: 'refused', code: 'AUTH_FAILED' })
  })

  it('[ADR-002, FM-008] a close, a frame that is no seam-B answer, or silence is no answer', async () => {
    const closed = pair()
    const closedAnswer = prober(() => Promise.resolve(closed.client), tokenFile(TOKEN))()
    await firstFrame(closed.host)
    closed.host.end()
    closed.client.destroy()
    expect(await closedAnswer).toEqual({ kind: 'no-answer' })

    const odd = pair()
    const oddAnswer = prober(() => Promise.resolve(odd.client), tokenFile(TOKEN))()
    await firstFrame(odd.host)
    odd.host.write(encodeFrame({ type: 'hello.ok', state: 'ready' }))
    expect(await oddAnswer).toEqual({ kind: 'no-answer' })

    const silent = pair()
    const timers: Array<() => void> = []
    const silentAnswer = prober(
      () => Promise.resolve(silent.client),
      tokenFile(TOKEN),
      (_ms, run) => {
        timers.push(run)
        return () => {}
      }
    )()
    await firstFrame(silent.host)
    timers.forEach((run) => run())
    expect(await silentAnswer).toEqual({ kind: 'no-answer' })
  })
})

// L3: the real prober over an in-process connection whose far end plays the endpoint's script; its timer is the
// injected `after`, so the hello bound passes with no real time (the real pipe or socket is detach.os.test.ts's).
runHelloProberContract('createHelloProber over an in-process connection', (endpoint) => {
  const timers: Array<() => void> = []
  const connect = (): Promise<Duplex> => {
    if (endpoint.kind === 'nothing-listens') {
      return Promise.reject(Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }))
    }
    const { client, host } = pair()
    void firstFrame(host).then(() => {
      if (endpoint.kind === 'hello-ok') {
        host.write(
          encodeFrame({ ...HELLO_OK, state: endpoint.state, jobStatus: endpoint.jobStatus })
        )
      } else if (endpoint.kind === 'error-frame') {
        host.write(encodeFrame({ type: 'error', code: endpoint.code }))
      }
    })
    return Promise.resolve(client)
  }
  // Once the bound has passed, a timer the attempt arms later (after its connect and token read) is already due.
  let boundPassed = false
  return {
    probe: prober(connect, tokenFile(TOKEN), (_ms, run) => {
      if (boundPassed) queueMicrotask(run)
      else timers.push(run)
      return () => {}
    }),
    passAnswerBound: () => {
      boundPassed = true
      for (const run of timers.splice(0)) run()
    }
  }
})
