// The delegation module's public surface (05 §2.2). ISSUE-208 adds its first export: the module's
// step of the Reset-metrics saga (ADR-023; 09 §7.2).
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { McpDelegationServer } from './adapters/mcp/McpDelegationServer'
import { DelegationResetStep } from './adapters/sqlite/DelegationResetStep'
import type {
  DelegationHandoffReport,
  DelegationRelayListener,
  DelegationServer
} from './ports/delegationServer'
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
  prompts?: PermissionPromptEndpoint,
  handoffs?: DelegationHandoffReport
): DelegationServer {
  return new McpDelegationServer(listener, log, prompts, handoffs)
}

// ISSUE-182 (coordinator ruling on #1413), appended: the lifecycle the composition root builds for
// the relay of Claude's permission prompt tool (AMENDMENT-21), and the tool failure of a delegation
// tool call that reaches a Host whose delegation endpoint is not composed yet (later: ISSUE-209).
import { DelegationLifecycleService } from './application/delegationLifecycle'
import type {
  DelegationLifecycle,
  DelegationLifecycleDeps,
  PermissionPromptRelayIssuer
} from './application/delegationLifecycle'

export type { DelegationLifecycleDeps } from './application/delegationLifecycle'
export { toolFailure } from './domain/toolFailure'

/** 16 §4.8 `DelegationLifecycle` (AMENDMENT-14) with AMENDMENT-21's prompt-tool relay issuer. */
export function createDelegationLifecycle(
  deps: DelegationLifecycleDeps
): DelegationLifecycle & PermissionPromptRelayIssuer {
  return new DelegationLifecycleService(deps)
}

// ISSUE-204: the routing and launch bridges' ports, and the `SubtaskDelegated` route.
export type { SubtaskRouter, WorkerLauncher } from './ports/subtaskRouting'
export type {
  DelegationFailed,
  DelegationLifecycleEvent,
  DelegationWorkerLaunched
} from './domain/events'
export {
  SubtaskRunService,
  type SubtaskRunDeps,
  type SubtaskRunEvent
} from './application/subtaskRun'

// ISSUE-205: the invisible result handoff (16 §5.4 "Handoff"; ADR-013 item 6; 07 S8.08), its event,
// and the MCP server that reports each `done` answer's flush to it (composed by ISSUE-209).
export type { DelegationSucceeded } from './domain/events'
export type { DelegationHandoffReport } from './ports/delegationServer'
export {
  ParentHandoffService,
  type HandoffDeps,
  type HandoffEvent,
  type ToolResultHandoff
} from './application/handoff'

/** `createMcpDelegationServer` whose `done` answers are reported to the handoff once flushed. */
export function createHandoffMcpDelegationServer(
  listener: DelegationRelayListener,
  log: DiagnosticsLog,
  handoffs: DelegationHandoffReport,
  prompts?: PermissionPromptEndpoint
): DelegationServer {
  return new McpDelegationServer(listener, log, prompts, handoffs)
}

// ISSUE-206: the parent's one chat line for a failed delegation (US-DLG-005; 08 §2.8), written by
// host/wiring's `DelegationFailed` route.
export {
  delegationFailedLineKey,
  delegationFailedLineText,
  parentFailureLine,
  type ParentFailureLine
} from './application/failureLine'
