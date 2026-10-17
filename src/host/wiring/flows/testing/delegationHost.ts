// The F6 flow harness (11 F6 steps 1-6; UC-017 main flow; ISSUE-204): the real delegation
// endpoint and subtask run, the real jev advisor behind the `SubtaskRouter` bridge, the real
// launching module behind the `WorkerLauncher` bridge, and the in-memory crew. Every driven port is
// a double: the delegation stores are in memory, Jev answers through `ScriptedJevRouter` (the jev
// module's own `FakeJevRouter` stays inside that module, R15), the key through `FakeSecretReader`,
// sessions start through `FakeSessionStarter` (the SessionStarter bridge's contract, 16 §2.8), and
// time is a FakeClock with its FakeScheduler.
//
// The delegating dwarf is a root launch made with "Let Jev choose" while "Subagent delegation" is
// on (the gate of UC-009), holding its bound delegation token. Passing an earlier host's
// `database` is the CH-01 injector (17 §4): the earlier composition is dropped and a new one is
// composed over the same stores, as a Host restarted over the same database file is.
import { CATALOG_PROVIDER_IDS } from '@dwarfai/contracts'
import type { DwarfId, HostEpoch, LaunchId, ProviderId } from '../../../kernel/domain/values'
import type { SecretValue } from '../../../kernel/ports/secretReader'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { rankForDepth } from '../../../modules/crew'
import { inMemoryCrew } from '../../../modules/crew/testing/inMemoryCrew'
import {
  DelegationEndpointService,
  SubtaskRunService,
  type DelegationEndpointEvent,
  type DelegationToken,
  type SubtaskRunEvent
} from '../../../modules/delegation'
import {
  InMemoryDelegationTicketStore,
  InMemoryDelegationTokenStore,
  inMemoryDelegationLifecycle
} from '../../../modules/delegation/testing/delegationFlowKit'
import { createJev, type JevDeps, type JevRouter } from '../../../modules/jev'
import { createLaunching, type LaunchingEvent } from '../../../modules/launching'
import { FakeSessionStarter } from '../../../modules/launching/testing/FakeSessionStarter'
import { inMemoryLaunching } from '../../../modules/launching/testing/inMemoryLaunching'
import { MINE, MINE_FOLDER, T0 } from '../../../modules/launching/testing/sqliteLaunchingDb'
import type { MineView } from '../../../modules/mines'
import { createSuppliers } from '../../../modules/suppliers'
import { createSubtaskRouter } from '../../bridges/subtaskRouter'
import { createWorkerLauncher } from '../../bridges/workerLauncher'

export const SIMULATED = 'simulated' as ProviderId
/** The delegating dwarf's own launch (its delegation token is keyed by it). */
export const PARENT_LAUNCH = '00000000-0000-7000-8000-0000000c2a01' as LaunchId
const JEV_KEY = 'ts-flow-204-key'
/** Past the FakeSessionStarter's early window (ADR-020 D4). */
export const SETTLE_MS = 3_200

/**
 * Jev's capability table for the simulated supplier alone: the shipped tables know only the real
 * providers, and the flow launches nothing real. One balanced launch target.
 */
const SIMULATED_CAPABILITIES: NonNullable<JevDeps['capabilities']> = {
  [SIMULATED]: {
    'sim-balanced': {
      tier: 'balanced',
      what: 'Everyday multi-step coding work on a small repository.',
      notFor: 'Very long documents or the hardest research problems.',
      examples: ['Rename a field across three files', 'Write a unit test for a parser'],
      launchTarget: true,
      effortLevels: 'all',
      relativeCost: 'unverified',
      sources: ['test double: the simulated supplier'],
      verifiedOn: '2026-10-17'
    }
  }
}

type JevRouteResponse = Awaited<ReturnType<JevRouter['route']>>
/** Jev's answers to the first request (16 §6.3). */
export type JevRouteAnswers = Extract<JevRouteResponse, { kind: 'answers' }>

/**
 * A scripted `JevRouter` (16 §2.8): no network, no SDK. It answers each first request with the next
 * queued response, keeps every request it was sent, and a queued hang never answers. A call with
 * nothing queued, or a second request, rejects: a gap in the test's own setup.
 */
export class ScriptedJevRouter implements JevRouter {
  readonly requests: unknown[] = []
  readonly keys: SecretValue[] = []
  private readonly responses: (JevRouteResponse | 'hang')[] = []

  queueResponse(response: JevRouteResponse): void {
    this.responses.push(response)
  }

  queueHang(): void {
    this.responses.push('hang')
  }

  route(req: Parameters<JevRouter['route']>[0], key: SecretValue): Promise<JevRouteResponse> {
    this.requests.push(req)
    this.keys.push(key)
    const next = this.responses.shift()
    if (next === undefined) return Promise.reject(new Error('ScriptedJevRouter: nothing queued'))
    if (next === 'hang') return new Promise(() => undefined)
    return Promise.resolve(next)
  }

  routeModel(): ReturnType<JevRouter['routeModel']> {
    return Promise.reject(new Error('ScriptedJevRouter: no second request is scripted'))
  }
}

/** The stores that survive a Host restart (the database file). */
export interface DelegationDatabase {
  tickets: InMemoryDelegationTicketStore
  tokens: InMemoryDelegationTokenStore
}

export function delegationHost(
  options: { epoch?: string; database?: DelegationDatabase; delegationOn?: boolean } = {}
) {
  const database: DelegationDatabase = options.database ?? {
    tickets: new InMemoryDelegationTicketStore(),
    tokens: new InMemoryDelegationTokenStore()
  }
  const hostEpoch = (options.epoch ?? 'epoch-204') as HostEpoch
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const launchingBus = new RecordingEventBus<LaunchingEvent>()
  const crew = inMemoryCrew()
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS as unknown as ProviderId[],
    publicBuild: false,
    clock,
    scheduler,
    simulatedSeed: 'seed-204',
    sink: { deliver: () => undefined },
    installResolver: { resolve: async () => null },
    fs: new FakeFs(),
    capabilityRecords: { record: () => undefined, latest: () => null },
    integrationGate: { state: () => 'off' },
    bus: { publish: () => undefined },
    ids,
    hostEpoch
  })
  const starter = new FakeSessionStarter({
    clock,
    scheduler,
    supplierLabel: 'Simulated',
    capabilities: suppliers.catalogue.capabilities(SIMULATED)
  })
  const mine = { id: MINE, state: 'active' } as MineView
  const launching = createLaunching({
    launches: db.launches,
    processes: db.processes,
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    starter,
    suppliers: {
      registry: suppliers.registry,
      catalogue: { entry: (id) => suppliers.catalogue.entry(id) },
      bindings: { bind: () => undefined }
    },
    mines: {
      get: (id) => (id === MINE ? mine : null),
      folderOf: (id) => (id === MINE ? MINE_FOLDER : null)
    },
    crew: crew.commands,
    bus: launchingBus,
    clock,
    scheduler,
    ids,
    hostEpoch,
    installId: '00000000-0000-7000-8000-0000000c2aff',
    log
  })

  const preferences = {
    get: () => ({
      subagentDelegationOn: options.delegationOn ?? true,
      routingProfile: 'balanced' as const,
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    })
  }
  const jevRouter = new ScriptedJevRouter()
  const jev = createJev({
    router: jevRouter,
    secretReader: new FakeSecretReader({ values: { 'jev-key': JEV_KEY }, scheduler }),
    // The step's launchable providers, as the `RoutingCatalogSource` bridge reads them.
    routingCatalog: { launchable: () => suppliers.catalogue.launchable() },
    preferences,
    log,
    capabilities: SIMULATED_CAPABILITIES
  })

  const delegationBus = new RecordingEventBus<DelegationEndpointEvent | SubtaskRunEvent>()
  const endpoint = new DelegationEndpointService({
    tokens: database.tokens,
    tickets: database.tickets,
    launches: {
      gateOf: (launchId) => {
        if (launchId === PARENT_LAUNCH) {
          return { launchedWithLetJevChoose: true, delegated: false }
        }
        const launch = db.launches.byId(launchId)
        return launch === null
          ? null
          : {
              launchedWithLetJevChoose: launch.launchedWithLetJevChoose,
              delegated: launch.request.delegation !== undefined
            }
      }
    },
    preferences,
    transactions: { inTransaction: (work) => work() },
    bus: delegationBus,
    clock,
    ids,
    hostEpoch,
    scheduler
  })
  const subtasks = new SubtaskRunService({
    tickets: database.tickets,
    router: createSubtaskRouter({ jev: jev.advisor }),
    launcher: createWorkerLauncher({
      launching: launching.commands,
      events: launchingBus,
      crew: crew.queries
    }),
    transactions: { inTransaction: (work) => work() },
    bus: delegationBus,
    clock,
    ids,
    hostEpoch,
    log,
    settled: (ticket) => endpoint.delegationSettled(ticket)
  })
  // What the SessionStarter bridge asks at each launch (AMENDMENT-14 A14-02): issue or not.
  const { lifecycle } = inMemoryDelegationLifecycle({
    tokens: database.tokens,
    tickets: database.tickets,
    clock,
    ids,
    hostEpoch,
    log,
    preferences
  })
  // The `SubtaskDelegated` route, off the tool call (later: ISSUE-209 composes it in host/wiring).
  const routes: Promise<void>[] = []
  delegationBus.subscribe('SubtaskDelegated', (e) => {
    routes.push(subtasks.run(e.payload.delegationId))
  })

  return {
    database,
    db,
    clock,
    scheduler,
    log,
    crew,
    starter,
    launching,
    launchingBus,
    jevRouter,
    delegationBus,
    endpoint,
    subtasks,
    lifecycle,
    routes,
    /** The delegating dwarf: a root launch, always a foreman (INV-27), working. */
    arriveParent(): { parent: DwarfId; token: DelegationToken } {
      const parent = crew.commands.arrive({
        mineId: MINE,
        identity: { providerId: 'claude', providerSessionId: 'parent-session-204' },
        rank: rankForDepth(0),
        status: 'working'
      })
      const token: DelegationToken = {
        launchId: PARENT_LAUNCH,
        parentDwarfId: parent,
        mechanism: 'ticket-file',
        credentialHash: 'c'.repeat(64),
        issuedAt: T0
      }
      database.tokens.issue(token)
      return { parent, token }
    },
    /** Moves the clock in 10 ms steps, letting promise jobs run in between. */
    async run(ms: number): Promise<void> {
      for (let left = ms; left > 0; left -= 10) {
        clock.advance(Math.min(10, left))
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      }
    }
  }
}
