// The delegation module, composed (EPIC-12; ISSUE-209; 05 §4; 16 §5.2-§5.5, §8.2; ADR-013; ADR-015
// item 6; AMENDMENT-14, AMENDMENT-21): what the composition root builds so a gated parent can
// delegate a subtask through the MCP endpoint, and Claude's permission prompt tool rides the same
// relay. Built in two halves, because the driver needs its relay before suppliers exists and the
// delegation routes need jev, launching, crew and conversation:
//
// - `wireDelegation` (boot step 4, before suppliers attaches the Claude stream-json driver): the
//   lifecycle over its SQLite token and ticket stores and the owner-only credential files
//   (`RunDirCredentialFileStore`, `<hostDataDir>/run/mcp/`), the stream-json driver's prompt-tool
//   relay (bridges/promptToolRelay.ts: every stream-json launch the gates leave out still gets a
//   hash-only row and a credential FILE), the `PermissionPromptBridge`, and the routes of a token's
//   life (16 §4.8): `DwarfLaunched` → `bindParent`, then the endpoint's `parentBound` (a `delegate`
//   call that waited for the bind goes on, 16 §5.2 item 5); `DwarfDeparted` → `revokeFor` (its
//   token revoked, its file deleted, its in-flight delegations failed `parent-gone`, S8.11, INV-83;
//   a departing worker's running delegation fails `worker-lost`, S8.09).
//   `starter` is the `SessionStarter` bridge's door: `issueFor` before the driver starts, and
//   `revokeLaunch` when a start fails, which also ends the `delegate` calls waiting on that launch.
// - `compose` (boot step 4, once launching, crew and conversation are wired): the endpoint
//   (`DelegationEndpointService`, its launch gate re-read through bridges/delegationLaunchFacts.ts),
//   the handoff (`ParentHandoffService`), the subtask run (`SubtaskRunService`) behind the
//   `SubtaskRouter` bridge → jev and the `WorkerLauncher` bridge → launching, the `ParentDeliverer`
//   bridge → conversation, and the routes of 05 §4: `SubtaskDelegated` → `run` (off the tool call),
//   a delegated worker's `TurnEnded` → `workerTurnEnded` with its last assistant message (lead
//   decision 2026-09-30), `DelegationSucceeded` → crew `endDelegated`, `DelegationFailed` → the
//   parent's one chat line (routes/delegationFailed.ts). A routing, handoff or launch change wakes
//   the `subtask_result` calls waiting on its ticket (`delegationSettled`).
// - `recoverOnBoot` (boot step 5, after the Host recovery classified): every delegation still
//   `attempted` was being routed when the Host stopped → S8.12 `worker-lost` (FM-021); every
//   `running` one whose worker did not survive (crew no longer holds it present and running) →
//   `worker-lost` (INV-84); then the
//   ADR-015 item 6 sweep of the tokens and credential files (`sweepOrphans`): a launch that never
//   reached a dwarf loses its credential, a recovered session keeps it for its resume.
// - `listen` (boot step 6): the MCP server over the listener the root passes (`mcpEndpointListener`,
//   the owner-only pipe or socket of ADR-013 item 3), serving the two delegation tools through the
//   endpoint and reporting each `done` answer's flush to the handoff (16 §5.4 "Handoff"). A gated
//   session's relay lists the two delegation tools (and `permission` for a Claude stream-json one);
//   an ungated stream-json session's relay lists `permission` alone (INV-80).
//
// The handoff's route is `tool-result` for every v1 parent: each relay entry answers tool calls
// (16 §5.4; no v1 driver needs the result pushed as turn input, handoff.ts header). The parent is
// alive while crew holds it present (S8.13 vs S8.11). Failures are logged by class only (ADR-026):
// never a subtask's text, a credential or a path.
import { join } from 'node:path'
import type { DwarfId, HostEpoch, LaunchId } from '../kernel/domain/values'
import { HostInvariantError } from '../kernel/domain/errors'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../kernel/ports/domainEventBus'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import type {
  ConversationCommands,
  ConversationDeliverCommand,
  ConversationQueries,
  TurnEndedEvent
} from '../modules/conversation'
import type { CrewDelegatedEnds, CrewQueries, DwarfDeparted } from '../modules/crew'
import {
  createDelegationLifecycle,
  createHandoffMcpDelegationServer,
  DelegationEndpointService,
  DelegationWorkerLoss,
  ParentHandoffService,
  SubtaskRunService,
  type DelegationEndpointEvent,
  type DelegationFailed,
  type DelegationLifecycle,
  type DelegationLifecycleEvent,
  type DelegationRelayListener,
  type DelegationServer,
  type DelegationSucceeded,
  type DelegationTokenStore,
  type HandoffEvent,
  type SubtaskRunEvent
} from '../modules/delegation'
import { RunDirCredentialFileStore } from '../modules/delegation/adapters/fs/RunDirCredentialFileStore'
import { relayEntryArgs } from '../modules/delegation/adapters/mcp/relay/relayEntry'
import { SqliteDelegationTicketStore } from '../modules/delegation/adapters/sqlite/SqliteDelegationTicketStore'
import { SqliteDelegationTokenStore } from '../modules/delegation/adapters/sqlite/SqliteDelegationTokenStore'
import type { JevAdvisor } from '../modules/jev'
import type {
  DwarfLaunched,
  LaunchingCommands,
  LaunchingEvent,
  LaunchQueries
} from '../modules/launching'
import type { CredentialMinter, PreferencesQueries } from '../modules/preferences'
import type { CliDriverDeps } from '../modules/suppliers'
import type { McpConfigFiles } from '../modules/suppliers/adapters/drivers/claude-stream-json/mcpConfigFile'
import type { EndpointFacts } from '../platform/endpoint/nodeEndpointEnv'
import { HelloThrottle } from '../transport/auth/throttle'
import { EndpointBindError } from '../transport/endpoint/server'
import type { ListenOwnerOnlyPipe } from '../transport/endpoint/windowsPipeSecurity'
import type { HostIdentity } from '../transport/hello'
import { createMcpEndpoint } from '../transport/mcpEndpoint/mcpEndpoint'
import { mcpEndpointFor } from '../transport/mcpEndpoint/mcpEndpointPath'
import type { HostStateReport } from './boot'
import { errorCode } from './boot'
import { createDelegationLaunchFacts } from './bridges/delegationLaunchFacts'
import { createParentDeliverer } from './bridges/parentDeliverer'
import { PermissionPromptBridge } from './bridges/permissionPromptBridge'
import { createPromptToolRelay } from './bridges/promptToolRelay'
import { createSubtaskRouter } from './bridges/subtaskRouter'
import { createWorkerLauncher } from './bridges/workerLauncher'
import { registerDelegationFailed } from './routes/delegationFailed'

export interface DelegationWiringDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  transactions: TransactionRunner
  /** The lifecycle publishes `DelegationFailed`; the token routes read launching's and crew's events. */
  bus: DomainEventBus<DelegationLifecycleEvent> &
    Pick<DomainEventBus<DwarfLaunched | DwarfDeparted>, 'subscribe'>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** "Subagent delegation" (06 §14.2), read at each `issueFor` and each `delegate` call. */
  preferences: Pick<PreferencesQueries, 'get'>
  /** The transport's per-launch credential minter (lead decision 2026-09-30). */
  mintCredential: CredentialMinter
  /** The versioned-copy executable the relay runs (ADR-002 D5). */
  execPath: string
  /** The Host entry (`out/host/main.js`), beside which the relay script lives (relayEntry.ts). */
  hostEntryPath: string
  hostDataDir: string
  /** Where the driver writes each launch's `--mcp-config` file (owner-only, 15 §4.2). */
  mcpConfigFiles: McpConfigFiles
}

/** Every event the composed endpoint, subtask run and handoff publish (08 §0). */
export type DelegationRouteEvent = DelegationEndpointEvent | SubtaskRunEvent | HandoffEvent

/**
 * The Host bus as each composed part sees it: one view per publisher and per route, so the one
 * Host bus is assignable to every view (16 §2.3).
 */
export type DelegationRouteBus = DomainEventBus<DelegationEndpointEvent> &
  DomainEventBus<SubtaskRunEvent> &
  DomainEventBus<HandoffEvent> &
  Pick<DomainEventBus<DelegationSucceeded>, 'subscribe'> &
  Pick<DomainEventBus<DelegationFailed>, 'subscribe'> &
  Pick<DomainEventBus<TurnEndedEvent>, 'subscribe'> &
  Pick<DomainEventBus<LaunchingEvent>, 'subscribe'>

/** What `compose` reads of the modules boot step 4 wired before it. */
export interface DelegationRouteDeps {
  /** Publishes the delegation events; the routes read conversation's turn ends and launching's settlements. */
  bus: DelegationRouteBus
  /** The `subtask_result` wait (16 §5.5). */
  scheduler: Scheduler
  /** The Host's Jev advisor (16 §4.9), behind the `SubtaskRouter` bridge. */
  jev: JevAdvisor
  launching: {
    /** Behind the `WorkerLauncher` bridge (a delegated launch, AMENDMENT-15). */
    commands: Pick<LaunchingCommands, 'launch'>
    /** A relay's launch gate (bridges/delegationLaunchFacts.ts). */
    queries: Pick<LaunchQueries, 'launchedWithLetJevChoose'>
  }
  crew: {
    queries: Pick<CrewQueries, 'get' | 'displayName'>
    /** `endDelegated` over the Host's terminator and bus (16 §4.2; 05 §4 `DelegationSucceeded`). */
    ends: CrewDelegatedEnds
  }
  conversation: {
    /** The worker's last assistant message, newest first (16 §4.6 `feed`). */
    queries: Pick<ConversationQueries, 'feed'>
    /** The parent's failure line (routes/delegationFailed.ts). */
    commands: Pick<ConversationCommands, 'ingest'>
    /** The routed send path's `deliverInvisibly`, behind the `ParentDeliverer` bridge. */
    deliverer: Pick<ConversationDeliverCommand, 'deliverInvisibly'>
  }
}

export interface McpEndpointListenerDeps {
  /** The UI endpoint's facts: the MCP endpoint is its sibling (mcpEndpointPath.ts). */
  facts: EndpointFacts
  /** The token rows the endpoint authenticates a relay's `McpHello` against (16 §5.2). */
  tokens: Pick<DelegationTokenStore, 'byLaunch'>
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  log: DiagnosticsLog
  identity: HostIdentity
  /** This boot's epoch (`HelloOk.epoch`). */
  epoch: string
  state: () => HostStateReport
  /** The owner-only pipe helper (ADR-003 item 2); a socket never needs it. */
  ownerOnlyPipe?: ListenOwnerOnlyPipe
}

/**
 * The Host's MCP endpoint as the delegation server's listener (ADR-013 item 3; 16 §5.2): the
 * owner-only pipe or socket beside the UI endpoint, with its own failed-hello throttle. A listen
 * that cannot read the facts or resolve the path rejects (the caller logs it).
 */
export function mcpEndpointListener(deps: McpEndpointListenerDeps): DelegationRelayListener {
  return {
    listen: async (accept) => {
      const facts = await deps.facts()
      if (!facts.ok) throw new EndpointBindError('ENDPOINT_FACTS_UNREADABLE', facts.cause)
      const endpoint = mcpEndpointFor(facts.value)
      if (!endpoint.ok) throw new EndpointBindError('MCP_ENDPOINT_UNRESOLVED')
      return createMcpEndpoint({
        endpoint: endpoint.value,
        tokens: deps.tokens,
        scheduler: deps.scheduler,
        log: deps.log,
        ids: deps.ids,
        identity: deps.identity,
        epoch: deps.epoch,
        state: deps.state,
        throttle: new HelloThrottle(deps.clock),
        ...(deps.ownerOnlyPipe === undefined ? {} : { ownerOnlyPipe: deps.ownerOnlyPipe })
      }).listen(accept)
    }
  }
}

export interface WiredDelegation {
  /** The token rows, for the MCP endpoint's authentication (`mcpEndpointListener`). */
  readonly tokens: Pick<DelegationTokenStore, 'byLaunch'>
  /** `CliDriverDeps.claudeStreamJson`: what attaches the stream-json driver. */
  readonly driver: NonNullable<CliDriverDeps['claudeStreamJson']>
  /** The `PermissionPromptEndpoint` the MCP server serves `permission` through. */
  readonly prompts: PermissionPromptBridge
  /** The `SessionStarter` bridge's lifecycle (16 §5.3): issue before the start, revoke after a failed one. */
  readonly starter: Pick<DelegationLifecycle, 'issueFor' | 'revokeLaunch'>
  /** Boot step 4, once launching, crew and conversation are wired: the endpoint and its routes. */
  compose(deps: DelegationRouteDeps): void
  /** Boot step 5, after the Host recovery classified: S8.12, then the ADR-015 sweep. */
  recoverOnBoot(): Promise<void>
  /** Boot step 6: the MCP server listens on `listener`; a failure is logged, never fatal. */
  listen(listener: DelegationRelayListener): Promise<void>
  /** The clean exit: the routes unsubscribed and the server closed. */
  close(): Promise<void>
}

/** The parts `compose` builds, read by the token routes and `listen`. */
interface Composed {
  endpoint: DelegationEndpointService
  handoff: ParentHandoffService
  subtasks: SubtaskRunService
  workerLoss: DelegationWorkerLoss
  /** Whether a worker's session survived the Host restart (the recovery classified it running). */
  survived(worker: DwarfId): boolean
}

export function wireDelegation(deps: DelegationWiringDeps): WiredDelegation {
  const { db, log } = deps
  const tokens = new SqliteDelegationTokenStore(db)
  const tickets = new SqliteDelegationTicketStore(db)
  const files = new RunDirCredentialFileStore({ hostDataDir: deps.hostDataDir })
  const relay = { program: deps.execPath, args: relayEntryArgs(deps.hostEntryPath) }
  const lifecycle = createDelegationLifecycle({
    tokens,
    tickets,
    files,
    transactions: deps.transactions,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch,
    log,
    preferences: deps.preferences,
    mintCredential: deps.mintCredential,
    appPaths: { execPath: deps.execPath },
    relayEntryArgs: relay.args
  })
  let composed: Composed | null = null
  const failed = (event: string) => (error: unknown) =>
    log.record({
      level: 'warn',
      event,
      subsystem: 'delegation',
      outcome: 'failed',
      errCode: errorCode(error)
    })
  /** A launch that never ran: its token revoked and its file deleted, its waiting calls ended. */
  const revokeLaunch = async (launchId: LaunchId): Promise<void> => {
    try {
      await lifecycle.revokeLaunch(launchId)
    } finally {
      composed?.endpoint.launchClosed(launchId)
    }
  }
  const prompts = new PermissionPromptBridge()
  const stops = [
    deps.bus.subscribe('DwarfLaunched', ({ payload }) => {
      const launchId = payload.launchId as LaunchId
      lifecycle.bindParent(launchId, payload.dwarfId as DwarfId)
      composed?.endpoint.parentBound(launchId)
    }),
    deps.bus.subscribe('DwarfDeparted', ({ payload }) => {
      // A departing parent: its token revoked, its delegations failed `parent-gone` (S8.11).
      void lifecycle.revokeFor(payload.dwarfId).catch(failed('delegation.revoke'))
      // A departing worker whose delegation is still running: `worker-lost` (S8.09). A worker
      // that walks out after its handoff (S8.08) finds its delegation settled: nothing moves.
      try {
        composed?.workerLoss.workerLost(payload.dwarfId)
      } catch (error) {
        failed('delegation.worker-lost')(error)
      }
    })
  ]
  let server: DelegationServer | null = null
  return {
    driver: {
      mcpConfig: { dir: join(deps.hostDataDir, 'run', 'mcp'), files: deps.mcpConfigFiles },
      promptTool: {
        sessions: prompts,
        relay: createPromptToolRelay({
          lifecycle: {
            issuePromptRelay: (launchId) => lifecycle.issuePromptRelay(launchId),
            revokeLaunch
          },
          tokens,
          files,
          relay,
          hostDataDir: deps.hostDataDir
        })
      }
    },
    prompts,
    tokens,
    starter: {
      issueFor: (launch) => lifecycle.issueFor(launch),
      revokeLaunch
    },
    compose: (routeDeps) => {
      if (composed !== null)
        throw new HostInvariantError('the delegation endpoint is composed once')
      composed = composeEndpoint(deps, routeDeps, { tokens, tickets }, stops, failed)
    },
    recoverOnBoot: async () => {
      if (composed === null) {
        throw new HostInvariantError(
          'boot step 5 runs after step 4 composed the delegation endpoint'
        )
      }
      try {
        composed.subtasks.failRoutingOnBoot()
      } catch (error) {
        failed('delegation.reconcile')(error)
      }
      try {
        composed.workerLoss.reconcileOnBoot(composed.survived)
      } catch (error) {
        failed('delegation.reconcile')(error)
      }
      await lifecycle.sweepOrphans().catch(failed('delegation.sweep'))
    },
    listen: async (listener) => {
      if (server !== null) throw new HostInvariantError('the MCP server listens once')
      if (composed === null) {
        throw new HostInvariantError(
          'the MCP endpoint listens after the delegation endpoint is composed'
        )
      }
      const created = createHandoffMcpDelegationServer(listener, log, composed.handoff, prompts)
      try {
        await created.listen(composed.endpoint)
        server = created
      } catch (error) {
        // 19 §9.3: the endpoint could not be bound; never the error's text (ADR-026). Every
        // stream-json session then asks nobody and its tool uses are denied (fail closed, 15 §2.7),
        // and no parent can delegate: its relay never connects.
        failed('mcp.listen')(error)
      }
    },
    close: async () => {
      for (const stop of stops.splice(0)) stop()
      await server?.close()
    }
  }
}

/** `compose`: the endpoint, the handoff, the subtask run and the routes of 05 §4. */
function composeEndpoint(
  deps: DelegationWiringDeps,
  route: DelegationRouteDeps,
  stores: {
    tokens: SqliteDelegationTokenStore
    tickets: SqliteDelegationTicketStore
  },
  stops: Array<() => void>,
  failed: (event: string) => (error: unknown) => void
): Composed {
  const { clock, ids, hostEpoch, log, transactions } = deps
  const { tokens, tickets } = stores
  // A routing, launch or handoff change wakes the `subtask_result` calls waiting on its ticket. The
  // endpoint is built after the handoff it reads, so the wake-up reaches it by name: it is called
  // only once a delegation changed, long after this function returned.
  const settled = (ticket: string): void => endpoint.delegationSettled(ticket)
  const handoff = new ParentHandoffService({
    tickets,
    deliverer: createParentDeliverer({ conversation: route.conversation.deliverer }),
    // Every v1 relay entry answers tool calls (16 §5.4): no parent needs a turn-input push.
    viaOf: () => 'tool-result',
    parentAlive: (parent) => {
      const view = route.crew.queries.get(parent)
      return view !== null && !view.departed
    },
    transactions,
    bus: route.bus,
    clock,
    ids,
    hostEpoch,
    log,
    settled
  })
  const endpoint = new DelegationEndpointService({
    handoff,
    tokens,
    tickets,
    launches: createDelegationLaunchFacts({
      tokens,
      launching: route.launching.queries,
      crew: route.crew.queries
    }),
    preferences: deps.preferences,
    transactions,
    bus: route.bus,
    clock,
    ids,
    hostEpoch,
    scheduler: route.scheduler
  })
  const subtasks = new SubtaskRunService({
    tickets,
    router: createSubtaskRouter({ jev: route.jev }),
    launcher: createWorkerLauncher({
      launching: route.launching.commands,
      events: route.bus,
      crew: route.crew.queries
    }),
    transactions,
    bus: route.bus,
    clock,
    ids,
    hostEpoch,
    log,
    settled
  })
  const succeeded: Pick<DomainEventBus<DelegationSucceeded>, 'subscribe'> = route.bus
  const turnEnds: Pick<DomainEventBus<TurnEndedEvent>, 'subscribe'> = route.bus
  const delegated: Pick<DomainEventBus<DelegationEndpointEvent>, 'subscribe'> = route.bus
  stops.push(
    // Off the tool call: `delegate` already answered its ticket (S8.01).
    delegated.subscribe('SubtaskDelegated', ({ payload }) => {
      void subtasks.run(payload.delegationId).catch(failed('delegation.route'))
    }),
    // A delegated worker's turn end: its last assistant message is the outcome (lead decision,
    // 2026-09-30), read only for a delegated worker and never logged (NFR-SEC-12).
    turnEnds.subscribe('TurnEnded', ({ payload }) => {
      if (route.crew.queries.get(payload.dwarfId)?.delegated !== true) return
      const last = route.conversation.queries
        .feed(payload.dwarfId)
        .messages.find((message) => message.role === 'dwarf')
      void handoff
        .workerTurnEnded(payload.end, last?.text ?? null)
        .catch(failed('delegation.handoff'))
    }),
    // S8.08: the finished worker walks out once its result reached the parent.
    succeeded.subscribe('DelegationSucceeded', ({ payload }) => {
      void route.crew.ends
        .endDelegated(payload.workerDwarfId, payload.delegationId)
        .catch(failed('delegation.end-worker'))
    }),
    registerDelegationFailed({
      bus: route.bus,
      crew: route.crew.queries,
      conversation: route.conversation.commands,
      log
    })
  )
  const workerLoss = new DelegationWorkerLoss({
    tickets,
    transactions,
    bus: route.bus,
    clock,
    ids,
    hostEpoch,
    settled
  })
  // INV-84: a worker survived when crew still holds it present with a running process; one the
  // recovery listed unrecovered, or whose session closed, did not (07 S2.10).
  const survived = (worker: DwarfId): boolean => {
    const view = route.crew.queries.get(worker)
    return view !== null && !view.departed && view.processState === 'running'
  }
  return { endpoint, handoff, subtasks, workerLoss, survived }
}
