// The level-3 notification presenter of UI main (ISSUE-113; ADR-018 items 4, 5, 7, 9; 05 §3.14 "the window module
// displays what the Host decided"): the `notifier` connection's `attention.notify` / `attention.withdraw` frames (14
// B-F22, B-F23), received through HostClient for the process's whole life, are drawn through the NotificationDisplay
// port.
//
// - `attention.notify` is shown with its `title` and `body` unchanged: the Host already put the PO #44 title with the
//   dwarf's `customName ?? baseName` and the mine's display name in them (ADR-018 item 9; NFR-PLAT-08; ISSUE-109).
//   UI main formats nothing and decides nothing (the Host decides, ADR-018 item 1).
// - `attention.withdraw {keys}` closes the notifications of those keys where the platform allows (ADR-018 item 4).
// - The same process draws with a window open and in tray mode (ADR-018 item 5), except on an OS whose S-018-1 has not
//   passed: there the notification is drawn only while a window is open, and one arriving with none is dropped and
//   logged by event name (21 §9 cut 1 entry, the documented fallback; R-16 lists it; trayNotificationGate.ts).
// - A click is a placeholder until the reveal lands (later: ISSUE-114): it logs the event name only.
// - Logging (ADR-026; 19 §9 `notification.display`; 13 FM-048): event name, outcome and a fixed code, never a title,
//   a body, a name or an error's message. A display failure never throws into the connection that delivered the frame.
import type { HostFrameData } from '@dwarfai/contracts'
import type { UiLog, UiLogEntry } from '../../diagnostics/uiLogger'
import type { AttentionFrame } from '../ports/hostClient'
import type {
  KeyedNotification,
  NotificationDisplay,
  NotificationWithdrawal
} from '../ports/notificationDisplay'

export type { AttentionFrame }

export interface NotificationPresenterDeps {
  /** HostClient's `notifier` frames `attention.notify` / `attention.withdraw`; returns the unsubscribe. */
  onAttentionFrame(handler: (frame: AttentionFrame) => void): () => void
  display: NotificationDisplay & NotificationWithdrawal
  /** S-018-1 passed on this OS: this process draws with no window open (window/domain/trayNotificationGate.ts). */
  drawsWithoutWindow: boolean
  /** Whether a mode window is open (shown) now. */
  anyWindowOpen(): boolean
  log: UiLog
}

export interface NotificationPresenter {
  dispose(): void
}

/** The fixed codes of the `notification.display` records this presenter writes (19 §9; never content). */
type PresenterCode = 'window-only' | 'show-threw' | 'close-threw'

export function startNotificationPresenter(deps: NotificationPresenterDeps): NotificationPresenter {
  const record = (
    entry: Pick<UiLogEntry, 'level' | 'outcome'> & {
      errCode?: PresenterCode
      causeClass?: 'clicked'
    }
  ): void => deps.log.record({ event: 'notification.display', subsystem: 'window', ...entry })

  const onClick = (): void => {
    // Placeholder until the reveal lands (later: ISSUE-114).
    record({ level: 'debug', outcome: 'ok', causeClass: 'clicked' })
  }

  const notify = (n: HostFrameData['attention.notify']): void => {
    if (!deps.drawsWithoutWindow && !deps.anyWindowOpen()) {
      record({ level: 'debug', outcome: 'skipped', errCode: 'window-only' })
      return
    }
    try {
      // The key rides next to the title and body (the port's `n`), so the adapter can withdraw by it.
      const shown: KeyedNotification = { key: n.key, title: n.title, body: n.body }
      deps.display.show(shown, onClick)
    } catch {
      record({ level: 'warn', outcome: 'failed', errCode: 'show-threw' })
    }
  }

  const withdraw = (keys: readonly string[]): void => {
    for (const key of keys) {
      try {
        deps.display.close(key)
      } catch {
        record({ level: 'warn', outcome: 'failed', errCode: 'close-threw' })
      }
    }
  }

  const unsubscribe = deps.onAttentionFrame((frame) => {
    if (frame.name === 'attention.notify') notify(frame.data)
    else withdraw(frame.data.keys)
  })
  return { dispose: unsubscribe }
}
