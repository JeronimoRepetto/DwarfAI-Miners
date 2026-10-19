// `TransportLevel3Sink` (16 §4.11 adapter of attention's driven port `Level3Sink`; 05 §3.11): a
// level-3 decision leaves the Host as a seam-B frame to the tray notifier connection that Electron
// main holds for its whole life (ADR-003 item 12; ADR-018 item 5; 14 B-F22, B-F23).
//
// - `notify` publishes `attention.notify` (`OsNotification`, sensitive) and answers `'delivered'`
//   when a `notifier` connection is attached, else `'no-ui'` and nothing is published: the policy
//   keeps the notification while its fact stands (16 §4.11 row `Level3Sink`).
// - `withdraw` publishes `attention.withdraw {keys}`.
// - The audience is the frames' 14 §2.4 row in roles.ts (`notifier` only), never restated here, so
//   no `ui` or `viewer` connection receives either frame (14 §6.5 "Roles").
// - The payload is never logged (14 §3.5 SENSITIVE_FRAMES, §1.10; ADR-018 item 9): the publisher
//   numbers and writes frames and logs no data.
//
// `registerNotifierAttached` hands each attaching `notifier` connection to the policy, which sends
// it every standing notification (14 §2.3: no replay for the notifier; 07 S12.C03). The
// composition root wires both (later: ISSUE-119).
//
// Spike S-018-1 (a windowless tray process drawing on Windows 11, macOS, the Linux desktops) gates
// only the drawing side (ISSUE-113): the Host sends to the `notifier` connection on every OS
// (21 §9), so nothing here switches per OS.
import type { Attention, Level3Sink, OsNotification } from '../../modules/attention'
import type { ConnectionRegistry } from '../connectionRegistry'

export class TransportLevel3Sink implements Level3Sink {
  constructor(
    private readonly connections: Pick<ConnectionRegistry, 'connections' | 'publishFrame'>
  ) {}

  notify(n: OsNotification): 'delivered' | 'no-ui' {
    if (!this.connections.connections().some((c) => c.role === 'notifier')) return 'no-ui'
    this.connections.publishFrame('attention.notify', n)
    return 'delivered'
  }

  withdraw(keys: readonly string[]): void {
    this.connections.publishFrame('attention.withdraw', { keys: [...keys] })
  }
}

/** Routes each `notifier` attach to `attention.notifierAttached`; returns the unsubscribe. */
export function registerNotifierAttached(
  connections: Pick<ConnectionRegistry, 'onAttach'>,
  attention: Pick<Attention, 'notifierAttached'>
): () => void {
  return connections.onAttach((connection) => {
    if (connection.role === 'notifier') attention.notifierAttached()
  })
}
