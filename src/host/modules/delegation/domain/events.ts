// The public events of the delegation module this issue publishes (08 §0, §1; 16 §4.8). Published
// after commit (16 §2.3). More of 08's delegation events arrive with the endpoint (ISSUE-199).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId } from '../../../kernel/domain/values'
import type { DelegationFailure, DelegationHandoff, DelegationId } from './delegation'

/** 08 `DelegationFailed`: no chat line for `parent-gone` (08 §2.8, PO #45). */
export type DelegationFailed = DomainEvent<
  'DelegationFailed',
  { delegationId: DelegationId; parentDwarfId: DwarfId; failure: DelegationFailure }
>

/** 08 `DelegationWorkerLaunched` (S8.03; no frame: the worker's `DwarfLaunched` drives the UI). */
export type DelegationWorkerLaunched = DomainEvent<
  'DelegationWorkerLaunched',
  { delegationId: DelegationId; workerDwarfId: DwarfId }
>

/**
 * 08 `DelegationSucceeded` (S8.08): the handoff reached `delivered` (INV-68). No frame, no line, no
 * toast (PO #19, 14 §2.4). `workerDwarfId` is the worker its route ends (05 §4; 16 O-16-12: carried
 * here instead of read back from `DelegationWorkerLaunched`); `via` is the handoff's route. It
 * never carries the result text (NFR-SEC-12).
 */
export type DelegationSucceeded = DomainEvent<
  'DelegationSucceeded',
  {
    delegationId: DelegationId
    parentDwarfId: DwarfId
    workerDwarfId: DwarfId
    via: DelegationHandoff['via']
  }
>

/** Every event the delegation lifecycle publishes. */
export type DelegationLifecycleEvent = DelegationFailed
