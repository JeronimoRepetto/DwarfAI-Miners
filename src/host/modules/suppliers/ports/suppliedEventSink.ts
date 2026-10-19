// Where a driver event goes once it leaves suppliers (05 §4 routes: `DriverEntriesReceived`,
// `DriverAskOpened`, `DriverTurnEnded`, … of 08 §4; implemented by `host/wiring`). Every event
// that leaves carries the dwarf bound to its session, and the driver-side payloads that omit the
// dwarf are completed (ADR-009 D3 as amended 2026-10-02; 15 §1.2 `UsageObservationInput`).
// Type-only (R2).
import type { TurnEnded, UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../kernel/domain/values'
import type { DriverEvent, SessionRef } from './providerDriver'

/** A driver event as the rest of the Host sees it: `turn.ended` and `usage` carry the dwarf. */
export type SuppliedEvent =
  | Exclude<DriverEvent, { t: 'turn.ended' } | { t: 'usage' }>
  | { t: 'turn.ended'; end: TurnEnded }
  | { t: 'usage'; observation: UsageObservation }

export interface SuppliedEventDelivery {
  readonly dwarfId: DwarfId
  readonly ref: SessionRef
  readonly event: SuppliedEvent
}

export interface SuppliedEventSink {
  /** Per session FIFO, in the driver's order (15 §1.4). */
  deliver(delivery: SuppliedEventDelivery): void
}
