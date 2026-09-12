/**
 * The OS notification centre, as the one question this app asks of it (#316).
 *
 * A types-only module, exactly like `TextDeliveryPort`: nothing here imports
 * Electron, so the notifier and its whole rule set are assertable on a host
 * with no notification centre at all. `electronNotifications.ts` is the single
 * implementation and `main/index.ts` the single place it is composed.
 *
 * ## What each platform does with this, and what is actually verified
 *
 * Only Windows has been checked live on this machine; the other two are read
 * from Electron's own contract and are recorded here rather than in a comment
 * somewhere a reader would have to find.
 *
 * - **Windows** — a notification from a DEV build needs an Application User
 *   Model ID, or the Action Center silently drops it. `app.setAppUserModelId`
 *   is called once at startup (see main/index.ts); a packaged build gets one
 *   from its shortcut, which is why the omission only bites in development.
 * - **macOS** — nothing shows until the user has allowed the app once, and the
 *   system asks them on the first attempt. There is no API to ask beforehand
 *   and no answer to read afterwards, so a first notification that nobody sees
 *   is the expected behaviour, not a failure to report.
 * - **Linux** — depends on a notification daemon being present. Where there is
 *   none, `isSupported()` answers false and this app says nothing about it: an
 *   error banner for a facility the desktop does not have would be noise the
 *   person cannot act on.
 */

/** One notification the platform is holding on screen. */
export interface OpenNotification {
  /**
   * Withdraw it, because the fact it announced is gone.
   *
   * May throw or do nothing: the person may have dismissed it already, and a
   * platform is free to have retired it on its own. The caller treats every
   * one of those as "it is no longer on screen", which is the outcome asked
   * for either way.
   */
  close: () => void
}

/** A notification to raise: one sentence, and where a click on it leads. */
export interface ShownNotification {
  /**
   * The whole of the copy. #316 words one sentence per case and no second
   * line, so nothing invents a body: an OS notification already prints the
   * app's name above it.
   */
  title: string
  /** The person clicked the notification body. Runs in main; see index.ts. */
  onClick: () => void
}

export interface SystemNotificationPort {
  /**
   * Whether this machine can show a notification at all, asked before EVERY
   * attempt rather than once at startup.
   *
   * Not a micro-optimisation to remove: on Linux a notification daemon can
   * appear or go away while the app runs, and Electron's own documentation
   * states the check is per-attempt. One cached answer at startup would be a
   * reading of a machine that has since changed.
   */
  isSupported: () => boolean
  /**
   * Raise one. Answers with a handle to withdraw it, or `null` when nothing
   * was shown — which is not an error, only the honest report that there is
   * nothing on screen to close later.
   */
  show: (notification: ShownNotification) => OpenNotification | null
}
