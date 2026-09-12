import { describe, expect, it } from 'vitest'
import {
  createElectronNotifications,
  type NotificationConstructorLike,
  type NotificationLike
} from './electronNotifications'

/**
 * The one adapter onto Electron's `Notification` (#316).
 *
 * The constructor is a PARAMETER, so the whole of the wiring — the support
 * check, the show, the click subscription and the close — is assertable with a
 * hand-written stand-in and no notification centre. That is the same "pure
 * builder, thin runner" split `platform-ports` asks for: what is left
 * unverified here is Electron's own behaviour, not this app's decisions.
 */
function fakeNotifications(options: { supported?: boolean } = {}) {
  const built: { title: string }[] = []
  const shown: string[] = []
  const closed: string[] = []
  const clickListeners: (() => void)[] = []

  class FakeNotification implements NotificationLike {
    constructor(private readonly created: { title: string }) {
      built.push(created)
    }
    show(): void {
      shown.push(this.created.title)
    }
    close(): void {
      closed.push(this.created.title)
    }
    on(_event: 'click', listener: () => void): void {
      clickListeners.push(listener)
    }
    static isSupported(): boolean {
      return options.supported ?? true
    }
  }

  return {
    Constructor: FakeNotification as unknown as NotificationConstructorLike,
    built,
    shown,
    closed,
    clickListeners
  }
}

describe('createElectronNotifications', () => {
  it('reports what the platform says about itself, never a cached guess', () => {
    expect(
      createElectronNotifications({ notification: fakeNotifications().Constructor }).isSupported()
    ).toBe(true)
    expect(
      createElectronNotifications({
        notification: fakeNotifications({ supported: false }).Constructor
      }).isSupported()
    ).toBe(false)
  })

  it('builds the notification with the sentence it was given and shows it', () => {
    const fake = fakeNotifications()
    const port = createElectronNotifications({ notification: fake.Constructor })
    port.show({ title: 'A question is waiting in Forge', onClick: () => undefined })
    expect(fake.built).toEqual([{ title: 'A question is waiting in Forge' }])
    expect(fake.shown).toEqual(['A question is waiting in Forge'])
  })

  it('runs the click handler when the person clicks the notification', () => {
    const fake = fakeNotifications()
    const port = createElectronNotifications({ notification: fake.Constructor })
    let clicked = 0
    port.show({ title: 'Forge finished its turn', onClick: () => (clicked += 1) })
    for (const listener of fake.clickListeners) listener()
    expect(clicked).toBe(1)
  })

  it('answers with a handle that withdraws the notification', () => {
    const fake = fakeNotifications()
    const port = createElectronNotifications({ notification: fake.Constructor })
    port.show({ title: 'Forge is waiting for your approval', onClick: () => undefined })?.close()
    expect(fake.closed).toEqual(['Forge is waiting for your approval'])
  })

  it('shows nothing and answers with nothing where the platform cannot', () => {
    // A Linux box with no notification daemon: the absence fails silently.
    const fake = fakeNotifications({ supported: false })
    const port = createElectronNotifications({ notification: fake.Constructor })
    expect(port.show({ title: 'A question is waiting in Forge', onClick: () => undefined })).toBe(
      null
    )
    expect(fake.built).toEqual([])
  })

  it('answers with nothing when the platform throws on the way up', () => {
    // Measured on no platform, guarded on all three: a constructor that throws
    // must cost the notification and not the poll that asked for it.
    class Broken {
      constructor() {
        throw new Error('no notification service')
      }
      static isSupported(): boolean {
        return true
      }
    }
    const port = createElectronNotifications({
      notification: Broken as unknown as NotificationConstructorLike
    })
    expect(port.show({ title: 'A question is waiting in Forge', onClick: () => undefined })).toBe(
      null
    )
  })
})
