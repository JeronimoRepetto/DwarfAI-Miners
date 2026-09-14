import type { Mine } from '../domain/types'
import type { OpenNotification, SystemNotificationPort } from './notificationPort'
import {
  decideNotifications,
  emptyNotifyMemory,
  type NotifyMemory,
  type PanelFocus
} from './notifyDecision'

/**
 * What stands between #316's pure decision and the notification centre.
 *
 * Everything that CHANGES over time lives here and nothing else does: the fold's
 * memory across polls, and the handles of the notifications currently on screen.
 * The decision stays a function of two boards, the port stays a description of
 * the OS, and this is the only piece that has to be built with fakes to be read.
 *
 * There is no timer, no queue and no poll of its own. `update` is called from
 * the one place main already publishes a board (`onMinesUpdated` in index.ts),
 * so a notification costs exactly one fold over a snapshot that was being sent
 * to the renderer anyway.
 */

export interface NotifierOptions {
  port: SystemNotificationPort
  /**
   * Settings' switch, read at the moment of each poll rather than captured
   * once: turning it off has to take effect on the next board, not the next
   * launch.
   */
  enabled: () => boolean
  /**
   * What the shell is showing right now — main's own reading of its window,
   * and the mine the renderer last reported having open. Read per poll for the
   * same reason the switch is.
   */
  focus: () => PanelFocus
  /** The click route: show the shell on this mine, selecting no dwarf. */
  openMine: (mineId: string) => void
  now?: () => number
}

export interface Notifier {
  /** Fold one published board, showing and withdrawing whatever it implies. */
  update: (mines: readonly Mine[]) => void
  /** How many notifications this holds a handle for. Exposed for its test. */
  openCount: () => number
}

export function createNotifier(options: NotifierOptions): Notifier {
  const now = options.now ?? Date.now
  let memory: NotifyMemory = emptyNotifyMemory()
  /**
   * Only STANDING facts are kept, keyed the way the decision keys them.
   *
   * A turn end is an instant: nothing can ever withdraw it, so holding its
   * handle would grow this map by one entry per finished turn for as long as
   * the app runs and never release any of them.
   */
  const open = new Map<string, OpenNotification>()

  function withdraw(key: string): void {
    const notification = open.get(key)
    open.delete(key)
    if (notification === undefined) return
    try {
      notification.close()
    } catch {
      // The person dismissed it, or the platform retired it on its own. Both
      // are the outcome that was asked for, so neither is worth a word.
    }
  }

  function update(mines: readonly Mine[]): void {
    const enabled = options.enabled()
    const folded = decideNotifications(memory, {
      mines,
      focus: options.focus(),
      enabled,
      now: now()
    })
    memory = folded.memory

    // Withdrawals travel whatever the switch says: the ones being closed were
    // shown while it was on, and a switch flipped mid-prompt must not leave a
    // sentence on screen that is no longer true.
    for (const key of folded.decision.withdraw) withdraw(key)

    for (const notification of folded.decision.show) {
      // Asked per notification, not per poll and not once at startup — see
      // SystemNotificationPort.isSupported for why the answer can change.
      if (!options.port.isSupported()) continue
      const handle = options.port.show({
        title: notification.title,
        // Captured by VALUE, so a click that lands long after the ask was
        // answered still opens the mine it named rather than reading state
        // that has moved on.
        onClick: () => options.openMine(notification.mineId)
      })
      if (handle === null || notification.kind === 'turn-end') continue
      open.set(notification.key, handle)
    }
  }

  return { update, openCount: () => open.size }
}
