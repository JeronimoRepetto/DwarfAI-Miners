import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duplexPair, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type HelloOk } from '@dwarfai/contracts'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../host-client/testing/FakeHost'
import { ManualTimers } from '../host-client/testing/ManualTimers'
import { createHostLinkOpener } from './hostLink'

// L6 (17 §1.6): the UI side of the handshake's `ui` connection over real frames, against a scripted
// Host end of an in-memory duplex pair (ADR-003 items 5, 6, 12; 14 §3.2; ADR-002 D8).

const TOKEN = 'a'.repeat(64)

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const HELLO_OK: HelloOk = {
  type: 'hello.ok',
  hostVersion: '0.20.0',
  buildId: 'abc1234',
  protocolVersion: PROTOCOL_VERSION - 1,
  endpointGeneration: 1,
  epoch: 'epoch-032',
  state: 'ready',
  jobStatus: 'n/a',
  capabilities: ['host.shutdown', 'host.upgrade.request', 'ping'],
  clientId: 'client-1'
}

/** A scripted Host end: records every frame the UI sends and answers through `onFrame`. */
function scriptedHost(onFrame: (message: unknown, host: Duplex) => void) {
  const [ui, host] = duplexPair()
  const received: unknown[] = []
  const decoder = new FrameDecoder()
  decoder.helloOk()
  host.on('data', (chunk: Uint8Array) => {
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      if (next.kind !== 'frame') continue
      received.push(next.message)
      onFrame(next.message, host)
    }
  })
  host.on('error', () => {})
  cleanups.push(() => {
    ui.destroy()
    host.destroy()
  })
  return { ui, host, received }
}

function opener(connect: () => Promise<Duplex>) {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-032-link-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const tokenFile = join(dir, 'ui.token')
  writeFileSync(tokenFile, TOKEN)
  return createHostLinkOpener({
    connect,
    tokenFile,
    protocolVersion: PROTOCOL_VERSION,
    client: { appVersion: '0.21.0', buildId: 'def5678', pid: 4242 }
  })
}

describe('the handshake link (ADR-003 item 12; ADR-002 D8)', () => {
  it('[ADR-003] a ui hello answered hello.ok attaches a link whose request resolves with its answer', async () => {
    const world = scriptedHost((message, host) => {
      const frame = message as { type: string; id?: string }
      if (frame.type === 'hello') host.write(encodeFrame(HELLO_OK))
      if (frame.type === 'req') {
        host.write(
          encodeFrame({ type: 'res', id: frame.id, ok: true, result: { state: 'upgrade-pending' } })
        )
      }
    })

    const attach = await opener(() => Promise.resolve(world.ui))('current')
    expect(attach.kind).toBe('attached')
    if (attach.kind !== 'attached') return
    const answer = await attach.link.call('host.upgrade.request', {
      targetVersion: '0.21.0',
      targetDir: '/data/j/dwarfai/host/0.21.0',
      requestId: '01890a5d-ac96-774b-bcce-b302099a8057'
    })

    expect(attach.link.helloOk).toEqual(HELLO_OK)
    expect(answer).toEqual({ ok: true, result: { state: 'upgrade-pending' } })
    expect(world.received[0]).toMatchObject({
      type: 'hello',
      role: 'ui',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      token: TOKEN
    })
    expect(world.received[1]).toMatchObject({ type: 'req', method: 'host.upgrade.request' })
  })

  it('[ADR-002] closed reports the host.closing reason the Host sent before closing, and none for a bare close', async () => {
    const announced = scriptedHost((message, host) => {
      if ((message as { type: string }).type !== 'hello') return
      host.write(encodeFrame(HELLO_OK))
      host.write(
        encodeFrame({
          type: 'evt',
          seq: 1,
          epoch: 'epoch-032',
          name: 'host.closing',
          data: { reason: 'upgrade', clean: true }
        })
      )
      host.end()
    })
    const bare = scriptedHost((message, host) => {
      if ((message as { type: string }).type !== 'hello') return
      host.write(encodeFrame(HELLO_OK))
      // Closed with no host.closing first (a crash looks the same from here).
      setImmediate(() => host.end())
    })

    const first = await opener(() => Promise.resolve(announced.ui))('current')
    const second = await opener(() => Promise.resolve(bare.ui))('current')
    expect([first.kind, second.kind]).toEqual(['attached', 'attached'])
    if (first.kind !== 'attached' || second.kind !== 'attached') return

    expect(await first.link.closed).toBe('upgrade')
    expect(await second.link.closed).toBeNull()
    // A request on a closed link is answered, never left waiting.
    expect(
      await second.link.call('host.shutdown', {
        mode: 'stop-all',
        requestId: '01890a5d-ac96-774b-bcce-b302099a8057'
      })
    ).toMatchObject({ ok: false, error: { code: 'HOST_UNAVAILABLE' } })
  })

  it('[ADR-003] a protocol error frame refuses the attach with its code, and nothing listening is unreachable', async () => {
    const refusing = scriptedHost((_message, host) => {
      host.end(encodeFrame({ type: 'error', code: 'INCOMPATIBLE_GENERATION' }))
    })

    expect(await opener(() => Promise.resolve(refusing.ui))('current')).toEqual({
      kind: 'refused',
      code: 'INCOMPATIBLE_GENERATION'
    })
    expect(await opener(() => Promise.reject(new Error('ENOENT')))('current')).toEqual({
      kind: 'unreachable'
    })
  })

  it('[ADR-002] generation 1 has no previous generation: attaching with it is refused without a connection', async () => {
    let connects = 0

    const attach = await opener(() => {
      connects += 1
      return Promise.reject(new Error('never'))
    })('previous')

    expect(attach).toEqual({ kind: 'refused', code: 'INCOMPATIBLE_GENERATION' })
    expect(connects).toBe(0)
  })
})

// ADDED for ISSUE-051: the link runs on the one seam-B connection (host-client/channel.ts) and keeps the liveness of
// ADR-003 item 9, so a drain that outlasts the Host's 15 s silence limit is not read as a lost connection.
describe('the handshake link keeps the connection alive (ADR-003 item 9)', () => {
  it("[ADR-003] the upgrade link pings while a drain outlasts the Host's 15 s silence limit, so it closes with the drain's host.closing, not as lost", async () => {
    const timers = new ManualTimers()
    const host = new FakeHost({
      capabilities: FAKE_HOST_CAPABILITIES,
      dropSilentAfter: { ms: 15_000, after: timers.after }
    })
    host.handle('host.upgrade.request', () => ({ state: 'upgrade-pending' }))
    const dir = mkdtempSync(join(tmpdir(), 'dwarfai-051-link-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'ui.token'), host.token)
    const settle = async (): Promise<void> => {
      for (let round = 0; round < 20; round += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    const attach = await createHostLinkOpener({
      connect: host.connect,
      tokenFile: join(dir, 'ui.token'),
      protocolVersion: PROTOCOL_VERSION,
      client: { appVersion: '0.21.0', buildId: 'def5678', pid: 4242 },
      after: timers.after
    })('current')
    if (attach.kind !== 'attached') throw new Error(`not attached: ${attach.kind}`)
    const link = attach.link
    let closedWith: string | null | undefined
    void link.closed.then((reason) => (closedWith = reason))
    expect(
      await link.call('host.upgrade.request', {
        targetVersion: '0.21.0',
        targetDir: 'x',
        requestId: '01890a5d-ac96-774b-bcce-b302099a8057'
      })
    ).toEqual({ ok: true, result: { state: 'upgrade-pending' } })

    // The drain takes 40 s; the Host would drop a client silent for 15 s.
    for (let second = 0; second < 40; second += 1) {
      timers.advance(1_000)
      await settle()
    }
    expect(closedWith, 'the link is still open during the drain').toBeUndefined()
    host.closeCleanly('upgrade')
    await settle()

    expect(closedWith).toBe('upgrade')
    expect(host.methods('ui').filter((method) => method === 'ping').length).toBeGreaterThan(0)
  })
  it('[ADR-003] a Host that does not advertise ping gets no ping, and its silence never closes the link', async () => {
    const timers = new ManualTimers()
    const host = new FakeHost({
      capabilities: FAKE_HOST_CAPABILITIES.filter((name) => name !== 'ping')
    })
    const dir = mkdtempSync(join(tmpdir(), 'dwarfai-051-link-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'ui.token'), host.token)

    const attach = await createHostLinkOpener({
      connect: host.connect,
      tokenFile: join(dir, 'ui.token'),
      protocolVersion: PROTOCOL_VERSION,
      client: { appVersion: '0.21.0', buildId: 'def5678', pid: 4242 },
      after: timers.after
    })('current')
    if (attach.kind !== 'attached') throw new Error(`not attached: ${attach.kind}`)
    let closedWith: string | null | undefined
    void attach.link.closed.then((reason) => (closedWith = reason))
    for (let second = 0; second < 40; second += 1) {
      timers.advance(1_000)
      for (let round = 0; round < 20; round += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    expect(closedWith).toBeUndefined()
    expect(host.methods()).toEqual([])
    attach.link.close()
  })
})
