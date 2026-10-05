// The observation module's public events built so far (08 §0, §2.3; 05 §3.3), over the kernel
// envelope (08 §1.2). Internal only, never a frame. Each is published after the transaction of its
// batch committed (16 §2.3, §4.3 "Ordering"). Here, not in `domain/`, because two payloads carry
// suppliers' `ConversationEntry` / `UsageObservation` and the domain imports no other module (R1).
//
// Turn ends joined with the Codex adapter (ISSUE-073). The asks, subagents and provider errors of
// 05 §3.3 join with the provider adapters that observe them (later: ISSUE-071…ISSUE-075,
// ISSUE-084).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { FolderPath, Instant, ProviderIdentity } from '../../../kernel/domain/values'
import type { ConversationEntry, SourceKey, UsageObservation } from '../../suppliers'

/** A session the observer saw (08 §0). Routed to `mines.resolveForSession` → `crew.arrive` (05 §4). */
export type SessionObserved = DomainEvent<
  'SessionObserved',
  {
    identity: ProviderIdentity
    cwd: FolderPath
    parentIdentity?: ProviderIdentity
    firstMessage?: boolean
    streamId: string
  }
>

/** A record of a session (08 §0; 08 §1.1 names it, not 05's `SessionActivity`). */
export type SessionActivityObserved = DomainEvent<
  'SessionActivityObserved',
  { identity: ProviderIdentity; sourceKey: SourceKey; at: Instant; kind: 'record' | 'turn-started' }
>

/** Entries of a batch, already written through `ObservedBatchSink` (AMENDMENT-10). */
export type TranscriptEntriesObserved = DomainEvent<
  'TranscriptEntriesObserved',
  { identity: ProviderIdentity; entries: ConversationEntry[] }
>

/** One usage observation of a batch, already written through `ObservedBatchSink` (AMENDMENT-10). */
export type UsageObserved = DomainEvent<'UsageObserved', { observation: UsageObservation }>

/** The provider closed the session (08 §0). Routed to `crew.sessionClosed` (05 §4). */
export type SessionClosedObserved = DomainEvent<
  'SessionClosedObserved',
  { identity: ProviderIdentity; at: Instant }
>

/**
 * A turn end the provider recorded (08 §0; ADR-021 item 1), stamped with the dwarf. Routed to
 * conversation `recordTurnEnd`, which publishes `TurnEnded` once per turn key (AMENDMENT-10).
 */
export type ObservedTurnEnded = DomainEvent<
  'ObservedTurnEnded',
  { identity: ProviderIdentity; end: TurnEnded }
>

/** Every event the module publishes so far. */
export type ObservationEvent =
  | SessionObserved
  | SessionActivityObserved
  | TranscriptEntriesObserved
  | UsageObserved
  | SessionClosedObserved
  | ObservedTurnEnded
