// The delegation module's public surface (05 §2.2). ISSUE-208 adds its first export: the module's
// step of the Reset-metrics saga (ADR-023; 09 §7.2).
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { DelegationResetStep } from './adapters/sqlite/DelegationResetStep'

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
  SubtaskResultView
} from './ports/delegationServer'
export { DELEGATION_WAIT_MS } from './ports/delegationServer'

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
