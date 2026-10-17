import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS } from '../../../contracts/catalog'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  LaunchId,
  MessageId
} from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { CATALOG_RECORDS } from './adapters/catalog/profiles'
import { SIMULATED_HANDSHAKE_MS } from './adapters/drivers/simulated/SimulatedDriver'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import {
  createSuppliers,
  HOSTED_COMMAND_PROVIDER_ID,
  type DriverLaunchRequest,
  type SuppliersEvent
} from './index'
import { FakeInstallResolver } from './ports/fakes/FakeInstallResolver'
import { FakeIntegrationGateReader } from './ports/fakes/FakeIntegrationGateReader'
import { InMemoryCapabilityRecordStore } from './ports/fakes/InMemoryCapabilityRecordStore'
import { RecordingSuppliedEventSink } from './ports/fakes/RecordingSuppliedEventSink'

function build(
  publicBuild: boolean,
  installResolver = new FakeInstallResolver(),
  fs = new FakeFs()
) {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler(clock)
  const sink = new RecordingSuppliedEventSink()
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS,
    publicBuild,
    clock,
    scheduler,
    simulatedSeed: 'seed',
    sink,
    installResolver,
    fs,
    capabilityRecords: new InMemoryCapabilityRecordStore(),
    integrationGate: new FakeIntegrationGateReader(),
    bus: new RecordingEventBus<SuppliersEvent>(),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-1' as HostEpoch
  })
  return { clock, sink, suppliers }
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

  it('[ADR-009, ADR-015] a simulated turn reaches the Host stamped with the bound dwarf, and sessionFor ends with the session', async () => {
    const { clock, sink, suppliers } = build(false)
    const [driver] = suppliers.registry.drivers('simulated')
    if (driver === undefined) throw new Error('no simulated driver')
    const dwarfId = '00000000-0000-7000-8000-0000000000aa' as DwarfId

    const pending = driver.launch(launchRequest('launch-1'))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    clock.advance(SIMULATED_HANDSHAKE_MS)
    const session = await pending
    expect(suppliers.sessions.sessionFor({ ...session.ref })).toBe(session)
    expect(
      suppliers.sessions.sessionFor({ providerId: 'simulated', providerSessionId: 'unknown' })
    ).toBeNull()

    await session.sendTurn({
      messageId: 'message-1' as MessageId,
      kind: 'message',
      text: 'dig',
      attachments: []
    })
    clock.advance(1_000)
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(sink.deliveries).toEqual([])

    suppliers.bindings.bind(session.ref, dwarfId)
    await session.close('end-thread')
    for (let i = 0; i < 50; i++) await Promise.resolve()

    const ended = sink.deliveries.find((d) => d.event.t === 'turn.ended')
    expect(ended?.event).toMatchObject({ t: 'turn.ended', end: { dwarfId, kind: 'concluded' } })
    expect(sink.deliveries.every((d) => d.dwarfId === dwarfId)).toBe(true)
    expect(sink.deliveries.at(-1)?.event).toEqual({ t: 'exited', code: 0 })
    expect(suppliers.sessions.sessionFor(session.ref)).toBeNull()
  })

  it('[US-RES-005.AC01, US-RES-005.AC05, INV-41] the composed catalogue knows the installed catalog CLIs and lists as launchable only a provider whose attached driver can launch it, the simulated provider only in a development build', async () => {
    const machine = (): { resolver: FakeInstallResolver; fs: FakeFs } => {
      const resolver = new FakeInstallResolver()
      const fs = new FakeFs()
      for (const binary of ['claude', 'agy', 'opencode']) {
        fs.addFile(`/opt/tools/${binary}`, 'cli', 1)
        resolver.install(binary, { path: `/opt/tools/${binary}`, version: '1.0.0' })
      }
      return { resolver, fs } // codex is not installed
    }
    const inPublic = machine()
    const inDevelopment = machine()
    const publicIds = (
      await build(true, inPublic.resolver, inPublic.fs).suppliers.catalogue.launchable()
    ).map((entry) => entry.providerId)
    const developmentIds = (
      await build(false, inDevelopment.resolver, inDevelopment.fs).suppliers.catalogue.launchable()
    ).map((entry) => entry.providerId)

    // Amended for ISSUE-147: a provider is launchable only when a driver probed it able to launch
    // (ADR-009 D4, D6; INV-44). No real driver is attached yet (ISSUE-150…158), so the installed
    // CLIs are known to the catalogue but offered on no launch surface; only the simulated
    // provider, whose driver is attached, is launchable, and only in a development build.
    // Was: ['claude', 'opencode'] / ['claude', 'antigravity', 'opencode', 'simulated'].
    expect(publicIds).toEqual([])
    expect(developmentIds).toEqual(['simulated'])
    const known = build(true, inPublic.resolver, inPublic.fs).suppliers.catalogue
    await known.launchable()
    expect(known.entry('claude')?.installed).toBe(true)
    expect(known.entry('opencode')?.installed).toBe(true)
    expect(known.entry('codex')?.installed).toBe(false)
  })
})

// ISSUE-165 (INV-43; 15 §4.11): with the process deps the composition root hands over, the module
// attaches the "Other…" `HostedCommandDriver` to the registry it tracks, and the catalogue never
// shows it.
describe('createSuppliers and "Other…" (ISSUE-165)', () => {
  it('[INV-43, US-OBS-007.AC05] the "Other…" driver is reachable through the registry and is in no catalogue entry or launchable list', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const suppliers = createSuppliers({
      catalogIds: CATALOG_PROVIDER_IDS,
      publicBuild: true,
      clock,
      scheduler,
      simulatedSeed: 'seed',
      sink: new RecordingSuppliedEventSink(),
      installResolver: new FakeInstallResolver(),
      fs: new FakeFs(),
      capabilityRecords: new InMemoryCapabilityRecordStore(),
      integrationGate: new FakeIntegrationGateReader(),
      bus: new RecordingEventBus<SuppliersEvent>(),
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-1' as HostEpoch,
      hostedCommand: {
        processControl: new FakeProcessControl({ clock }),
        loginEnv: { PATH: '/usr/bin' },
        platform: 'linux',
        redact: (text) => text
      }
    })

    const [driver] = suppliers.registry.drivers(HOSTED_COMMAND_PROVIDER_ID)
    expect(driver?.transport).toBe('stdio-raw')
    expect(driver?.profile.label).toBe('Other…')
    expect(suppliers.catalogue.entry(HOSTED_COMMAND_PROVIDER_ID)).toBeNull()
    const launchable = await suppliers.catalogue.launchable()
    expect(launchable.map((entry) => entry.providerId)).not.toContain(HOSTED_COMMAND_PROVIDER_ID)
  })
})

// Added for ISSUE-182 (forward note of #1375): the person's own CLIs get their drivers in the
// registry once the composition root hands their process deps over, each in the profile's D4
// order, with the resume-context lookup a restarted Host reads (ISSUE-173). Claude's stream-json
// driver joins only with its permission prompt tool (AMENDMENT-21): without the tool's relay it
// is not attached (hidden until built).
describe('createSuppliers with the CLI drivers (ISSUE-182)', () => {
  function withCli(claudeStreamJson: boolean) {
    const clock = new FakeClock()
    const lookups: string[] = []
    const suppliers = createSuppliers({
      catalogIds: CATALOG_PROVIDER_IDS,
      publicBuild: true,
      clock,
      scheduler: new FakeScheduler(clock),
      simulatedSeed: 'seed',
      sink: new RecordingSuppliedEventSink(),
      installResolver: new FakeInstallResolver(),
      fs: new FakeFs(),
      capabilityRecords: new InMemoryCapabilityRecordStore(),
      integrationGate: new FakeIntegrationGateReader(),
      bus: new RecordingEventBus<SuppliersEvent>(),
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-1' as HostEpoch,
      cliDrivers: {
        processControl: new FakeProcessControl({ clock }),
        loginEnv: { PATH: '/usr/bin' },
        home: '/home/canary.user',
        platform: 'linux',
        redact: (text) => text,
        clientInfo: { name: 'dwarfai', version: '0.0.0' },
        resumeContext: (ref) => {
          lookups.push(ref.providerSessionId)
          return null
        },
        ...(claudeStreamJson
          ? {
              claudeStreamJson: {
                mcpConfig: {
                  dir: '/data/run/mcp',
                  files: { write: async () => undefined, remove: async () => undefined }
                },
                promptTool: {
                  sessions: { register: () => () => undefined },
                  relay: { issue: async () => null, release: async () => undefined }
                }
              }
            }
          : {})
      }
    })
    return { suppliers, lookups }
  }

  it('[ADR-009] Codex gets its app-server driver and Claude its stream-json driver once its prompt tool is composed', () => {
    const { suppliers } = withCli(true)
    expect(suppliers.registry.drivers('codex').map((d) => d.transport)).toEqual(['app-server-rpc'])
    expect(suppliers.registry.drivers('claude').map((d) => d.transport)).toEqual(['stream-json'])
  })

  it('[ADR-009] without the permission prompt tool Claude has no stream-json driver', () => {
    const { suppliers } = withCli(false)
    expect(suppliers.registry.drivers('claude')).toEqual([])
    expect(suppliers.registry.drivers('codex').map((d) => d.transport)).toEqual(['app-server-rpc'])
  })

  it('[ADR-015, S4.18] a restarted Host resume of a session the driver never launched reads the stored launch record', async () => {
    const { suppliers, lookups } = withCli(true)
    const [codex] = suppliers.registry.drivers('codex')
    await expect(
      codex?.resume?.({ providerId: 'codex', providerSessionId: 'thread-182' })
    ).rejects.toMatchObject({ reason: 'resume-error' })
    expect(lookups).toEqual(['thread-182'])
  })
})
