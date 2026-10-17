// layer: L3
// The SessionStarter bridge over the suppliers module's own session tracking (`trackLiveSessions`):
// a launch that fails after its session was handed out never binds it, so the bridge releases the
// unbound entry and its held events (GitHub #1316). "Gone" is read through the suppliers surface: a
// released session can no longer be bound, and none of its events reach the sink.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { DwarfId, FolderPath, LaunchId, ProviderId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import {
  EARLY_FAILURE_WINDOW_MS,
  HANDSHAKE_TIMEOUT_MS,
  type StartResult
} from '../../modules/launching'
import type { DriverLaunchRequest, ProviderDriver, ProviderProfile } from '../../modules/suppliers'
import { trackLiveSessions } from '../../modules/suppliers/application/sessionChannels'
import { FAIL_CLOSED_CAPABILITIES } from '../../modules/suppliers/domain/capabilities'
import { FakeDriverRegistry } from '../../modules/suppliers/ports/fakes/FakeDriverRegistry'
import {
  FakeProviderDriver,
  type FakeDriverSession
} from '../../modules/suppliers/ports/fakes/FakeProviderDriver'
import { RecordingSuppliedEventSink } from '../../modules/suppliers/ports/fakes/RecordingSuppliedEventSink'
import { createSessionStarter } from './sessionStarter'

const PROVIDER = 'staged' as ProviderId
const PROFILE: ProviderProfile = {
  id: PROVIDER,
  label: 'Staged tool',
  binaries: [],
  models: [],
  efforts: [],
  permissionModes: [],
  drivers: ['acp'],
  publicLaunch: 'enabled'
}
const DWARF = '00000000-0000-7000-8000-0000000013a1' as DwarfId
const QUICK_HANDSHAKE_MS = 20

/** Reports its spawn at once, then hands out a `FakeDriverSession` after `handshakeMs`. */
class StagedDriver implements ProviderDriver {
  readonly profile = PROFILE
  readonly transport = 'acp' as const
  private readonly fake = new FakeProviderDriver(PROFILE, 'acp', FAIL_CLOSED_CAPABILITIES)

  constructor(
    private readonly clock: FakeClock,
    private readonly scheduler: FakeScheduler,
    private readonly handshakeMs: number
  ) {}

  get session(): FakeDriverSession {
    const [session] = this.fake.sessions
    if (session === undefined) throw new Error('no session handed out yet')
    return session
  }

  detect = () => this.fake.detect()
  probe = () => this.fake.probe()

  async launch(req: DriverLaunchRequest): Promise<FakeDriverSession> {
    await req.onSpawned({ pid: 41_316, processStartTimeMs: this.clock.now(), bootId: 'staged' })
    await new Promise<void>((resolve) => this.scheduler.after(this.handshakeMs, resolve))
    return this.fake.launch(req)
  }
}

function request(): DriverLaunchRequest {
  return {
    launchId: 'launch-1316' as LaunchId,
    install: {
      providerId: PROVIDER,
      binaryPath: '/opt/staged/bin/tool',
      version: '1.0.0',
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine-one' as FolderPath,
    prompt: 'Survey the north seam',
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:install-1316:launch-1316:epoch-1316',
    onSpawned: async () => undefined
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

async function advance(clock: FakeClock, ms: number): Promise<void> {
  let left = ms
  while (left > 0) {
    const step = Math.min(10, left)
    clock.advance(step)
    left -= step
    await flush()
  }
}

async function arrange(handshakeMs: number) {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const sink = new RecordingSuppliedEventSink()
  const driver = new StagedDriver(clock, scheduler, handshakeMs)
  const tracked = trackLiveSessions(new FakeDriverRegistry([driver]), { sink, clock })
  const starter = createSessionStarter({
    registry: tracked.registry,
    sessions: tracked.channels,
    releases: tracked.releases,
    clock,
    scheduler
  })
  let result: StartResult | undefined
  void starter.start(PROVIDER, request(), { launchedWithLetJevChoose: false }).then((value) => {
    result = value
  })
  await flush() // the spawn is reported and the handshake timer armed at the start instant
  return { clock, sink, driver, tracked, result: () => result }
}

describe('the SessionStarter bridge releases the session of a failed launch (GitHub #1316)', () => {
  it('[S5.20, S5.21, ADR-015] a session that exited inside the early window settles exited-at-once and leaves no unbound entry', async () => {
    const { clock, sink, driver, tracked, result } = await arrange(QUICK_HANDSHAKE_MS)
    await advance(clock, QUICK_HANDSHAKE_MS)
    const { ref } = driver.session
    driver.session.emit({ t: 'status', value: 'working' })
    driver.session.emit({ t: 'exited', code: 1 })
    await advance(clock, EARLY_FAILURE_WINDOW_MS)

    expect(result()).toMatchObject({ ok: false, error: { cause: 'exited-at-once' } })
    expect(() => tracked.bindings.bind(ref, DWARF)).toThrow(HostInvariantError)
    expect(sink.deliveries).toEqual([])
  })

  it('[S5.19, ADR-015] a session handed out after the handshake budget is closed and leaves no unbound entry once it exited', async () => {
    const { clock, sink, driver, tracked, result } = await arrange(HANDSHAKE_TIMEOUT_MS + 100)
    await advance(clock, HANDSHAKE_TIMEOUT_MS)
    expect(result()).toMatchObject({ ok: false, error: { cause: 'could-not-start' } })

    await advance(clock, 100)
    const { ref } = driver.session
    driver.session.emit({ t: 'exited', code: null })
    await flush()

    expect(tracked.channels.sessionFor(ref)).toBeNull()
    expect(() => tracked.bindings.bind(ref, DWARF)).toThrow(HostInvariantError)
    expect(sink.deliveries).toEqual([])
  })

  it('[S5.18, ADR-015] a session still live at the end of the early window starts and stays bindable', async () => {
    const { clock, sink, driver, tracked, result } = await arrange(QUICK_HANDSHAKE_MS)
    await advance(clock, EARLY_FAILURE_WINDOW_MS)
    expect(result()?.ok).toBe(true)

    tracked.bindings.bind(driver.session.ref, DWARF)
    driver.session.emit({ t: 'exited', code: 0 })
    await flush()

    expect(sink.deliveries.map((d) => [d.dwarfId, d.event.t])).toEqual([[DWARF, 'exited']])
  })
})
