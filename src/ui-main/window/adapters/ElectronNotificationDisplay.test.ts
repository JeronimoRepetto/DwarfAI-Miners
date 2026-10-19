// layer: L3
import { describe, expect, it } from 'vitest'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { runNotificationDisplayContract } from '../testing/notificationDisplay.contract'
import { APP_USER_MODEL_ID } from './appUserModelId'
import type { UiPlatform } from './ElectronScreenArea'
import {
  ElectronNotificationDisplay,
  type NotificationConstructorLike,
  type NotificationLike
} from './ElectronNotificationDisplay'

// The real ElectronNotificationDisplay (16 §4.14; ADR-018 item 7) over a stubbed Electron `Notification` constructor:
// the port is Electron's own class, injected by the composition root, so the adapter's decisions (what it builds, the
// per-attempt support check, the AUMID, the key map, the failure logging) are asserted without a notification centre
// and nothing is ever shown on the desktop running the suite.

type Listener = () => void

/** One notification the stub platform built. */
interface StubNotification {
  options: { title: string; body: string }
  shown: boolean
  closed: boolean
  listeners: Map<string, Listener[]>
  emit(event: 'click' | 'close' | 'failed'): void
}

function stubPlatform(
  options: { supported?: () => boolean; throwOnBuild?: Error; closeThrows?: boolean } = {}
) {
  const built: StubNotification[] = []
  /** Every platform call, in order: the AUMID and each construction. */
  const calls: string[] = []

  class StubElectronNotification implements NotificationLike {
    private readonly record: StubNotification

    constructor(created: { title: string; body: string }) {
      calls.push('construct')
      if (options.throwOnBuild !== undefined) throw options.throwOnBuild
      const listeners = new Map<string, Listener[]>()
      this.record = {
        options: created,
        shown: false,
        closed: false,
        listeners,
        emit: (event) => {
          for (const listener of listeners.get(event) ?? []) listener()
        }
      }
      built.push(this.record)
    }

    show(): void {
      this.record.shown = true
    }

    close(): void {
      if (options.closeThrows === true) throw new Error('already gone')
      // Electron emits `close` when a notification is closed, by the person or by `close()`.
      if (this.record.closed) return
      this.record.closed = true
      this.record.emit('close')
    }

    on(event: 'click' | 'close' | 'failed', listener: Listener): void {
      this.record.listeners.set(event, [...(this.record.listeners.get(event) ?? []), listener])
    }

    static isSupported(): boolean {
      return options.supported?.() ?? true
    }
  }

  return {
    Constructor: StubElectronNotification as NotificationConstructorLike,
    built,
    calls
  }
}

function world(
  options: {
    platform?: UiPlatform
    supported?: () => boolean
    throwOnBuild?: Error
    closeThrows?: boolean
  } = {}
) {
  const stub = stubPlatform(options)
  const log = new RecordingUiLog()
  const aumids: string[] = []
  const display = new ElectronNotificationDisplay({
    notification: stub.Constructor,
    platform: options.platform ?? 'win32',
    setAppUserModelId: (id) => {
      stub.calls.push(`aumid:${id}`)
      aumids.push(id)
    },
    log
  })
  return { ...stub, log, aumids, display }
}

const QUESTION = { key: 'd1:question:ask-1', title: 'Ember has a question', body: 'Mine one' }

runNotificationDisplayContract('ElectronNotificationDisplay', () => {
  const { display, built } = world()
  return {
    display,
    drawn: () => built.filter((n) => n.shown).map((n) => n.options),
    onScreen: () => built.filter((n) => n.shown && !n.closed).map((n) => n.options),
    click: (index) => built.filter((n) => n.shown)[index]?.emit('click')
  }
})

describe('ElectronNotificationDisplay (16 §4.14)', () => {
  it("[ADR-018] the OS notification is built from the Host's title and body only, and shown", () => {
    const { display, built } = world()
    display.show(QUESTION, () => undefined)

    expect(built.map((n) => n.options)).toEqual([
      { title: 'Ember has a question', body: 'Mine one' }
    ])
    expect(built.map((n) => n.shown)).toEqual([true])
  })

  it('[ADR-018] the AUMID is set once on Windows, before the first notification is built, and never on macOS or Linux', () => {
    const windows = world({ platform: 'win32' })
    windows.display.show(QUESTION, () => undefined)
    windows.display.show({ ...QUESTION, key: 'd1:question:ask-2' }, () => undefined)
    expect(windows.calls).toEqual([`aumid:${APP_USER_MODEL_ID}`, 'construct', 'construct'])

    for (const platform of ['darwin', 'linux'] as const) {
      const other = world({ platform })
      other.display.show(QUESTION, () => undefined)
      expect(other.aumids, platform).toEqual([])
      expect(other.built, platform).toHaveLength(1)
    }
  })

  it('[ADR-018] a notification the person dismissed frees its key, so the Host can show it again', () => {
    const { display, built } = world()
    display.show(QUESTION, () => undefined)
    built[0]?.emit('close')
    display.show(QUESTION, () => undefined)

    expect(built.map((n) => n.shown)).toEqual([true, true])
  })

  it('[FM-048] where the platform cannot show one, nothing is built and the skip is logged by event name, asked on every attempt', () => {
    let supported = false
    const { display, built, log } = world({ supported: () => supported })
    display.show(QUESTION, () => undefined)
    supported = true
    display.show(QUESTION, () => undefined)

    expect(built).toHaveLength(1)
    expect(log.byEvent('notification.display')).toEqual([
      {
        level: 'warn',
        event: 'notification.display',
        subsystem: 'window',
        outcome: 'skipped',
        errCode: 'unsupported'
      },
      { level: 'debug', event: 'notification.display', subsystem: 'window', outcome: 'ok' }
    ])
  })

  it('[FM-048] a platform that throws on the way up, or a failed event, is logged by event name only and never throws', () => {
    const throwing = world({
      throwOnBuild: new Error('no notification service for Ember in Mine one')
    })
    expect(() => throwing.display.show(QUESTION, () => undefined)).not.toThrow()
    expect(throwing.log.entries).toEqual([
      {
        level: 'warn',
        event: 'notification.display',
        subsystem: 'window',
        outcome: 'failed',
        errCode: 'build-threw'
      }
    ])

    const failing = world()
    failing.display.show(QUESTION, () => undefined)
    failing.built[0]?.emit('failed')
    expect(failing.log.entries).toEqual([
      { level: 'debug', event: 'notification.display', subsystem: 'window', outcome: 'ok' },
      {
        level: 'warn',
        event: 'notification.display',
        subsystem: 'window',
        outcome: 'failed',
        errCode: 'failed-event'
      }
    ])
    // A failed notification is not on screen: its key is free again.
    failing.display.show(QUESTION, () => undefined)
    expect(failing.built).toHaveLength(2)

    const written = JSON.stringify([...throwing.log.entries, ...failing.log.entries])
    for (const content of ['Ember', 'Mine one', 'no notification service'])
      expect(written).not.toContain(content)
  })

  it('[ADR-018] close never throws when the platform already retired the notification', () => {
    const { display, built } = world({ closeThrows: true })
    display.show(QUESTION, () => undefined)
    expect(() => display.close(QUESTION.key)).not.toThrow()
    expect(built).toHaveLength(1)
  })
})
