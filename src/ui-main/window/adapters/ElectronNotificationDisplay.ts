// `ElectronNotificationDisplay`: the NotificationDisplay adapter (16 §4.14 row `NotificationDisplay`; 05 §3.14;
// ADR-018 item 7), over Electron's `Notification`. Candidate adapted, not imported: `src/main/notifications/
// electronNotifications.ts` (#316) kept its constructor seam, its per-attempt support check and its "a notification that
// could not be raised costs the notification, never its caller", and is reworked behind the port (ISSUE-113):
// - the notification carries the Host's body (the mine's display name) next to its title (ADR-018 item 9; NFR-PLAT-08);
//   the candidate had a title only;
// - withdrawal is by the Host's key (ADR-018 item 4; 14 B-F23): the adapter keeps a key → notification map privately,
//   one notification per key, which also holds each live notification so its click is not lost to collection; the
//   candidate handed out a handle instead;
// - the Windows Application User Model ID is set here, once, before the first notification is built (ADR-018 item 7;
//   appUserModelId.ts); the candidate left it to app start;
// - failures are logged by event name only (`notification.display`, 19 §9; 13 FM-048), never a title, a body or an
//   error's message (ADR-018 item 9; ADR-026).
// Electron's class and `app.setAppUserModelId` are injected by the composition root, so the adapter is asserted against
// a stubbed constructor and never shows anything on the desktop running the suite.
import type { UiLog, UiLogEntry } from '../../diagnostics/uiLogger'
import type {
  KeyedNotification,
  NotificationDisplay,
  NotificationWithdrawal
} from '../ports/notificationDisplay'
import { APP_USER_MODEL_ID, needsAppUserModelId } from './appUserModelId'
import type { UiPlatform } from './ElectronScreenArea'

/** The slice of an Electron `Notification` this adapter uses. */
export interface NotificationLike {
  show(): void
  close(): void
  on(event: 'click' | 'close' | 'failed', listener: () => void): void
}

/** The slice of Electron's `Notification` class this adapter uses: construct, and ask. */
export interface NotificationConstructorLike {
  new (options: { title: string; body: string }): NotificationLike
  /** Asked before every attempt: on Linux a notification daemon can come and go while the app runs (#316). */
  isSupported(): boolean
}

export interface ElectronNotificationDisplayDeps {
  /** Electron's `Notification` class. */
  notification: NotificationConstructorLike
  platform: UiPlatform
  /** Electron's `app.setAppUserModelId`. */
  setAppUserModelId(id: string): void
  log: UiLog
}

/** The fixed codes of this adapter's `notification.display` records (never content). */
type DisplayCode = 'unsupported' | 'build-threw' | 'failed-event'

export class ElectronNotificationDisplay implements NotificationDisplay, NotificationWithdrawal {
  private readonly open = new Map<string, NotificationLike>()
  private aumidSet = false

  constructor(private readonly deps: ElectronNotificationDisplayDeps) {}

  show(
    n: { title: string; body: string } & Partial<Pick<KeyedNotification, 'key'>>,
    onClick: () => void
  ): void {
    const key = n.key ?? null
    // One OS notification per key: the Host re-sends the standing ones to a notifier that attaches again (14 §2.3).
    if (key !== null && this.open.has(key)) return
    const Notification = this.deps.notification
    if (!Notification.isSupported()) {
      this.record({ level: 'warn', outcome: 'skipped', errCode: 'unsupported' })
      return
    }
    this.ensureAppUserModelId()
    let notification: NotificationLike
    try {
      notification = new Notification({ title: n.title, body: n.body })
      let clicked = false
      notification.on('click', () => {
        if (clicked) return
        clicked = true
        onClick()
      })
      notification.on('close', () => this.forget(key, notification))
      notification.on('failed', () => {
        this.forget(key, notification)
        this.record({ level: 'warn', outcome: 'failed', errCode: 'failed-event' })
      })
      notification.show()
    } catch {
      this.record({ level: 'warn', outcome: 'failed', errCode: 'build-threw' })
      return
    }
    if (key !== null) this.open.set(key, notification)
    this.record({ level: 'debug', outcome: 'ok' })
  }

  close(key: string): void {
    const notification = this.open.get(key)
    if (notification === undefined) return
    this.open.delete(key)
    try {
      notification.close()
    } catch {
      // Already dismissed by the person or retired by the platform: it is not on screen, which is what was asked.
    }
  }

  private ensureAppUserModelId(): void {
    if (this.aumidSet || !needsAppUserModelId(this.deps.platform)) return
    this.deps.setAppUserModelId(APP_USER_MODEL_ID)
    this.aumidSet = true
  }

  /** Drops `key` when it still maps to `notification` (a later notification of the same key stays). */
  private forget(key: string | null, notification: NotificationLike): void {
    if (key !== null && this.open.get(key) === notification) this.open.delete(key)
  }

  private record(entry: Pick<UiLogEntry, 'level' | 'outcome'> & { errCode?: DisplayCode }): void {
    this.deps.log.record({ event: 'notification.display', subsystem: 'window', ...entry })
  }
}
