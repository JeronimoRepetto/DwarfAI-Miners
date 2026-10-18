// layer: L3
// The SessionStarter bridge starts the driver the provider's capability check selected (ADR-009 D4, "first verified
// wins"; GitHub #1431), the same one launching detected through, never merely the first of the provider's drivers:
// OpenCode's server driver comes first and cannot launch (S-031-3). Two hand-made drivers of one provider, FakeClock
// and FakeScheduler: no process.
import { describe, expect, it } from 'vitest'
import type { FolderPath, LaunchId, ProviderId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import type { DriverLaunchRequest, ProviderDriver } from '../../modules/suppliers'
import { createSessionStarter } from './sessionStarter'

const PROVIDER = 'alpha' as ProviderId

function request(): DriverLaunchRequest {
  return {
    launchId: 'launch-1431' as LaunchId,
    install: {
      providerId: PROVIDER,
      binaryPath: '/opt/alpha/bin/alpha',
      version: '1.0.0',
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine-one' as FolderPath,
    prompt: 'Survey the north seam',
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:install-1431:launch-1431:epoch-1431',
    onSpawned: async () => undefined
  }
}

/** A driver on `transport` whose `launch` is only counted: it never settles. */
function countedDriver(transport: string): { driver: ProviderDriver; launches: () => number } {
  let launches = 0
  const driver = {
    transport,
    profile: { id: PROVIDER, label: 'Alpha' },
    launch: () => {
      launches += 1
      return new Promise<never>(() => undefined)
    }
  } as unknown as ProviderDriver
  return { driver, launches: () => launches }
}

describe('the SessionStarter bridge and the selected driver (GitHub #1431)', () => {
  it('[ADR-009, S5.19] the bridge starts the driver the capability check selected, not the first of the provider', async () => {
    const clock = new FakeClock(1_790_000_000_000)
    const scheduler = new FakeScheduler(clock)
    const first = countedDriver('http-server')
    const selected = countedDriver('acp')
    const starter = createSessionStarter({
      launchDriver: async (id) => (id === PROVIDER ? selected.driver : undefined),
      sessions: { sessionFor: () => null },
      clock,
      scheduler
    })

    void starter.start(PROVIDER, request(), { launchedWithLetJevChoose: false })
    for (let i = 0; i < 20; i += 1) await Promise.resolve()

    expect(first.launches()).toBe(0)
    expect(selected.launches()).toBe(1)
  })
})
