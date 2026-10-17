// The suppliers session tracking (`trackLiveSessions`) over one staged `ProviderDriver` double, for
// tests outside the module that need the real index of handed-out sessions (wiring reaches a
// module only through its index or its testing folder, 05 R15). The driver reports its spawn at
// once and hands out a `FakeDriverSession` after `handshakeMs`; the test pushes its events.
// Never imported by production code (R14).
import type { ProviderId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import { trackLiveSessions } from '../application/sessionChannels'
import { FAIL_CLOSED_CAPABILITIES } from '../domain/capabilities'
import type { ProviderProfile } from '../domain/profile'
import { FakeDriverRegistry } from '../ports/fakes/FakeDriverRegistry'
import { FakeProviderDriver, type FakeDriverSession } from '../ports/fakes/FakeProviderDriver'
import { RecordingSuppliedEventSink } from '../ports/fakes/RecordingSuppliedEventSink'
import type { DriverLaunchRequest, ProviderDriver } from '../ports/providerDriver'

export const STAGED_PROVIDER_ID = 'staged' as ProviderId

const PROFILE: ProviderProfile = {
  id: STAGED_PROVIDER_ID,
  label: 'Staged tool',
  binaries: [],
  models: [],
  efforts: [],
  permissionModes: [],
  drivers: ['acp'],
  publicLaunch: 'enabled'
}

class StagedDriver implements ProviderDriver {
  readonly profile = PROFILE
  readonly transport = 'acp' as const
  readonly fake = new FakeProviderDriver(PROFILE, 'acp', FAIL_CLOSED_CAPABILITIES)

  constructor(
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly handshakeMs: number
  ) {}

  detect = () => this.fake.detect()
  probe = () => this.fake.probe()

  async launch(req: DriverLaunchRequest): Promise<FakeDriverSession> {
    await req.onSpawned({ pid: 41_316, processStartTimeMs: this.clock.now(), bootId: 'staged' })
    await new Promise<void>((resolve) => this.scheduler.after(this.handshakeMs, resolve))
    return this.fake.launch(req)
  }
}

export interface StagedSessionsOptions {
  clock: Clock
  scheduler: Scheduler
  /** How long after the spawn the driver hands its session out. */
  handshakeMs: number
}

export function stagedSessions(options: StagedSessionsOptions) {
  const sink = new RecordingSuppliedEventSink()
  const driver = new StagedDriver(options.clock, options.scheduler, options.handshakeMs)
  const tracked = trackLiveSessions(new FakeDriverRegistry([driver]), {
    sink,
    clock: options.clock
  })
  return {
    ...tracked,
    sink,
    /** The first session the driver handed out, as the driver holds it (its events are the test's). */
    handedOut(): FakeDriverSession {
      const [session] = driver.fake.sessions
      if (session === undefined) throw new Error('no session handed out yet')
      return session
    }
  }
}
