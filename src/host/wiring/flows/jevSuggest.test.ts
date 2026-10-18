// layer: L2
// L2 flow (17 §1.2): B-M38 `jev.suggest` over the wired Host (05 §4; 16 §8.2, §8.3), composed as
// host/main.ts composes it. Real `jev`, `suppliers` and `preferences` modules: preferences wired at
// "boot step 3" over a copy of the template database (wiring/preferencesWiring.ts), with its kernel
// `SecretReader` bridge over a FakeSecretStore holding the Jev key; suppliers wired at "boot step 4"
// (wiring/suppliersWiring.ts) over an inline install resolver; jev bound right after it
// (wiring/routes/jev.ts) with the `RoutingCatalogSource` bridge to `suppliers.launchable()`
// (bridges/routingCatalogSource.ts). The `ui` client is a FrameClient behind an in-process duplex,
// authenticated by the real `hello` (14 §1.3).
//
// The router is an inline recording `JevRouter` double: the module's own FakeJevRouter lives under
// its `ports/fakes`, which wiring may not import (R15). It keeps every request and key it was sent,
// and answers only what a case queued.
//
// The found tree attaches no real driver yet (ISSUE-150…158), so no installed CLI is launchable,
// and the development build's simulated provider (15 §4.12) has no models and no row in Jev's
// capability table, so Jev has nothing to ask about it. The cases therefore run a public build (no
// simulated entry) and stand a launch-enabled Claude over the real module's installed detection in
// for its not-yet-attached driver, exactly as flows/launchable.test.ts does: the real catalogue's
// `launchable()` plus Claude once its CLI is detected (re-checked on every call). Every other
// installed CLI stays installed and not launchable. The default-fallback case also hands the
// composition the capability table of its high-only models (`JevDeps.capabilities`, as a
// composition that derives one does).
//
// TC-196-01, TC-196-02.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_FRAME_SCHEMAS, PROTOCOL_VERSION } from '@dwarfai/contracts'
import type { HostEpoch } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import type { JevDeps, JevRouter } from '../../modules/jev'
import type { PreferencesEvent } from '../../modules/preferences'
import { FakeSecretStore } from '../../modules/preferences/testing/fakeSecretStore'
import type {
  InstallResolver,
  SupplierCatalogueQueries,
  SupplierEntry,
  SuppliersEvent
} from '../../modules/suppliers'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { HelloThrottle } from '../../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../../transport/auth/uiToken'
import { collectCapabilities } from '../../transport/capabilities'
import { acceptConnection } from '../../transport/connection'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
import { Dispatcher } from '../../transport/dispatcher'
import { TRANSPORT_FRAMES } from '../../transport/events/framePublisher'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../transport/testing/frameClient'
import { inProcessDuplex } from '../../transport/testing/inProcessDuplex'
import { routingCatalogSource } from '../bridges/routingCatalogSource'
import { createFeatureFlagReader, featureFlagConfigFilePath } from '../featureFlagReader'
import { createModuleResetSteps } from '../moduleResetSteps'
import { noOwnedConfigWriter, servePreferences } from '../preferencesWiring'
import { serveJev } from '../routes/jev'
import { launchableSource, serveSuppliers } from '../routes/suppliers'
import { wireSuppliers } from '../suppliersWiring'

const T0 = 1_790_000_000_000
const TOOLS = '/opt/tools'
const JEV_KEY = 'ts-flow-196-key'
const PROMPT = 'add a field to this form'
const MINE = '01920000-0000-7000-9000-0000000001f6'
const REQUEST_IDS = [
  '01920000-0000-7000-a000-000000000196',
  '01920000-0000-7000-a000-000000000197',
  '01920000-0000-7000-a000-000000000198'
]

type RouteRequest = Parameters<JevRouter['route']>[0]
type RouteResponse = Awaited<ReturnType<JevRouter['route']>>
type CapabilityTable = NonNullable<JevDeps['capabilities']>
type CapabilityEntry = NonNullable<CapabilityTable[string]>[string]

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** Lets the in-process streams and the promise chains behind them run, a bounded number of turns. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** The recording `JevRouter` double (inline, R15): answers only what a case queued. */
class RecordingJevRouter implements JevRouter {
  readonly requests: RouteRequest[] = []
  readonly keys: string[] = []
  private readonly queued: RouteResponse[] = []

  queue(response: RouteResponse): void {
    this.queued.push(response)
  }

  route(req: RouteRequest, key: string): Promise<RouteResponse> {
    this.requests.push(req)
    this.keys.push(key)
    const next = this.queued.shift()
    return next === undefined
      ? Promise.reject(new Error('RecordingJevRouter: route() called with nothing queued'))
      : Promise.resolve(next)
  }

  routeModel(): Promise<never> {
    return Promise.reject(new Error('RecordingJevRouter: routeModel() is not scripted here'))
  }
}

/** Jev's first-request answers (16 §6.3), picking `provider`. */
function answers(provider: string, effortScore = 1.5): RouteResponse {
  return {
    kind: 'answers',
    provider: { choice: provider, confidence: 0.91 },
    tier: { choice: 'balanced', confidence: 0.88 },
    trivial: { probability: 0.05 },
    largeContext: { probability: 0.05 },
    effort: { score: effortScore },
    usage: { inputTokens: 42 }
  }
}

/** Two Claude models whose allowed efforts all sit above the level Jev works out (ADR-028). */
const HIGH_ONLY_MODELS = ['c-xhigh', 'c-high']

function highOnlyCapabilities(): CapabilityTable {
  const entry = (effortLevels: CapabilityEntry['effortLevels']): CapabilityEntry => ({
    tier: 'balanced',
    what: 'Everyday coding work that needs real reasoning.',
    notFor: 'Trivial lookups.',
    examples: ['Add a field to this form.', 'Extract this helper.'],
    launchTarget: true,
    effortLevels,
    relativeCost: 'medium',
    sources: ['test fixture'],
    verifiedOn: '2026-10-17'
  })
  return {
    claude: { 'c-xhigh': entry(['xhigh', 'max']), 'c-high': entry(['high', 'max']) }
  }
}

/**
 * The stand-in for the not-yet-attached Claude driver: the real catalogue, whose `launchable()` also
 * answers Claude, launch-enabled with `models`, once the real detection finds its CLI.
 */
function attachedClaude(
  real: SupplierCatalogueQueries,
  models: readonly string[]
): SupplierCatalogueQueries {
  return {
    entry: (id) => real.entry(id),
    capabilities: (id) => real.capabilities(id),
    launchable: async () => {
      const launchable = await real.launchable()
      if (real.entry('claude')?.installed !== true) return launchable
      const claude: SupplierEntry = {
        providerId: 'claude',
        label: 'Claude Code',
        models: [...models],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        permissionModes: ['ask-first', 'accept-edits', 'full-access'],
        installed: true,
        publicLaunch: 'enabled',
        answerChannel: 'available'
      }
      return [...launchable, claude]
    }
  }
}

interface HostOptions {
  /** The CLIs the one `InstallResolver` finds. */
  installed?: readonly string[]
  /** Stands a launch-enabled Claude with these models in for its driver. */
  claudeModels?: readonly string[]
  /** The capability table the composition derives, when it derives one. */
  capabilities?: CapabilityTable
}

/** The Host, composed as host/main.ts composes it, with one `ui` client attached. */
async function wiredHost(options: HostOptions = {}) {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const ids = new SequenceIdGenerator()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  const sections = new SectionRegistry()

  // Before the boot binds the endpoint: every member is served before its module exists (14 §1.3).
  const servedPreferences = servePreferences({ dispatcher, sections, connections })
  const servedSuppliers = serveSuppliers({ dispatcher })
  const servedJev = serveJev({ dispatcher })

  // Boot step 3: preferences, with the OS secret store holding the Jev key.
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const secrets = new FakeSecretStore()
  await secrets.set('jev-key', JEV_KEY)
  const preferences = servedPreferences.wire({
    db,
    transactions,
    bus: new InProcessEventBus<PreferencesEvent>({
      transactionScope: transactions,
      onHandlerError: (failure) => {
        throw failure.error
      }
    }),
    clock,
    scheduler,
    ids,
    hostEpoch: 'epoch-0196' as HostEpoch,
    log,
    featureFlags: await createFeatureFlagReader({
      env: {},
      fs: new FakeFs(),
      configFilePath: featureFlagConfigFilePath('/data'),
      log
    }),
    maintenance: {
      deleteBackups: () => undefined,
      truncateWal: () => undefined,
      vacuum: () => undefined
    },
    ledger: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
    moduleSteps: createModuleResetSteps({
      db,
      scope: transactions,
      clock,
      mapSites: [],
      random: () => 0
    }).steps,
    secrets,
    externalConfig: noOwnedConfigWriter,
    ready: () => state.current().state === 'ready'
  })
  await preferences.loadSecretStatuses()

  // Boot step 4: suppliers, then jev over it.
  const installed = options.installed ?? []
  const fs = new FakeFs()
  for (const binary of installed) fs.addFile(`${TOOLS}/${binary}`, 'cli', 1)
  const resolver: InstallResolver = {
    resolve: (binaries) => {
      const binary = binaries.find((name) => installed.includes(name))
      return Promise.resolve(
        binary === undefined
          ? null
          : { path: `${TOOLS}/${binary}`, version: '1.0.0', resolvedVia: 'path' as const }
      )
    }
  }
  const suppliers = wireSuppliers({
    // ADR-009 D6: a public build offers no development-only provider (the simulated one).
    publicBuild: true,
    clock,
    scheduler,
    ids,
    fs,
    log,
    installResolver: resolver,
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: preferences.integrationGate,
    bus: new RecordingEventBus<SuppliersEvent>(),
    hostEpoch: 'epoch-0196' as HostEpoch,
    simulatedSeed: 'seed-0196'
  })
  await suppliers.bootDetection
  servedSuppliers.bind(launchableSource(suppliers))
  const catalogue =
    options.claudeModels === undefined
      ? suppliers.catalogue
      : attachedClaude(suppliers.catalogue, options.claudeModels)
  const router = new RecordingJevRouter()
  servedJev.bind({
    router,
    secretReader: preferences.secretReader,
    routingCatalog: routingCatalogSource(catalogue),
    preferences: preferences.preferences.queries,
    log,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities })
  })
  state.report({ state: 'ready', jobStatus: 'n/a' })

  // The `ui` client: the real hello over an in-process duplex.
  const runDir = mkdtempSync(join(tmpdir(), 'dwarfai-196-jev-'))
  cleanups.push(() => rmSync(runDir, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(runDir)
  const pair = inProcessDuplex()
  acceptConnection(pair.host, {
    token,
    ids,
    identity: { hostVersion: '0.0.0-test', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    epoch: 'epoch-0196' as HostEpoch,
    state: () => state.current(),
    capabilities: () =>
      collectCapabilities({
        methods: dispatcher.methods(),
        frames: TRANSPORT_FRAMES,
        sections: sections.names()
      }),
    scheduler,
    clock,
    log,
    dispatcher,
    connections,
    throttle: new HelloThrottle(clock)
  })
  const client = new FrameClient(pair.client)
  cleanups.push(() => void pair.client.destroy())
  client.send({
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'ui',
    token: readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8'),
    client: { appVersion: '0.0.0-test', buildId: 'abc1234', pid: 4242 }
  })
  await until(() => client.frames.length > 0)
  expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })

  let next = 0
  /** Sends one request and resolves with its `res` frame. */
  const call = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    next += 1
    const id = `req-${String(next)}`
    client.send({ type: 'req', id, method, params })
    const isAnswer = (frame: unknown): boolean =>
      (frame as { type?: string; id?: string }).type === 'res' &&
      (frame as { id?: string }).id === id
    await until(() => client.frames.some(isAnswer))
    const res = client.frames.find(isAnswer)
    if (res === undefined) throw new Error(`no answer to ${method}`)
    return res as Record<string, unknown>
  }

  return { client, call, router, log, suppliers, catalogue }
}

const SUGGEST = { prompt: PROMPT, mineId: MINE }

describe('jev.suggest over the wired Host', () => {
  it("[US-LAUNCH-003.AC02] a ui client's jev.suggest over the wired Host returns the pick among the launchable providers", async () => {
    const host = await wiredHost({ installed: ['claude'], claudeModels: ['sonnet'] })
    const launchable = (await host.catalogue.launchable()).map((entry) => entry.providerId)
    expect(launchable).toEqual(['claude'])
    host.router.queue(answers('claude'))

    const res = await host.call('jev.suggest', SUGGEST)

    expect(res).toMatchObject({
      ok: true,
      result: {
        ok: true,
        value: { providerId: 'claude', model: 'sonnet', parts: { providerId: 'answered' } }
      }
    })
    // Only the prompt and the launchable list left the Host, with the key the store holds (C-26).
    expect(host.router.requests).toHaveLength(1)
    expect(host.router.requests[0]?.prompt).toBe(PROMPT)
    expect(JSON.stringify(host.router.requests)).not.toContain(MINE)
    expect(host.router.keys).toEqual([JEV_KEY])
  })

  it('[US-LAUNCH-003.AC11] a provider that is installed but not launchable at this step is never a criterion sent to Jev', async () => {
    const host = await wiredHost({
      installed: ['claude', 'codex', 'opencode'],
      claudeModels: ['sonnet']
    })
    // Installed, but no driver of theirs probed `launch` at this step (ISSUE-150…158).
    expect(host.suppliers.catalogue.entry('codex')?.installed).toBe(true)
    expect(host.suppliers.catalogue.entry('opencode')?.installed).toBe(true)
    host.router.queue(answers('claude'))

    const res = await host.call('jev.suggest', SUGGEST)

    expect(res).toMatchObject({ ok: true, result: { ok: true, value: { providerId: 'claude' } } })
    expect(Object.keys(host.router.requests[0]?.providerCriteria ?? {})).toEqual([
      'claude',
      'no_preference'
    ])
  })

  it('[ADR-020] with no launchable provider the wired Host answers jev-could-not-choose with reason no-launchable-provider', async () => {
    // The simulated provider is absent (public build) and the installed CLI cannot launch yet.
    const host = await wiredHost({ installed: ['claude'] })

    const res = await host.call('jev.suggest', SUGGEST)

    expect(res).toMatchObject({
      ok: true,
      result: { ok: false, error: 'jev-could-not-choose' }
    })
    expect(host.log.byEvent('jev.fallback')).toMatchObject([
      { event: 'jev.fallback', causeClass: 'no-launchable-provider' }
    ])
    // The observe-only variant of 3a: nothing was sent and no key was read for a request.
    expect(host.router.requests).toEqual([])
    expect(host.router.keys).toEqual([])
  })

  it('[US-LAUNCH-003.AC13] with high-only candidates and a default configured through preferences.set the wired Host answers the default', async () => {
    const host = await wiredHost({
      installed: ['claude'],
      claudeModels: HIGH_ONLY_MODELS,
      capabilities: highOnlyCapabilities()
    })
    const defaults = [
      ['defaultProvider', 'codex'],
      ['defaultModel', 'gpt-5-codex'],
      ['defaultEffort', 'max']
    ] as const
    for (const [index, [key, value]] of defaults.entries()) {
      expect(
        await host.call('preferences.set', { key, value, requestId: REQUEST_IDS[index] })
      ).toMatchObject({ ok: true })
    }
    // Effort score 0 maps to the bottom of the ladder: every high-only candidate is above it.
    host.router.queue(answers('claude', 0))

    const res = await host.call('jev.suggest', SUGGEST)

    expect(res).toMatchObject({
      ok: true,
      result: {
        ok: true,
        value: {
          providerId: 'codex',
          model: 'gpt-5-codex',
          effort: 'max',
          fallback: 'effort-ceiling',
          parts: { providerId: 'safe-default', model: 'safe-default', effort: 'safe-default' }
        }
      }
    })
  })

  it('[ADR-003] hello.ok.capabilities lists jev.suggest once the module is wired', async () => {
    const host = await wiredHost()

    expect((host.client.frames[0] as { capabilities?: string[] }).capabilities).toContain(
      'jev.suggest'
    )
  })
})
