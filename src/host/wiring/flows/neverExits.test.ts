import { describe, expect, it } from 'vitest'
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { ConnectionRegistry, type AttachedConnection } from '../../transport/connectionRegistry'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import type { ChannelRole } from '../../transport/roles'
import { runBoot } from '../boot'
import { createBootSteps } from '../bootSteps'
import { composeHostLifecycle } from '../hostLifecycle'

// L2 flow (17 §1.2): a booted Host with faked transport clients and every port faked, driven by a
// FakeClock (ADR-002 D7; 13 FM-013 withdrawn: an idle Host is still `ready` after 24 h).

const DAY_MS = 24 * 60 * 60 * 1_000

/** A faked transport client: what the registry sent it, and whether it was ended. */
class FakeClient implements AttachedConnection {
  readonly frames: Array<{ name: HostFrameName; data: unknown }> = []
  ended = false

  constructor(
    readonly role: ChannelRole,
    readonly clientId: string,
    private readonly journal: string[]
  ) {}

  send<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
    this.frames.push({ name, data })
    this.journal.push(`${this.role}:${name}`)
  }

  end(): Promise<void> {
    this.ended = true
    this.journal.push(`${this.role}:end`)
    return Promise.resolve()
  }
}

/** A Host booted to `ready` with no session, no ask and no window. */
async function readyHost() {
  const journal: string[] = []
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const exits: number[] = []
  const endpoint = {
    closed: false,
    bind: () => Promise.resolve('bound' as const),
    close() {
      this.closed = true
      journal.push('endpoint.close')
      return Promise.resolve()
    }
  }
  const sessionEnds: Array<() => void> = []
  const lifecycle = composeHostLifecycle({
    checkpoint: new RecordingShutdownCheckpoint(journal),
    connections,
    endpoint,
    scheduler,
    log,
    sessionEnd: { onSessionEnd: (listener) => sessionEnds.push(listener) },
    exit: (code) => {
      exits.push(code)
      journal.push(`exit:${code}`)
    }
  })
  const outcome = await runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock,
        scheduler,
        ids: new SequenceIdGenerator(),
        fs: new FakeFs(),
        processControl: new FakeProcessControl(),
        log,
        endpoint
      }),
    {
      log,
      clock,
      state,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths() },
      runtime: { os: 'linux', arch: 'x64', node: '24.18.1' },
      exit: (code) => exits.push(code)
    }
  )
  expect(outcome).toEqual({ kind: 'ready' })
  return { journal, log, clock, scheduler, connections, state, exits, endpoint, lifecycle }
}

describe('the Host never exits on its own (ADR-002 D7, OQ-63, AMENDMENT-5)', () => {
  it('[US-RES-002.AC12, FM-013] with no session running and no window, the Host is still ready 24 h later, the notifier connection is still open and no host.closing was sent', async () => {
    const host = await readyHost()
    const notifier = new FakeClient('notifier', 'tray-1', host.journal)
    host.connections.attach(notifier)

    host.clock.advance(DAY_MS)
    await Promise.resolve()

    expect(host.state.current()).toEqual({ state: 'ready', jobStatus: 'n/a' })
    expect(notifier.ended).toBe(false)
    expect(notifier.frames).toEqual([])
    expect(host.connections.connections()).toEqual([notifier])
    expect(host.endpoint.closed).toBe(false)
    expect(host.exits).toEqual([])
    expect(host.log.byEvent('host.exit')).toEqual([])
    // TC-028-01: nothing is scheduled that could end the Host later either.
    expect(host.scheduler.nextDueAt()).toBeNull()
  })

  it('[US-RES-002.AC12, S12.17] only closeCleanly ends the Host: it sends host.closing with its reason to every ui and notifier connection, then exits', async () => {
    const host = await readyHost()
    const ui = new FakeClient('ui', 'window-1', host.journal)
    const notifier = new FakeClient('notifier', 'tray-1', host.journal)
    host.connections.attach(ui)
    host.connections.attach(notifier)
    host.clock.advance(DAY_MS)
    expect(host.exits).toEqual([])

    await host.lifecycle.closeCleanly('stop-all')

    const closing = { name: 'host.closing', data: { reason: 'stop-all', clean: true } }
    expect(ui.frames).toEqual([closing])
    expect(notifier.frames).toEqual([closing])
    expect(ui.ended && notifier.ended).toBe(true)
    expect(host.endpoint.closed).toBe(true)
    expect(host.exits).toEqual([0])
    expect(host.journal.at(-1)).toBe('exit:0')
    expect(host.log.byEvent('host.exit')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', causeClass: 'stop-all' })
    ])
  })
})
