import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS } from '../../../contracts/catalog'
import type { FolderPath, LaunchId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { CATALOG_RECORDS } from './adapters/catalog/profiles'
import { SIMULATED_HANDSHAKE_MS } from './adapters/drivers/simulated/SimulatedDriver'
import { createSuppliers, type DriverEvent, type DriverLaunchRequest } from './index'

function build(publicBuild: boolean) {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler(clock)
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS,
    publicBuild,
    clock,
    scheduler,
    simulatedSeed: 'seed'
  })
  return { clock, suppliers }
}

function launchRequest(launchId: string): DriverLaunchRequest {
  return {
    launchId: launchId as LaunchId,
    install: {
      providerId: 'simulated',
      binaryPath: 'simulated',
      version: null,
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine' as FolderPath,
    prompt: 'go',
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:install:launch:epoch',
    onSpawned: async () => {}
  }
}

const transportsOf = (id: string): string[] | undefined =>
  CATALOG_RECORDS.find((record) => record.profile.id === id)?.profile.drivers

describe('createSuppliers (suppliers skeleton)', () => {
  it('[ADR-009] the v1 catalog lists the drivers of each provider in the D4 preference order and every id is a catalog id', () => {
    expect(transportsOf('claude')).toEqual(['acp', 'stream-json'])
    expect(transportsOf('codex')).toEqual(['app-server-rpc', 'acp'])
    expect(transportsOf('opencode')).toEqual(['http-server', 'acp'])
    expect(transportsOf('antigravity')).toEqual(['ndjson'])
    expect(CATALOG_RECORDS.find((r) => r.profile.id === 'antigravity')?.profile.publicLaunch).toBe(
      'gated'
    )
    expect(CATALOG_RECORDS.map((record) => record.profile.id)).toEqual([...CATALOG_PROVIDER_IDS])

    const { suppliers } = build(false)
    for (const id of CATALOG_PROVIDER_IDS) {
      expect(suppliers.catalogue.entry(id)?.providerId).toBe(id)
    }
    // Only the simulated driver is attached in this skeleton.
    expect(suppliers.registry.drivers('simulated').map((d) => d.transport)).toEqual(['acp'])
    expect(suppliers.registry.drivers('claude')).toEqual([])
  })

  it('[ADR-009] a public build carries no simulated provider and keeps a gated provider as catalogue data only', () => {
    const { suppliers } = build(true)

    expect(suppliers.catalogue.entry('simulated')).toBeNull()
    expect(suppliers.registry.drivers('simulated')).toEqual([])
    expect(suppliers.catalogue.entry('antigravity')).toMatchObject({ publicLaunch: 'gated' })
    expect(suppliers.registry.drivers('antigravity')).toEqual([])
  })

  it('[ADR-009] sessionFor finds a session a registry driver launched, and nothing once it exited', async () => {
    const { clock, suppliers } = build(false)
    const [driver] = suppliers.registry.drivers('simulated')
    if (driver === undefined) throw new Error('no simulated driver')

    const pending = driver.launch(launchRequest('launch-1'))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    clock.advance(SIMULATED_HANDSHAKE_MS)
    const session = await pending

    expect(suppliers.sessions.sessionFor({ ...session.ref })).toBe(session)
    expect(
      suppliers.sessions.sessionFor({ providerId: 'simulated', providerSessionId: 'unknown' })
    ).toBeNull()

    await session.close('end-thread')
    const events: DriverEvent[] = []
    for await (const event of session.events()) events.push(event)

    expect(events.at(-1)).toEqual({ t: 'exited', code: 0 })
    expect(suppliers.sessions.sessionFor(session.ref)).toBeNull()
  })
})
