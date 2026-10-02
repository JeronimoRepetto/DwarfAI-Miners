// layer: L2
import { describe, expect, it } from 'vitest'
import { t, type DwarfId, type MineId, type OsNotification } from '@dwarfai/contracts'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import type { NotificationDisplay, NotificationWithdrawal } from '../ports/notificationDisplay'
import { RecordingNotificationDisplay } from '../ports/fakes/RecordingNotificationDisplay'
import { startNotificationPresenter, type AttentionFrame } from './notificationPresenter'

// L2 (17 §1.2): the presenter of ISSUE-113 between HostClient's `notifier` frames and the NotificationDisplay port. The
// Host decided and formatted everything (ADR-018 items 1, 9; ISSUE-109): UI main shows the title and body unchanged and
// withdraws by key (ADR-018 item 4).

const MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad111' as DwarfId
/** The dwarf's custom name; its base name is another one, which UI main never sees or uses (OQ-27). */
const CUSTOM_NAME = 'Ember'

function notification(overrides: Partial<OsNotification> = {}): OsNotification {
  return {
    key: `${DWARF}:question:ask-1`,
    kind: 'question',
    // As the Host formats it: the PO #44 template with `customName ?? baseName` (ISSUE-109).
    title: t('attention.level3Title.question', { dwarf: CUSTOM_NAME }),
    body: 'Mine one',
    mineId: MINE,
    dwarfId: DWARF,
    sensitive: true,
    ...overrides
  }
}

/** The `notifier` connection's frames, as a FakeHost emits them through HostClient. */
class FakeNotifierFrames {
  private readonly handlers = new Set<(frame: AttentionFrame) => void>()

  subscribe = (handler: (frame: AttentionFrame) => void): (() => void) => {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  notify(n: OsNotification): void {
    for (const handler of [...this.handlers]) handler({ name: 'attention.notify', data: n })
  }

  withdraw(keys: string[]): void {
    for (const handler of [...this.handlers])
      handler({ name: 'attention.withdraw', data: { keys } })
  }

  subscribers(): number {
    return this.handlers.size
  }
}

function world(options: { windowOpen?: boolean; drawsWithoutWindow?: boolean } = {}) {
  const frames = new FakeNotifierFrames()
  const display = new RecordingNotificationDisplay()
  const log = new RecordingUiLog()
  let windowOpen = options.windowOpen ?? true
  const presenter = startNotificationPresenter({
    onAttentionFrame: frames.subscribe,
    display,
    drawsWithoutWindow: options.drawsWithoutWindow ?? true,
    anyWindowOpen: () => windowOpen,
    log
  })
  return {
    frames,
    display,
    log,
    presenter,
    closeWindows: () => {
      windowOpen = false
    }
  }
}

describe('notificationPresenter (ISSUE-113)', () => {
  it("[NFR-PLAT-08, INV-104] an attention.notify frame is shown with the Host's title and the mine name as body, unchanged", () => {
    const { frames, display } = world()
    frames.notify(notification())
    frames.notify(
      notification({
        key: `${DWARF}:permission:ask-2`,
        kind: 'permission',
        title: t('attention.level3Title.permission', { dwarf: CUSTOM_NAME }),
        body: 'Mine two'
      })
    )

    expect(display.shown).toEqual([
      { key: `${DWARF}:question:ask-1`, title: 'Ember has a question', body: 'Mine one' },
      { key: `${DWARF}:permission:ask-2`, title: 'Ember asks for permission', body: 'Mine two' }
    ])
  })

  it('[ADR-018] an attention.withdraw frame closes the notifications of those keys', () => {
    const { frames, display } = world()
    const first = notification()
    const second = notification({ key: `${DWARF}:turn-finished:turn-3`, kind: 'turn-finished' })
    const third = notification({ key: `${DWARF}:question:ask-4` })
    for (const n of [first, second, third]) frames.notify(n)

    frames.withdraw([first.key, third.key, 'a-key-never-shown'])

    expect(display.closed).toEqual([first.key, third.key])
    expect(display.openKeys()).toEqual([second.key])
  })

  it('[ADR-018] frames arriving while no window is open are shown by the same process', () => {
    const { frames, display, closeWindows } = world({ drawsWithoutWindow: true })
    closeWindows()

    frames.notify(notification())
    frames.withdraw([notification().key])

    expect(display.shown).toEqual([
      { key: `${DWARF}:question:ask-1`, title: 'Ember has a question', body: 'Mine one' }
    ])
    expect(display.closed).toEqual([notification().key])
  })

  it('[S-018-1] where S-018-1 has not passed, a notification arriving with no window open is not drawn and is logged by event name', () => {
    const { frames, display, log, closeWindows } = world({ drawsWithoutWindow: false })
    frames.notify(notification())
    closeWindows()
    frames.notify(notification({ key: `${DWARF}:question:ask-5` }))

    // Window-only fallback (21 §9 cut 1 entry): drawn while a window is open, never by the windowless process.
    expect(display.shown.map((n) => n.key)).toEqual([`${DWARF}:question:ask-1`])
    expect(log.byEvent('notification.display')).toEqual([
      expect.objectContaining({ outcome: 'skipped', errCode: 'window-only' })
    ])
  })

  it('[FM-048] a display failure is logged by event name only and never throws into the connection', () => {
    const frames = new FakeNotifierFrames()
    const log = new RecordingUiLog()
    const broken: NotificationDisplay & NotificationWithdrawal = {
      show: () => {
        throw new Error(`no notification service for ${CUSTOM_NAME} in Mine one`)
      },
      close: () => {
        throw new Error('already gone')
      }
    }
    startNotificationPresenter({
      onAttentionFrame: frames.subscribe,
      display: broken,
      drawsWithoutWindow: true,
      anyWindowOpen: () => true,
      log
    })

    expect(() => frames.notify(notification())).not.toThrow()
    expect(() => frames.withdraw([notification().key])).not.toThrow()

    const records = log.byEvent('notification.display')
    expect(records).toEqual([
      {
        level: 'warn',
        event: 'notification.display',
        subsystem: 'window',
        outcome: 'failed',
        errCode: 'show-threw'
      },
      {
        level: 'warn',
        event: 'notification.display',
        subsystem: 'window',
        outcome: 'failed',
        errCode: 'close-threw'
      }
    ])
    const written = JSON.stringify(log.entries)
    for (const content of [CUSTOM_NAME, 'Mine one', 'has a question', 'no notification service']) {
      expect(written).not.toContain(content)
    }
  })

  it('[ADR-018] a click on a shown notification is handed to the placeholder, which logs the event name only', () => {
    const { frames, display, log } = world()
    frames.notify(notification())

    expect(display.click(notification().key)).toBe(true)

    // The reveal itself is ISSUE-114's (later); here the click is a no-op that logs the event name.
    expect(log.byEvent('notification.display')).toEqual([
      {
        level: 'debug',
        event: 'notification.display',
        subsystem: 'window',
        outcome: 'ok',
        causeClass: 'clicked'
      }
    ])
    expect(JSON.stringify(log.entries)).not.toContain(CUSTOM_NAME)
  })

  it('[ADR-018] dispose unsubscribes from the notifier frames', () => {
    const { frames, presenter, display } = world()
    expect(frames.subscribers()).toBe(1)
    presenter.dispose()
    expect(frames.subscribers()).toBe(0)
    frames.notify(notification())
    expect(display.shown).toEqual([])
  })
})
