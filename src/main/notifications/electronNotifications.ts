import { Notification } from 'electron'
import type { OpenNotification, ShownNotification, SystemNotificationPort } from './notificationPort'

/**
 * The one implementation of SystemNotificationPort, over Electron's
 * `Notification` (#316).
 *
 * The constructor is a PARAMETER defaulting to the real class, which is what
 * makes the wiring assertable without a notification centre: the support check,
 * the click subscription and the withdrawal are this app's decisions, and only
 * Electron's own behaviour is left unverified. That split is the one
 * `platform-ports` asks for — a testable value, and a thin runner over it.
 *
 * Per-OS behaviour is recorded on the port's own doc comment rather than
 * repeated here; the one thing this file does NOT own is the Windows
 * Application User Model ID, which belongs to app startup (main/index.ts).
 */

/** The slice of an Electron notification this app uses. Narrow on purpose. */
export interface NotificationLike {
  show: () => void
  close: () => void
  on: (event: 'click', listener: () => void) => void
}

/** The slice of the `Notification` CLASS this app uses: construct, and ask. */
export interface NotificationConstructorLike {
  new (options: { title: string }): NotificationLike
  isSupported: () => boolean
}

export interface ElectronNotificationsOptions {
  /** Injected for tests; defaults to Electron's own class. */
  notification?: NotificationConstructorLike
}

export function createElectronNotifications(
  options: ElectronNotificationsOptions = {}
): SystemNotificationPort {
  const Constructor = options.notification ?? Notification

  function show(notification: ShownNotification): OpenNotification | null {
    // Asked here rather than by the caller so that no route to the OS can skip
    // it, and asked EVERY time because the answer can change under a running
    // app — see SystemNotificationPort.isSupported.
    if (!Constructor.isSupported()) return null
    try {
      const raised = new Constructor({ title: notification.title })
      raised.on('click', notification.onClick)
      raised.show()
      return { close: () => raised.close() }
    } catch {
      // A notification that could not be raised costs the notification, never
      // the poll that asked for it: this runs inside the publish path that
      // feeds both renderer windows.
      return null
    }
  }

  return { isSupported: () => Constructor.isSupported(), show }
}
