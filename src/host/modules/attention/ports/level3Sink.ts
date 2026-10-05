// Driven port (05 §3.11, 16 §4.11): where a level-3 decision leaves the Host. The adapter
// (`TransportLevel3Sink`, host/transport/attention) frames `attention.notify` / `attention.withdraw`
// to the `notifier` connection only (ADR-003 item 12; 14 B-F22, B-F23); the UI process draws
// (ADR-018 item 7). `'no-ui'` = no `notifier` connection is attached: the policy keeps the
// notification while its fact stands and sends it when one attaches (14 §2.3 "Notifier scope").
import type { OsNotification } from '../domain/decideLevel3'

export interface Level3Sink {
  // driven → transport frames attention.notify / attention.withdraw
  notify(n: OsNotification): 'delivered' | 'no-ui' // ADR-018 OsNotification (sensitive)
  withdraw(keys: readonly string[]): void
}
