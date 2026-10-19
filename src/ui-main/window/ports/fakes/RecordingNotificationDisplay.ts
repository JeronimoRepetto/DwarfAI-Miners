// The NotificationDisplay double (16 §4.14 table): records every notification shown and every one closed, and lets a
// test click one. It keeps one notification per key, as the adapter does, and runs the same contract suite
// (testing/notificationDisplay.contract.ts; 17 §1.3). Never imported by production code (R14).
import type {
  KeyedNotification,
  NotificationDisplay,
  NotificationWithdrawal
} from '../notificationDisplay'

/** One notification the double was asked to draw. */
export interface RecordedNotification {
  key: string | null
  title: string
  body: string
}

interface OnScreen {
  readonly notification: RecordedNotification
  readonly click: () => void
}

export class RecordingNotificationDisplay implements NotificationDisplay, NotificationWithdrawal {
  /** Every notification drawn, in order. */
  readonly shown: RecordedNotification[] = []
  /** Every key closed while its notification was on screen, in order. */
  readonly closed: string[] = []
  private readonly open = new Map<string, OnScreen>()

  show(
    n: { title: string; body: string } & Partial<Pick<KeyedNotification, 'key'>>,
    onClick: () => void
  ): void {
    const key = n.key ?? null
    if (key !== null && this.open.has(key)) return
    const notification = { key, title: n.title, body: n.body }
    this.shown.push(notification)
    if (key === null) return
    let clicked = false
    this.open.set(key, {
      notification,
      click: () => {
        if (clicked) return
        clicked = true
        onClick()
      }
    })
  }

  close(key: string): void {
    if (!this.open.delete(key)) return
    this.closed.push(key)
  }

  /** The person clicks the notification on screen under `key`; false when there is none. */
  click(key: string): boolean {
    const onScreen = this.open.get(key)
    if (onScreen === undefined) return false
    onScreen.click()
    return true
  }

  /** The keys of the notifications on screen. */
  openKeys(): string[] {
    return [...this.open.keys()]
  }

  /** The notifications on screen, in the order they were drawn. */
  onScreen(): RecordedNotification[] {
    const open = new Set([...this.open.values()].map((s) => s.notification))
    return this.shown.filter((n) => open.has(n))
  }
}
