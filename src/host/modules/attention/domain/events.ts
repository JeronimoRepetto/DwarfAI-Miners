// The public events of the attention module (08 §0, §1; 16 §4.11). Published after commit (16 §2.3).
// `AttentionNotified` carries a sensitive `OsNotification` (ADR-018 item 9): never logged (ADR-026).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { AttentionKind, OsNotification } from './decideLevel3'

/** 08 `AttentionNotified`: one per key (INV-100). */
export type AttentionNotified = DomainEvent<
  'AttentionNotified',
  {
    key: string
    dwarfId: DwarfId
    mineId: MineId
    kind: AttentionKind
    notification: OsNotification
  }
>

/** 08 `AttentionWithdrawn`: the keys of a fact that ended (ADR-018 item 4), once each. */
export type AttentionWithdrawn = DomainEvent<'AttentionWithdrawn', { keys: string[] }>

/** Every event this module publishes in cut 1. */
export type AttentionEvent = AttentionNotified | AttentionWithdrawn
