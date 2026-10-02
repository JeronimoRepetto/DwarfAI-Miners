// The crew module's domain events (08 §0), over the kernel envelope (08 §1.2).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import type { DwarfStatus } from './status'

/** Published only on a change of the derived status (08 §0; ADR-032 item 3). `askedAt` when it becomes `asking`. */
export type DwarfStatusChanged = DomainEvent<
  'DwarfStatusChanged',
  { dwarfId: DwarfId; from: DwarfStatus; to: DwarfStatus; askedAt?: Instant }
>
