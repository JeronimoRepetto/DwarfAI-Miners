// The observation module's public events built so far (08 §0, §2.3; 05 §3.3), over the kernel
// envelope (08 §1.2). Internal only, never a frame. Each is published after the transaction of its
// batch committed (16 §2.3, §4.3 "Ordering"). Here, not in `domain/`, because two payloads carry
// suppliers' `ConversationEntry` / `UsageObservation` and the domain imports no other module (R1).
//
// Turn ends joined with the Codex adapter (ISSUE-073), provider errors with ISSUE-084. The asks and
// subagents of 05 §3.3 join with the provider adapters that observe them (later: ISSUE-071…ISSUE-075).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type {
  DwarfId,
  FolderPath,
  Instant,
  ProviderId,
  ProviderIdentity
} from '../../../kernel/domain/values'
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

/**
 * A provider of an observed session errored or became unreadable (08 §0; 13 FM-067, FM-068), once
 * per `(providerId, cause, dwarfId?)` and poll cycle (08 §2.3). The payload is 08 §0's verbatim
 * (`cause: string`, as 14 §3.6 `HostToast` carries it); the loop only ever publishes one of the
 * typed `ProviderErrorCause` values of domain/providerError.ts, never the provider's text (16 §2.1). Routed to diagnostics and the transport's `toast {kind:
 * 'provider-error'}` (05 §4; 14 §2.4 B-F28); the dwarf's status does not change (US-RES-004.AC02).
 */
export type ProviderErrorObserved = DomainEvent<
  'ProviderErrorObserved',
  { providerId: ProviderId; cause: string; dwarfId?: DwarfId }
>

/** Every event the module publishes so far. */
export type ObservationEvent =
  | SessionObserved
  | SessionActivityObserved
  | TranscriptEntriesObserved
  | UsageObserved
  | SessionClosedObserved
  | ObservedTurnEnded
  | ProviderErrorObserved
