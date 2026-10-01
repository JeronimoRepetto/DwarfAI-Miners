// layer: L6
// The ADR-002 D3 hello probe (07 S12.02; 13 FM-009): how a starting Host asks a live endpoint
// whether a running Host holds it, over an in-process duplex.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeFrame, PROTOCOL_VERSION } from '@dwarfai/contracts'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { UI_TOKEN_FILE, UiToken } from './auth/uiToken'
import { acceptConnection } from './connection'
import { ConnectionRegistry } from './connectionRegistry'
import { Dispatcher } from './dispatcher'
import { createHelloProbe, PROBE_HELLO_TIMEOUT_MS } from './helloProbe'
import { HostStateHolder } from './lifecycle/hostState'
import { inProcessDuplex } from './testing/inProcessDuplex'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-023-probe-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'run')
}

const CLIENT = { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }

/** A running Host's transport on one end of a pair; the probe gets the other end. */
async function runningHost(dir: string, scheduler: FakeScheduler, clock: FakeClock) {
  const token = new UiToken()
  await token.issue(dir)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const pair = inProcessDuplex()
  acceptConnection(pair.host, {
    token,
    ids: new SequenceIdGenerator(),
    identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    epoch: 'epoch-running',
    state: () => state.current(),
    capabilities: () => [],
    scheduler,
    clock,
    log,
    dispatcher: new Dispatcher({ log, clock, state: () => state.current().state }),
    connections
  })
  return { connection: pair.client, log }
}

describe('the ADR-002 D3 hello probe', () => {
  it('[ADR-002, S12.02] the probe reads run/ui.token and a running Host answers its hello: answers-hello', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const dir = runDir()
    const host = await runningHost(dir, scheduler, clock)
    const probe = createHelloProbe({
      tokenFile: join(dir, UI_TOKEN_FILE),
      scheduler,
      protocolVersion: PROTOCOL_VERSION,
      client: CLIENT
    })

    expect(await probe(host.connection)).toBe('answers-hello')
    // It authenticated with the token it read, in the lowest role: the notifier never mutates.
    expect(host.log.byEvent('channel.attach')).toEqual([
      expect.objectContaining({ role: 'notifier' })
    ])
  })

  it('[ADR-002, FM-009] a running Host whose token cannot be read still answers the hello with a protocol error: answers-hello', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const host = await runningHost(runDir(), scheduler, clock)
    const probe = createHelloProbe({
      tokenFile: join(runDir(), UI_TOKEN_FILE), // nothing there
      scheduler,
      protocolVersion: PROTOCOL_VERSION,
      client: CLIENT
    })

    expect(await probe(host.connection)).toBe('answers-hello')
    expect(host.log.byEvent('channel.hello.refused')).toEqual([
      expect.objectContaining({ causeClass: 'AUTH_FAILED' })
    ])
  })

  it('[ADR-002, FM-009] an endpoint that never answers, closes, or answers with something that is not a Host frame is no-hello', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const dir = runDir()
    await new UiToken().issue(dir)
    const probe = createHelloProbe({
      tokenFile: join(dir, UI_TOKEN_FILE),
      scheduler,
      protocolVersion: PROTOCOL_VERSION,
      client: CLIENT
    })

    // Silent: the probe gives up after its bound.
    const silent = inProcessDuplex()
    const helloSent = new Promise((resolve) => silent.host.once('data', resolve))
    const silentAnswer = probe(silent.client)
    await helloSent
    clock.advance(PROBE_HELLO_TIMEOUT_MS)
    expect(await silentAnswer).toBe('no-hello')

    // Closed at once.
    const closing = inProcessDuplex()
    closing.host.on('data', () => closing.host.destroy())
    expect(await probe(closing.client)).toBe('no-hello')

    // A frame that is not a seam-B server frame, and bytes that are not frames at all.
    for (const answer of [
      encodeFrame({ type: 'hello.ok' }),
      encodeFrame({ hello: 'world' }),
      new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\n\r\n')
    ]) {
      const other = inProcessDuplex()
      other.host.on('data', () => other.host.write(answer))
      // Each answers at once: no clock movement is needed to settle.
      expect(await probe(other.client)).toBe('no-hello')
    }
  })
})
