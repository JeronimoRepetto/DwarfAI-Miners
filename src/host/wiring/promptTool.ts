// Claude's permission prompt tool, composed (AMENDMENT-21, owner-approved 2026-10-17; ADR-010
// items 1, 5; ADR-013 item 3; 16 §5.4, §8.2; ISSUE-182, forward note b of #1384): what the
// composition root builds so the Claude stream-json driver can be attached.
//
// - Module delegation's lifecycle over its SQLite token and ticket stores and the owner-only
//   credential files (`RunDirCredentialFileStore`, `<hostDataDir>/run/mcp/`): every stream-json
//   launch is issued a hash-only token row and a credential FILE (`issuePromptRelay`), released
//   when the launch fails to start, and re-served to a restarted Host's resume of the launch's
//   session while its token is live (bridges/promptToolRelay.ts `reissue`).
// - The routes of a token's life (16 §4.8 rows): `DwarfLaunched` → `bindParent` (the launch's dwarf
//   becomes its token's parent, so the boot sweep keeps it for a resume), `DwarfDeparted` →
//   `revokeFor` (its token is revoked and its file deleted: a live row is a live session, 16 §5.7).
//   `sweepOrphans` runs at boot once the Host recovery classified (after the ADR-015 reconcile).
// - The `PermissionPromptBridge` (bridges/permissionPromptBridge.ts): the driver registers each
//   session under its launch; the MCP server's `permission` tool reaches only the session of the
//   connection's own launch, and every ask goes to the single ask broker through the driver's
//   `ask.opened` (channel `driver`).
// - The MCP server (`createMcpDelegationServer`) listens at boot step 6 on the listener the root
//   passes (`createMcpEndpoint`, the owner-only pipe or socket of ADR-013 item 3). An ungated
//   session's relay lists `permission` only. The two delegation tools need the delegation endpoint
//   (later: ISSUE-209); until then no launch is gated in (`issueFor` is not called), and a delegation
//   call that still reached the Host is refused (`gate-closed`; an unknown ticket for a result).
import { join } from 'node:path'
import type { DwarfId, HostEpoch, LaunchId } from '../kernel/domain/values'
import { HostInvariantError } from '../kernel/domain/errors'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../kernel/ports/domainEventBus'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import type { DwarfDeparted } from '../modules/crew'
import {
  createDelegationLifecycle,
  createMcpDelegationServer,
  toolFailure,
  type DelegationEndpoint,
  type DelegationLifecycleEvent,
  type DelegationRelayListener,
  type DelegationServer,
  type DelegationTokenStore,
  type SubtaskToolFailure
} from '../modules/delegation'
import { RunDirCredentialFileStore } from '../modules/delegation/adapters/fs/RunDirCredentialFileStore'
import { relayEntryArgs } from '../modules/delegation/adapters/mcp/relay/relayEntry'
import { SqliteDelegationTicketStore } from '../modules/delegation/adapters/sqlite/SqliteDelegationTicketStore'
import { SqliteDelegationTokenStore } from '../modules/delegation/adapters/sqlite/SqliteDelegationTokenStore'
import type { DwarfLaunched } from '../modules/launching'
import type { CredentialMinter, PreferencesQueries } from '../modules/preferences'
import type { CliDriverDeps } from '../modules/suppliers'
import type { McpConfigFiles } from '../modules/suppliers/adapters/drivers/claude-stream-json/mcpConfigFile'
import type { EndpointFacts } from '../platform/endpoint/nodeEndpointEnv'
import type { Scheduler } from '../kernel/ports/scheduler'
import { HelloThrottle } from '../transport/auth/throttle'
import { EndpointBindError } from '../transport/endpoint/server'
import type { ListenOwnerOnlyPipe } from '../transport/endpoint/windowsPipeSecurity'
import type { HostIdentity } from '../transport/hello'
import { createMcpEndpoint } from '../transport/mcpEndpoint/mcpEndpoint'
import { mcpEndpointFor } from '../transport/mcpEndpoint/mcpEndpointPath'
import type { HostStateReport } from './boot'
import { errorCode } from './boot'
import { PermissionPromptBridge } from './bridges/permissionPromptBridge'
import { createPromptToolRelay } from './bridges/promptToolRelay'

export interface PromptToolWiringDeps {
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
  /** "Subagent delegation" (06 §14.2), read at each `issueFor`. */
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

export interface WiredPromptTool {
  /** The token rows, for the MCP endpoint's authentication (`mcpEndpointListener`). */
  readonly tokens: Pick<DelegationTokenStore, 'byLaunch'>
  /** `CliDriverDeps.claudeStreamJson`: what attaches the stream-json driver. */
  readonly driver: NonNullable<CliDriverDeps['claudeStreamJson']>
  /** The `PermissionPromptEndpoint` the MCP server serves `permission` through. */
  readonly prompts: PermissionPromptBridge
  /** Boot step 5, after the Host recovery classified: the ADR-015 sweep of the tokens. */
  sweepOrphans(): Promise<void>
  /** Boot step 6: the MCP server listens on `listener`; a failure is logged, never fatal. */
  listen(listener: DelegationRelayListener): Promise<void>
  /** The clean exit: the routes unsubscribed and the server closed. */
  close(): Promise<void>
}

/** The delegation tools' handler until the delegation endpoint is composed (later: ISSUE-209). */
const DELEGATION_NOT_COMPOSED: DelegationEndpoint = {
  delegate: () => Promise.resolve({ ok: false, error: 'gate-closed' }),
  result: () => {
    const failure = toolFailure('unknown-ticket')
    if (failure === null) throw new HostInvariantError('an unknown ticket has a tool failure')
    return Promise.resolve({ status: 'failed', failure: failure as SubtaskToolFailure })
  }
}

export function wirePromptTool(deps: PromptToolWiringDeps): WiredPromptTool {
  const { db, log } = deps
  const tokens = new SqliteDelegationTokenStore(db)
  const files = new RunDirCredentialFileStore({ hostDataDir: deps.hostDataDir })
  const relay = { program: deps.execPath, args: relayEntryArgs(deps.hostEntryPath) }
  const lifecycle = createDelegationLifecycle({
    tokens,
    tickets: new SqliteDelegationTicketStore(db),
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
  const prompts = new PermissionPromptBridge()
  const failed = (event: string) => (error: unknown) =>
    log.record({
      level: 'warn',
      event,
      subsystem: 'delegation',
      outcome: 'failed',
      errCode: errorCode(error)
    })
  const stops = [
    deps.bus.subscribe('DwarfLaunched', ({ payload }) =>
      lifecycle.bindParent(payload.launchId as LaunchId, payload.dwarfId as DwarfId)
    ),
    deps.bus.subscribe('DwarfDeparted', ({ payload }) => {
      void lifecycle.revokeFor(payload.dwarfId).catch(failed('delegation.revoke'))
    })
  ]
  let server: DelegationServer | null = null
  return {
    driver: {
      mcpConfig: { dir: join(deps.hostDataDir, 'run', 'mcp'), files: deps.mcpConfigFiles },
      promptTool: {
        sessions: prompts,
        relay: createPromptToolRelay({
          lifecycle,
          tokens,
          files,
          relay,
          hostDataDir: deps.hostDataDir
        })
      }
    },
    prompts,
    tokens,
    sweepOrphans: async () => {
      await lifecycle.sweepOrphans().catch(failed('delegation.sweep'))
    },
    listen: async (listener) => {
      if (server !== null) throw new HostInvariantError('the MCP server listens once')
      const created = createMcpDelegationServer(listener, log, prompts)
      try {
        await created.listen(DELEGATION_NOT_COMPOSED)
        server = created
      } catch (error) {
        // 19 §9.3: the endpoint could not be bound; never the error's text (ADR-026). Every
        // stream-json session then asks nobody and its tool uses are denied (fail closed, 15 §2.7).
        failed('mcp.listen')(error)
      }
    },
    close: async () => {
      for (const stop of stops.splice(0)) stop()
      await server?.close()
    }
  }
}
