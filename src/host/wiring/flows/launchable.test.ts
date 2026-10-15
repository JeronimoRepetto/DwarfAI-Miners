// layer: L2
// L2 flow (17 §1.2): B-M37 `suppliers.launchable` from the Host dispatcher through the suppliers
// route (wiring/routes/suppliers.ts) to the suppliers module wired as boot step 4 does it
// (suppliersWiring.ts), over a FakeClock, a FakeScheduler, a FakeFs and an inline InstallResolver
// double (R15: the module's own doubles stay inside it).
//
// The found tree has no real driver attached and an empty catalog for models, efforts and
// permission modes (ISSUE-147 fail-closed; drivers: later, ISSUE-150…158), so only the simulated
// provider is launch-enabled and it has no model. The model, mode and rescan cases therefore stand
// a scripted launch-enabled catalogue in for the not-yet-attached drivers: its entries carry the
// real module's installed detection (re-checked on every call) and a test catalog's models.
//
// TC-163-01, TC-163-02 and TC-163-03.
import { describe, expect, it } from 'vitest'
import { supplierEntryViewSchema, type SupplierEntryView } from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch } from '../../kernel/domain/values'
import type {
  InstallResolver,
  ProviderId,
  ProviderProfile,
  SupplierEntry,
  SuppliersEvent
} from '../../modules/suppliers'
import { launchableSource, serveSuppliers, type LaunchableSuppliers } from '../routes/suppliers'
import { wireSuppliers } from '../suppliersWiring'
import { Dispatcher } from '../../transport/dispatcher'

const T0 = 1_790_000_000_000
const TOOLS = '/opt/tools'
const UI = { role: 'ui' as const, clientId: 'ui-1' }

/** One machine: the person's CLIs on disk and as the one `InstallResolver` finds them. */
function machine(installed: readonly string[]) {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const fs = new FakeFs()
  const present = new Set(installed)
  for (const binary of installed) fs.addFile(`${TOOLS}/${binary}`, 'cli', 1)
  const asked: string[] = []
  const resolver: InstallResolver = {
    resolve: (binaries) => {
      asked.push(...binaries)
      const binary = binaries.find((name) => present.has(name))
      return Promise.resolve(
        binary === undefined
          ? null
          : { path: `${TOOLS}/${binary}`, version: '1.0.0', resolvedVia: 'path' as const }
      )
    }
  }
  const suppliers = wireSuppliers({
    publicBuild: false,
    clock,
    scheduler,
    ids: new SequenceIdGenerator(),
    fs,
    log: new RecordingDiagnosticsLog(),
    installResolver: resolver,
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: { state: () => 'off' },
    bus: new RecordingEventBus<SuppliersEvent>(),
    hostEpoch: 'epoch-0163' as HostEpoch,
    simulatedSeed: 'seed-0163'
  })
  return {
    clock,
    scheduler,
    suppliers,
    asked,
    /** The person removes a CLI: gone from disk and from PATH. */
    uninstall(binary: string) {
      present.delete(binary)
      fs.removeFile(`${TOOLS}/${binary}`)
    }
  }
}

/** The Host dispatcher with the suppliers route bound as boot step 4 binds it. */
function served(clock: FakeClock, suppliers: LaunchableSuppliers) {
  const dispatcher = new Dispatcher({
    log: new RecordingDiagnosticsLog(),
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  serveSuppliers({ dispatcher }).bind(launchableSource(suppliers))
  return async (params: unknown): Promise<SupplierEntryView[]> => {
    const res = await dispatcher.dispatch(
      { id: 'req-1', method: 'suppliers.launchable', params },
      UI
    )
    if (!res.ok) throw new Error(`suppliers.launchable failed: ${res.error.code}`)
    return supplierEntryViewSchema.array().parse(res.result)
  }
}

/** Lets the promise chains of checks that already have their answer settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** A test catalog profile: its models with their own effort ladders, low → high (ADR-028). */
function profile(id: ProviderId, models: ProviderProfile['models']): ProviderProfile {
  return {
    id,
    label: `Label ${id}`,
    binaries: [id],
    models,
    efforts: ['provider-low', 'provider-high'],
    permissionModes: ['ask-first', 'read-only', 'full-access'],
    drivers: ['acp'],
    publicLaunch: 'enabled'
  }
}

// Real catalog ids, so that the real detection checks their CLIs; test models and modes, since the
// catalog's own arrive later.
const PROFILES: readonly ProviderProfile[] = [
  profile('claude', [
    { id: 'large', label: 'Large', efforts: ['low', 'medium', 'high'], isDefault: true },
    { id: 'small', label: 'Small', efforts: [] }
  ]),
  profile('codex', [{ id: 'one', label: 'One', efforts: ['minimal', 'low', 'medium', 'high'] }]),
  profile('opencode', [{ id: 'free', label: 'Free', efforts: ['low', 'high'] }])
]

/**
 * The stand-in for the drivers not yet attached: every installed test profile is launch-enabled.
 * Installation is the real module's detection, re-checked by its `launchable()` on every call; the
 * answer channel of each profile is scripted, and its modes are those the app can honour with it
 * (ADR-011 item 1: "Ask first" needs an available answer channel).
 */
function attachedDrivers(
  real: ReturnType<typeof machine>['suppliers'],
  channels: Readonly<Record<ProviderId, SupplierEntry['answerChannel']>> = {}
): LaunchableSuppliers {
  return {
    catalogue: {
      launchable: async () => {
        await real.catalogue.launchable()
        return PROFILES.filter((p) => real.catalogue.entry(p.id)?.installed === true).map(
          (p): SupplierEntry => {
            const answerChannel = channels[p.id] ?? 'available'
            return {
              providerId: p.id,
              label: p.label,
              models: p.models.map((model) => model.id),
              efforts: [...p.efforts],
              permissionModes: p.permissionModes.filter(
                (mode) => mode !== 'ask-first' || answerChannel === 'available'
              ),
              installed: true,
              publicLaunch: p.publicLaunch,
              answerChannel
            }
          }
        )
      }
    },
    registry: {
      drivers: (id) => PROFILES.filter((p) => p.id === id).map((p) => ({ profile: p }))
    }
  }
}

describe('launchable list', () => {
  it('[INV-41] only installed, launch-enabled providers are listed and Other is never an entry', async () => {
    const m = machine(['claude', 'opencode'])
    await m.suppliers.bootDetection
    const call = served(m.clock, m.suppliers)

    const entries = await call({})

    // Of the installed CLIs none has a driver attached yet, so none can launch; codex is not
    // installed; the simulated provider (development build) needs no CLI and can launch.
    expect(entries.map((entry) => entry.providerId)).toEqual(['simulated'])
    expect(entries.every((entry) => entry.installed)).toBe(true)
    expect(m.suppliers.catalogue.entry('claude')?.installed).toBe(true)
    expect(entries.map((entry) => entry.providerId)).not.toContain('other')
  })

  it('[INV-42] each entry offers only the permission modes the app can honour', async () => {
    const m = machine(['claude', 'codex', 'opencode'])
    await m.suppliers.bootDetection
    const call = served(
      m.clock,
      attachedDrivers(m.suppliers, { codex: 'none', opencode: 'gated-off' })
    )

    const entries = await call({})

    expect(
      entries.map((entry) => [entry.providerId, entry.answerChannel, entry.offeredModes])
    ).toEqual([
      ['claude', 'available', ['ask-first', 'read-only', 'full-access']],
      ['codex', 'none', ['read-only', 'full-access']],
      ['opencode', 'gated-off', ['read-only', 'full-access']]
    ])
    for (const entry of entries) expect(entry.offeredModes).toEqual(entry.permissionModes)
  })

  it('[ADR-028] each model carries its complete ordered effort ladder', async () => {
    const m = machine(['claude', 'codex'])
    await m.suppliers.bootDetection
    const call = served(m.clock, attachedDrivers(m.suppliers))

    const entries = await call({})

    expect(entries.map((entry) => [entry.providerId, entry.models])).toEqual([
      [
        'claude',
        [
          { value: 'large', label: 'Large', efforts: ['low', 'medium', 'high'] },
          { value: 'small', label: 'Small', efforts: [] }
        ]
      ],
      ['codex', [{ value: 'one', label: 'One', efforts: ['minimal', 'low', 'medium', 'high'] }]]
    ])
  })

  it('[ADR-009] refresh true forces a rescan and an uninstalled provider disappears from the answer', async () => {
    const m = machine(['claude', 'codex'])
    await m.suppliers.bootDetection
    const call = served(m.clock, attachedDrivers(m.suppliers))
    expect((await call({})).map((entry) => entry.providerId)).toEqual(['claude', 'codex'])

    m.uninstall('codex')
    const before = m.asked.length
    const opened = call({ refresh: true })
    await settle()
    m.clock.advance(500)
    const entries = await opened

    expect(m.asked.slice(before)).toContain('codex')
    expect(entries.map((entry) => entry.providerId)).toEqual(['claude'])
    expect(m.suppliers.catalogue.entry('codex')?.installed).toBe(false)
  })
})
