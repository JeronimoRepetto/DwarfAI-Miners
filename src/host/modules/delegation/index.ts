// The delegation module's public surface (05 §2.2). ISSUE-208 adds its first export: the module's
// step of the Reset-metrics saga (ADR-023; 09 §7.2).
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { McpDelegationServer } from './adapters/mcp/McpDelegationServer'
import { DelegationResetStep } from './adapters/sqlite/DelegationResetStep'
import type { DelegationRelayListener, DelegationServer } from './ports/delegationServer'
import type { PermissionPromptEndpoint } from './ports/permissionPrompt'

// ISSUE-199: what host/transport's MCP endpoint and the composition root need of the endpoint.
export type { DelegationToken, DelegationTokenStore } from './ports/delegationStores'
export type {
  DelegationEndpoint,
  DelegationLaunchFacts,
  DelegationRelayConnection,
  DelegationRelayListener,
  DelegationServer,
  LoopbackEndpoint,
  ParentDeliverer,
  SubtaskOutcome,
  SubtaskResultView,
  SubtaskToolFailure
} from './ports/delegationServer'
export { DELEGATION_WAIT_MS } from './ports/delegationServer'
// AMENDMENT-21: the permission prompt tool's port, its call, and the stream-json relay issuer.
export type { PermissionPromptEndpoint } from './ports/permissionPrompt'
export type { PermissionPromptCall } from './domain/permissionPrompt'
export type {
  DelegationLifecycle,
  PermissionPromptRelayIssuer
} from './application/delegationLifecycle'

/** Structurally the preferences module's `ResetDbStep` (16 §4.12); delegation never imports it. */
export interface DelegationResetDbStep {
  readonly name: string
  reset(tx: TransactionRunner): void
}

/** `name: 'delegation'`; registered with the saga by host/wiring/resetParticipants.ts (ISSUE-208). */
export function createDelegationResetStep(deps: {
  db: SqliteDatabase
  scope: TransactionScope
}): DelegationResetDbStep {
  return new DelegationResetStep(deps)
}

export {
  DelegationEndpointService,
  DelegationLaunchClosedError,
  type DelegationEndpointDeps,
  type DelegationEndpointEvent,
  type SubtaskDelegated
} from './application/delegationEndpoint'

/**
 * The Jev delegation MCP server over the MCP endpoint (16 §4.8; composed by ISSUE-209). With
 * `prompts`, it also serves Claude's `permission` tool to an owned stream-json session's relay
 * (AMENDMENT-21).
 */
export function createMcpDelegationServer(
  listener: DelegationRelayListener,
  log: DiagnosticsLog,
  prompts?: PermissionPromptEndpoint
): DelegationServer {
  return new McpDelegationServer(listener, log, prompts)
}
