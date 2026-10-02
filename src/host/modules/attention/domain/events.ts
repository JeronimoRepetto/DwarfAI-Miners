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

/** Every event this module publishes in cut 1; `AttentionWithdrawn` joins with ISSUE-110. */
export type AttentionEvent = AttentionNotified
