// The `SuppliedEventSink` double (16 §2.8 `Recording<Port>`): keeps every delivery in order.
import type { SuppliedEventDelivery, SuppliedEventSink } from '../suppliedEventSink'

export class RecordingSuppliedEventSink implements SuppliedEventSink {
  readonly deliveries: SuppliedEventDelivery[] = []

  deliver(delivery: SuppliedEventDelivery): void {
    this.deliveries.push(delivery)
  }
}
