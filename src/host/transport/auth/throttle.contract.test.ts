// layer: L6
// L6 (17 §1.6): the failed-hello throttle over the real seam-B transport (ADR-003 item 5, frozen;
// 14 §1.5; 19 §9.2 `channel.rate-limited`), on a FakeClock and FakeScheduler.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { HostStateHolder } from '../lifecycle/hostState'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { HelloThrottle, THROTTLE_REFUSAL_MS } from './throttle'
import { UI_TOKEN_FILE, UiToken } from './uiToken'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-024-throttle-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'run')
  const token = new UiToken()
  await token.issue(dir)
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  const throttle = new HelloThrottle(clock)
  const ids = new SequenceIdGenerator()
  const connect = (): FrameClient => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: 'epoch-0001',
      state: () => state.current(),
      capabilities: () => collectCapabilities({ methods: dispatcher.methods() }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    return new FrameClient(pair.client)
  }
  const hello = (secret: string) => ({
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'ui',
    token: secret,
    client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
  })
  return { clock, log, connect, hello, token: readFileSync(join(dir, UI_TOKEN_FILE), 'utf8') }
}

describe('failed-hello throttle on the UI endpoint (ADR-003 item 5)', () => {
  it('[ADR-003, FM-027] a connection during the 10 s refusal gets one RATE_LIMITED frame and is closed; after 10 s a valid hello succeeds', async () => {
    const host = await boot()
    for (let i = 0; i < 5; i += 1) {
      const intruder = host.connect()
      intruder.send(host.hello('0'.repeat(64)))
      await intruder.settle()
      expect(intruder.frames).toEqual([{ type: 'error', code: 'AUTH_FAILED' }])
      host.clock.advance(1_000)
    }
    expect(host.log.byEvent('channel.rate-limited')).toEqual([
      { level: 'warn', event: 'channel.rate-limited', subsystem: 'transport', count: 5 }
    ])

    // During the refusal even the right token is not read: one frame, then the close.
    for (let i = 0; i < 2; i += 1) {
      const refused = host.connect()
      refused.send(host.hello(host.token))
      await refused.settle()
      expect(refused.frames).toEqual([{ type: 'error', code: 'RATE_LIMITED' }])
      expect(refused.closed).toBe(true)
    }
    // Logged once, with the count; a refused connection is not a new failure.
    expect(host.log.byEvent('channel.rate-limited')).toHaveLength(1)
    expect(host.log.byEvent('channel.hello.refused')).toHaveLength(5)

    // The refusal began at the fifth failure, 1 s ago.
    host.clock.advance(THROTTLE_REFUSAL_MS - 1_000)
    const welcome = host.connect()
    welcome.send(host.hello(host.token))
    await welcome.settle()
    expect(welcome.frames[0]).toMatchObject({ type: 'hello.ok' })
    expect(welcome.closed).toBe(false)
  })
})
