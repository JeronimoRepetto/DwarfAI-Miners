import { describe, expect, it } from 'vitest'
import type { Dwarf, Mine } from '../domain/types'
import { defaultDwarf, defaultMine } from '../domain/types'
import { createNotifier, type NotifierOptions } from './notifier'
import type { OpenNotification, ShownNotification, SystemNotificationPort } from './notificationPort'

/**
 * The glue between #316's pure decision and the OS (notifier.ts): what is
 * actually shown, what is closed again, and where a click goes.
 *
 * The port is a hand-written fake recording every ask, so the platform rules
 * that matter — `isSupported()` before EVERY attempt, a close that throws
 * because the person already dismissed the notification, a Linux box with no
 * daemon at all — are assertable on a Windows host with no notification centre
 * involved. What to notify ABOUT is notifyDecision's own test; this one is only
 * about the surface.
 */

interface FakePort extends SystemNotificationPort {
  readonly shown: ShownNotification[]
  readonly closed: string[]
  supported: boolean
  /** Make the next `show` return nothing, as a platform that refused would. */
  refuseNext: boolean
  /** Make every `close` throw, as a notification the OS already retired does. */
  closeThrows: boolean
  /** How many times the port was asked whether it can show anything at all. */
  readonly supportAsks: number[]
}

function fakePort(): FakePort {
  const shown: ShownNotification[] = []
  const closed: string[] = []
  const supportAsks: number[] = []
  const port = {
    shown,
    closed,
    supported: true,
    refuseNext: false,
    closeThrows: false,
    supportAsks,
    isSupported: () => {
      supportAsks.push(shown.length)
      return port.supported
    },
    show: (notification: ShownNotification): OpenNotification | null => {
      if (port.refuseNext) {
        port.refuseNext = false
        return null
      }
      shown.push(notification)
      return {
        close: () => {
          if (port.closeThrows) throw new Error('already dismissed')
          closed.push(notification.title)
        }
      }
    }
  }
  return port
}

function dwarf(overrides: Partial<Dwarf>): Dwarf {
  return { ...defaultDwarf(), ...overrides }
}

function mine(id: string, name: string, dwarfs: Dwarf[]): Mine {
  return { ...defaultMine(), id, name, dwarfs }
}

const QUIET = mine('m1', 'Forge', [dwarf({ id: 'd1', role: 'foreman', status: 'waiting' })])

const ASKING = mine('m1', 'Forge', [
  dwarf({
    id: 'd1',
    role: 'foreman',
    status: 'waiting',
    pendingQuestion: {
      toolUseId: 'ask-1',
      question: 'Which branch?',
      channel: 'held',
      multiSelect: false,
      questionCount: 1,
      options: []
    }
  })
])

const WORKING = mine('m1', 'Forge', [dwarf({ id: 'd1', role: 'foreman', status: 'working' })])
const RESTING = QUIET

/** The notifier as index.ts composes it, with every collaborator a fake. */
function build(overrides: Partial<NotifierOptions> = {}) {
  const port = fakePort()
  const opened: string[] = []
  const notifier = createNotifier({
    port,
    enabled: () => true,
    focus: () => ({ panelVisible: false, openMineId: null }),
    openMine: (mineId: string) => opened.push(mineId),
    now: () => 1_000,
    ...overrides
  })
  return { notifier, port, opened }
}

describe('createNotifier — what reaches the OS', () => {
  it('shows the decided sentence once the fact is new', () => {
    const { notifier, port } = build()
    notifier.update([QUIET])
    notifier.update([ASKING])
    expect(port.shown.map((one) => one.title)).toEqual(['A question is waiting in Forge'])
  })

  it('says nothing on the seeding board, so a launch is not a burst', () => {
    const { notifier, port } = build()
    notifier.update([ASKING])
    expect(port.shown).toEqual([])
  })

  it('asks the platform whether it can show anything BEFORE every attempt', () => {
    // Not once at startup: a Linux session can gain or lose its notification
    // daemon while the app runs, and macOS only answers truthfully after the
    // user has been asked.
    const { notifier, port } = build()
    notifier.update([QUIET])
    notifier.update([ASKING])
    notifier.update([WORKING])
    notifier.update([RESTING])
    expect(port.supportAsks.length).toBeGreaterThanOrEqual(2)
  })

  it('shows nothing at all where the platform cannot, and does not throw', () => {
    // A Linux box with no notification daemon: the absence fails silently.
    const { notifier, port } = build()
    port.supported = false
    notifier.update([QUIET])
    expect(() => notifier.update([ASKING])).not.toThrow()
    expect(port.shown).toEqual([])
  })

  it('shows nothing while the Settings switch is off', () => {
    let on = false
    const { notifier, port } = build({ enabled: () => on })
    notifier.update([QUIET])
    notifier.update([ASKING])
    expect(port.shown).toEqual([])
    // And the backlog does not arrive when it comes back on, because the fold
    // advanced while it was off.
    on = true
    notifier.update([ASKING])
    expect(port.shown).toEqual([])
  })

  it('stays quiet about the mine on screen', () => {
    const { notifier, port } = build({
      focus: () => ({ panelVisible: true, openMineId: 'm1' })
    })
    notifier.update([QUIET])
    notifier.update([ASKING])
    expect(port.shown).toEqual([])
  })

  it('reads the focus AT the moment of the poll, never once at startup', () => {
    let focus = { panelVisible: true, openMineId: 'm1' as string | null }
    const { notifier, port } = build({ focus: () => focus })
    notifier.update([QUIET])
    focus = { panelVisible: false, openMineId: 'm1' }
    notifier.update([ASKING])
    expect(port.shown).toHaveLength(1)
  })

  it('announces the end of a turn', () => {
    const { notifier, port } = build()
    notifier.update([WORKING])
    notifier.update([RESTING])
    expect(port.shown.map((one) => one.title)).toEqual(['Forge finished its turn'])
  })
})

describe('createNotifier — withdrawing what is no longer true', () => {
  it('closes the notification once its ask is answered', () => {
    const { notifier, port } = build()
    notifier.update([QUIET])
    notifier.update([ASKING])
    notifier.update([QUIET])
    expect(port.closed).toEqual(['A question is waiting in Forge'])
  })

  it('closes it only once, however many polls follow', () => {
    const { notifier, port } = build()
    notifier.update([QUIET])
    notifier.update([ASKING])
    notifier.update([QUIET])
    notifier.update([QUIET])
    expect(port.closed).toHaveLength(1)
  })

  it('withdraws even while the switch is off, so nothing is stranded on screen', () => {
    let on = true
    const { notifier, port } = build({ enabled: () => on })
    notifier.update([QUIET])
    notifier.update([ASKING])
    on = false
    notifier.update([QUIET])
    expect(port.closed).toEqual(['A question is waiting in Forge'])
  })

  it('survives a close the platform refuses, because the person already dismissed it', () => {
    const { notifier, port } = build()
    notifier.update([QUIET])
    notifier.update([ASKING])
    port.closeThrows = true
    expect(() => notifier.update([QUIET])).not.toThrow()
  })

  it('holds nothing for a turn end, which does not stop having happened', () => {
    // Keeping a handle for a fact nothing can ever withdraw would grow one
    // entry per finished turn for as long as the app runs.
    const { notifier } = build()
    notifier.update([WORKING])
    notifier.update([RESTING])
    expect(notifier.openCount()).toBe(0)
  })

  it('lets go of a handle the platform never gave it', () => {
    const { notifier, port } = build()
    notifier.update([QUIET])
    port.refuseNext = true
    notifier.update([ASKING])
    expect(notifier.openCount()).toBe(0)
    expect(() => notifier.update([QUIET])).not.toThrow()
    expect(port.closed).toEqual([])
  })
})

describe('createNotifier — the click', () => {
  it('opens the mine the notification named, and nothing else', () => {
    const { notifier, port, opened } = build()
    notifier.update([QUIET])
    notifier.update([ASKING])
    port.shown[0]?.onClick()
    expect(opened).toEqual(['m1'])
  })

  it('opens the mine a finished turn happened in', () => {
    const { notifier, port, opened } = build()
    notifier.update([WORKING])
    notifier.update([RESTING])
    port.shown[0]?.onClick()
    expect(opened).toEqual(['m1'])
  })

  it('still opens the mine after its ask was answered and the notification withdrawn', () => {
    // The click can land on a notification the person had not looked at yet.
    // Taking them to the mine is right either way; there is nothing here that
    // depends on the ask still standing.
    const { notifier, port, opened } = build()
    notifier.update([QUIET])
    notifier.update([ASKING])
    notifier.update([QUIET])
    port.shown[0]?.onClick()
    expect(opened).toEqual(['m1'])
  })
})
