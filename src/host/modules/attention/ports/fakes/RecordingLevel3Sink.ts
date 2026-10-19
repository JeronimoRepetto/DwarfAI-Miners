// The Level3Sink double (16 §4.11 `RecordingLevel3Sink`). Never imported by production code (R14).
// It records every call in order; a test attaches or detaches the notifier it stands for with
// `attached`, which decides `'delivered'` or `'no-ui'` (16 §4.11 row `Level3Sink`).
import type { OsNotification } from '../../domain/decideLevel3'
import type { Level3Sink } from '../level3Sink'

export type Level3SinkCall =
  | { call: 'notify'; notification: OsNotification; outcome: 'delivered' | 'no-ui' }
  | { call: 'withdraw'; keys: readonly string[] }

export class RecordingLevel3Sink implements Level3Sink {
  readonly calls: Level3SinkCall[] = []

  constructor(public attached = true) {}

  notify(n: OsNotification): 'delivered' | 'no-ui' {
    const outcome = this.attached ? 'delivered' : 'no-ui'
    this.calls.push({ call: 'notify', notification: n, outcome })
    return outcome
  }

  withdraw(keys: readonly string[]): void {
    this.calls.push({ call: 'withdraw', keys: [...keys] })
  }

  /** The keys handed to `notify`, in order. */
  notifiedKeys(): string[] {
    return this.calls.flatMap((c) => (c.call === 'notify' ? [c.notification.key] : []))
  }
}
