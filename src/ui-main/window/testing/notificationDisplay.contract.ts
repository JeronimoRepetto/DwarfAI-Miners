// The NotificationDisplay conformance suite (16 §4.14; 17 §1.3 L3), run by the double `RecordingNotificationDisplay`
// and by the adapter `ElectronNotificationDisplay` over a stubbed Electron `Notification` constructor alike: what the
// Host decided is drawn as it is, one OS notification per key, a click reaches `onClick` once, and the adapter's own
// `close(key)` withdraws the notification of that key only (ADR-018 items 4, 7, 9).
import { describe, expect, it } from 'vitest'
import type {
  KeyedNotification,
  NotificationDisplay,
  NotificationWithdrawal
} from '../ports/notificationDisplay'

/** A notification as the platform (or the double) holds it. */
export interface DrawnNotification {
  title: string
  body: string
}

export interface NotificationDisplaySubject {
  display: NotificationDisplay & NotificationWithdrawal
  /** Every notification drawn, in order. */
  drawn(): DrawnNotification[]
  /** The notifications still on screen, in the order they were drawn. */
  onScreen(): DrawnNotification[]
  /** The person clicks the `index`-th notification drawn (from 0). */
  click(index: number): void
}

const QUESTION: KeyedNotification = {
  key: 'd1:question:ask-1',
  title: 'Ember has a question',
  body: 'Mine one'
}
const PERMISSION: KeyedNotification = {
  key: 'd2:permission:ask-2',
  title: 'Rook asks for permission',
  body: 'Mine two'
}
const FINISHED: KeyedNotification = {
  key: 'd1:turn-finished:turn-3',
  title: 'Ember finished the turn',
  body: 'Mine one'
}

const view = ({ title, body }: KeyedNotification): DrawnNotification => ({ title, body })

export function runNotificationDisplayContract(
  name: string,
  make: () => NotificationDisplaySubject
): void {
  describe(`${name} meets the NotificationDisplay contract (16 §4.14)`, () => {
    it('[ADR-018] show creates one OS notification per key and the click calls onClick once', () => {
      const subject = make()
      const clicks: string[] = []

      subject.display.show(QUESTION, () => clicks.push(QUESTION.key))
      subject.display.show(PERMISSION, () => clicks.push(PERMISSION.key))
      // The same key again (the Host re-sends standing notifications to a notifier that attaches again, 14 §2.3).
      subject.display.show(QUESTION, () => clicks.push('again'))

      expect(subject.drawn()).toEqual([view(QUESTION), view(PERMISSION)])
      subject.click(0)
      subject.click(0)
      expect(clicks).toEqual([QUESTION.key])
    })

    it('[ADR-018] close withdraws the notification of that key only, and a key with none is a no-op', () => {
      const subject = make()
      for (const n of [QUESTION, PERMISSION, FINISHED]) subject.display.show(n, () => undefined)

      subject.display.close(PERMISSION.key)
      subject.display.close('a-key-never-shown')
      subject.display.close(PERMISSION.key)

      expect(subject.onScreen()).toEqual([view(QUESTION), view(FINISHED)])
    })

    it('[ADR-018] a key withdrawn can be shown again when the Host decides it again', () => {
      const subject = make()
      subject.display.show(QUESTION, () => undefined)
      subject.display.close(QUESTION.key)
      subject.display.show(QUESTION, () => undefined)

      expect(subject.drawn()).toEqual([view(QUESTION), view(QUESTION)])
      expect(subject.onScreen()).toEqual([view(QUESTION)])
    })
  })
}
