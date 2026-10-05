// layer: L2
import { describe, expect, it } from 'vitest'
import {
  t,
  type AttentionKind,
  type DwarfId,
  type MineId,
  type OsNotification
} from '@dwarfai/contracts'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { RecordingHostClient } from '../ports/fakes/RecordingHostClient'
import { RecordingNotificationDisplay } from '../ports/fakes/RecordingNotificationDisplay'
import { startNotificationPresenter, type AttentionFrame } from './notificationPresenter'
import type { EvtFrame } from '@dwarfai/contracts'
import type { HostEvent } from '../ports/hostClient'
import {
  createDepartedDwarfs,
  createRevealDwarfChat,
  type ModeReveal,
  type RevealMode,
  type RevealTarget,
  type RevealWindows
} from './revealDwarfChat'

// L2 (17 §1.2): a click on a level-3 notification (ISSUE-114; ADR-018 item 6; 07 S10.10–S10.12, S17.06; 13 FM-049),
// from the NotificationDisplay double's click through the presenter to `revealDwarfChat` and the reveal of the mode it
// runs in. The windows, the reveals and the Host are doubles: what is asserted is which mode reveals what, and the one
// thing the Host hears.

const MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad111' as DwarfId
const OTHER_DWARF = '01890a5d-ac96-774b-bcce-b302099ad222' as DwarfId

const TITLE_KEYS = {
  question: 'attention.level3Title.question',
  permission: 'attention.level3Title.permission',
  'turn-finished': 'attention.level3Title.turnFinished'
} as const satisfies Record<AttentionKind, string>

function notification(kind: AttentionKind, dwarfId: DwarfId = DWARF): OsNotification {
  return {
    key: `${dwarfId}:${kind}:1`,
    kind,
    title: t(TITLE_KEYS[kind], { dwarf: 'Ember' }),
    body: 'Mine one',
    mineId: MINE,
    dwarfId,
    sensitive: true
  }
}

/** Lets every promise the click started settle (no timers: the doubles answer at once). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** Every window action, in order, across all modes. */
type WindowEvent =
  | { did: 'restore' | 'raise'; mode: RevealMode }
  | { did: 'open-at-launch'; mode: RevealMode }
  | { did: 'reveal'; mode: RevealMode; target: RevealTarget }

/**
 * The mode windows (16 §4.14 `ShellModeController` side): the mode of the window that exists, shown, hidden or
 * minimized; null in tray only. Opening per "Mode at launch" creates the window of the mode that preference names.
 */
class FakeRevealWindows implements RevealWindows {
  readonly events: WindowEvent[] = []
  raises = true
  raiseHangs = false
  private pendingOpen: Array<() => void> = []

  constructor(
    private open: RevealMode | null,
    private readonly modeAtLaunch: RevealMode = 'panel',
    private readonly holdOpen = false
  ) {}

  existing(): RevealMode | null {
    return this.open
  }

  restore(mode: RevealMode): void {
    this.events.push({ did: 'restore', mode })
  }

  openAtLaunch(): Promise<RevealMode> {
    const mode = this.modeAtLaunch
    this.events.push({ did: 'open-at-launch', mode })
    const done = (): void => {
      this.open = mode
    }
    if (!this.holdOpen) {
      done()
      return Promise.resolve(mode)
    }
    return new Promise((resolve) =>
      this.pendingOpen.push(() => {
        done()
        resolve(mode)
      })
    )
  }

  /** A held "Mode at launch" open finishes. */
  finishOpening(): void {
    for (const finish of this.pendingOpen.splice(0)) finish()
  }

  raise(mode: RevealMode): Promise<boolean> {
    this.events.push({ did: 'raise', mode })
    // A raise the OS never answers (the S-018-2 foreground rules are unmeasured).
    if (this.raiseHangs) return new Promise<boolean>(() => {})
    return Promise.resolve(this.raises)
  }

  closeAll(): void {
    this.open = null
  }

  reveals(): Record<RevealMode, ModeReveal> {
    const of =
      (mode: RevealMode): ModeReveal['reveal'] =>
      (target) =>
        this.events.push({ did: 'reveal', mode, target })
    return {
      panel: { reveal: of('panel') },
      veta: { reveal: of('veta') },
      valle: { reveal: of('valle') }
    }
  }

  revealed(): Array<{ mode: RevealMode; target: RevealTarget }> {
    return this.events.flatMap((e) =>
      e.did === 'reveal' ? [{ mode: e.mode, target: e.target }] : []
    )
  }
}

/** The `notifier` connection's frames, as HostClient hands them on. */
class FakeNotifierFrames {
  private readonly handlers = new Set<(frame: AttentionFrame) => void>()
  subscribe = (handler: (frame: AttentionFrame) => void): (() => void) => {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  notify(n: OsNotification): void {
    for (const handler of [...this.handlers]) handler({ name: 'attention.notify', data: n })
  }
}

function world(
  options: {
    windows?: FakeRevealWindows
    present?: (dwarfId: DwarfId) => boolean
    drawsWithoutWindow?: boolean
    windowOpen?: () => boolean
  } = {}
) {
  const windows = options.windows ?? new FakeRevealWindows('panel')
  const log = new RecordingUiLog()
  const host = new RecordingHostClient()
  const display = new RecordingNotificationDisplay()
  const frames = new FakeNotifierFrames()
  const present = options.present ?? (() => true)
  const reveal = createRevealDwarfChat({
    windows,
    reveals: windows.reveals(),
    dwarfPresent: ({ dwarfId }) => present(dwarfId),
    log
  })
  startNotificationPresenter({
    onAttentionFrame: frames.subscribe,
    display,
    drawsWithoutWindow: options.drawsWithoutWindow ?? true,
    anyWindowOpen: options.windowOpen ?? (() => true),
    log,
    click: { host, reveal }
  })
  /** The Host shows `n` and the person clicks it. */
  const click = async (n: OsNotification): Promise<void> => {
    frames.notify(n)
    expect(display.click(n.key)).toBe(true)
    await settle()
  }
  return { windows, log, host, display, frames, reveal, click }
}

describe('revealDwarfChat (ISSUE-114)', () => {
  it("[US-SHELL-010.AC10] a click on a question, permission or finished-turn notification opens that dwarf's chat in the mode currently shown", async () => {
    // A non-Panel mode is shown: the reveal must follow it, never fall back to the Panel.
    const { windows, click } = world({ windows: new FakeRevealWindows('veta') })

    await click(notification('question'))
    await click(notification('permission', OTHER_DWARF))
    await click(notification('turn-finished'))

    expect(windows.revealed()).toEqual([
      { mode: 'veta', target: { mineId: MINE, dwarfId: DWARF } },
      { mode: 'veta', target: { mineId: MINE, dwarfId: OTHER_DWARF } },
      { mode: 'veta', target: { mineId: MINE, dwarfId: DWARF } }
    ])
    expect(windows.events.some((e) => e.did === 'open-at-launch')).toBe(false)
  })

  it('[US-SHELL-010.AC11] with no window open the app opens per Mode at launch and then reveals the chat in that mode', async () => {
    const windows = new FakeRevealWindows(null, 'valle')
    const { click } = world({ windows })

    await click(notification('question'))

    expect(windows.events).toEqual([
      { did: 'open-at-launch', mode: 'valle' },
      { did: 'reveal', mode: 'valle', target: { mineId: MINE, dwarfId: DWARF } },
      { did: 'raise', mode: 'valle' }
    ])
  })

  it("[ADR-018] a click never switches mode after the reveal, and a hidden window's mode is restored", async () => {
    // A hidden or minimized Veta window counts as open: its own mode comes back, "Mode at launch" is not used (S10.11).
    const windows = new FakeRevealWindows('veta', 'panel')
    const { reveal } = world({ windows })

    await expect(reveal.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })).resolves.toBe(
      'chat-open'
    )
    await settle()

    expect(windows.events).toEqual([
      { did: 'restore', mode: 'veta' },
      { did: 'reveal', mode: 'veta', target: { mineId: MINE, dwarfId: DWARF } },
      { did: 'raise', mode: 'veta' }
    ])
    expect(new Set(windows.events.map((e) => e.mode))).toEqual(new Set(['veta']))
  })

  it('[ADR-018] a click for a dwarf that left opens its mine with no chat (mine-only)', async () => {
    const { windows, reveal, click } = world({ present: (dwarfId) => dwarfId !== DWARF })

    await expect(reveal.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })).resolves.toBe(
      'mine-only'
    )
    await click(notification('permission', DWARF))
    await expect(reveal.revealDwarfChat({ mineId: MINE, dwarfId: OTHER_DWARF })).resolves.toBe(
      'chat-open'
    )

    expect(windows.revealed()).toEqual([
      { mode: 'panel', target: { mineId: MINE, dwarfId: null } },
      { mode: 'panel', target: { mineId: MINE, dwarfId: null } },
      { mode: 'panel', target: { mineId: MINE, dwarfId: OTHER_DWARF } }
    ])
  })

  it('[S17.06] the click is reported to the Host as attention.clicked only', async () => {
    // The double refuses every call, as a Host that is gone would: the counter is lost, the reveal is not.
    const { host, windows, click } = world()
    const n = notification('turn-finished')

    await click(n)

    expect(host.calls).toEqual([
      { member: 'call', method: 'attention.clicked', params: { key: n.key } }
    ])
    expect(windows.revealed()).toEqual([
      { mode: 'panel', target: { mineId: MINE, dwarfId: DWARF } }
    ])
  })

  it('[FM-049] a WindowRaiser that answers false still reveals the chat', async () => {
    const windows = new FakeRevealWindows('panel')
    windows.raises = false
    const { log, reveal } = world({ windows })

    await expect(reveal.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })).resolves.toBe(
      'chat-open'
    )
    await settle()

    expect(windows.revealed()).toEqual([
      { mode: 'panel', target: { mineId: MINE, dwarfId: DWARF } }
    ])
    // 19 §9 `window.raise`: the event name and its outcome, nothing else (ADR-026).
    expect(log.byEvent('window.raise')).toEqual([
      { level: 'warn', event: 'window.raise', subsystem: 'window', outcome: 'failed' }
    ])
  })

  it('[S-018-1] where S-018-1 has not passed, a notification drawn with a window open and clicked after the windows closed still reveals per Mode at launch', async () => {
    // The S-018-1 fallback gates the drawing (window-only), never the click: a click that reaches UI main is handled.
    const windows = new FakeRevealWindows('panel', 'panel')
    let open = true
    const { display, frames } = world({
      windows,
      drawsWithoutWindow: false,
      windowOpen: () => open
    })
    const n = notification('question')
    frames.notify(n)
    open = false
    windows.closeAll()

    expect(display.click(n.key)).toBe(true)
    await settle()

    expect(windows.events).toEqual([
      { did: 'open-at-launch', mode: 'panel' },
      { did: 'reveal', mode: 'panel', target: { mineId: MINE, dwarfId: DWARF } },
      { did: 'raise', mode: 'panel' }
    ])
  })

  it('[S10.12] a second click while the app is still opening reveals in the window the first click opened', async () => {
    const windows = new FakeRevealWindows(null, 'veta', true)
    const { reveal } = world({ windows })

    const first = reveal.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })
    const second = reveal.revealDwarfChat({ mineId: MINE, dwarfId: OTHER_DWARF })
    await settle()
    windows.finishOpening()

    await expect(first).resolves.toBe('chat-open')
    await expect(second).resolves.toBe('chat-open')
    // One open per "Mode at launch"; the second click finds the window the first opened (S10.10).
    expect(windows.events.filter((e) => e.did === 'open-at-launch')).toHaveLength(1)
    expect(windows.revealed()).toEqual([
      { mode: 'veta', target: { mineId: MINE, dwarfId: DWARF } },
      { mode: 'veta', target: { mineId: MINE, dwarfId: OTHER_DWARF } }
    ])
  })

  it('[ADR-026] a reveal that fails is logged by event name only, and the next click still reveals', async () => {
    // Valle is open but no Valle reveal is built in this version: a composition fault, failed loudly and logged.
    const windows = new FakeRevealWindows('valle')
    const log = new RecordingUiLog()
    const display = new RecordingNotificationDisplay()
    const frames = new FakeNotifierFrames()
    const { panel } = windows.reveals()
    startNotificationPresenter({
      onAttentionFrame: frames.subscribe,
      display,
      drawsWithoutWindow: true,
      anyWindowOpen: () => true,
      log,
      click: {
        host: new RecordingHostClient(),
        reveal: createRevealDwarfChat({
          windows,
          reveals: { panel },
          dwarfPresent: () => true,
          log
        })
      }
    })
    const first = notification('question')
    frames.notify(first)
    display.click(first.key)
    await settle()

    expect(log.byEvent('notification.display')).toContainEqual({
      level: 'warn',
      event: 'notification.display',
      subsystem: 'window',
      outcome: 'failed',
      errCode: 'reveal-failed'
    })
    expect(JSON.stringify(log.entries)).not.toContain('Ember')
    expect(JSON.stringify(log.entries)).not.toContain(MINE)

    // The Valle window closes; the next click opens per "Mode at launch" (the Panel) and reveals there.
    windows.closeAll()
    const second = notification('permission', OTHER_DWARF)
    frames.notify(second)
    display.click(second.key)
    await settle()
    expect(windows.revealed()).toEqual([
      { mode: 'panel', target: { mineId: MINE, dwarfId: OTHER_DWARF } }
    ])
  })

  it('[FM-049] a raise the OS never answers does not hold back the next click', async () => {
    const windows = new FakeRevealWindows('panel')
    windows.raiseHangs = true
    const { reveal } = world({ windows })

    void reveal.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })
    void reveal.revealDwarfChat({ mineId: MINE, dwarfId: OTHER_DWARF })
    await settle()

    expect(windows.revealed()).toEqual([
      { mode: 'panel', target: { mineId: MINE, dwarfId: DWARF } },
      { mode: 'panel', target: { mineId: MINE, dwarfId: OTHER_DWARF } }
    ])
  })

  it('[INV-34] the board presence a reveal reads drops a dwarf on its dwarf.departed frame, and nothing else', () => {
    const host = new RecordingHostClient()
    const departed = createDepartedDwarfs(host)
    const frame = (name: string, data: unknown): HostEvent => ({
      kind: 'frame',
      frame: { type: 'evt', seq: 7, epoch: 'boot-1', name, data } as unknown as EvtFrame
    })

    expect(departed.present({ mineId: MINE, dwarfId: DWARF })).toBe(true)
    host.deliver(frame('dwarf.departed', { dwarfId: DWARF, mineId: MINE, cause: 'stopped' }))
    host.deliver(frame('dwarf.departed', { dwarfId: 'not-an-id' }))
    host.deliver(frame('mine.changed', { dwarfId: OTHER_DWARF }))

    expect(departed.present({ mineId: MINE, dwarfId: DWARF })).toBe(false)
    expect(departed.present({ mineId: MINE, dwarfId: OTHER_DWARF })).toBe(true)
    // Only the Host's frames are heard: nothing is sent to it.
    expect(host.calls).toEqual([{ member: 'subscribe' }])
    departed.dispose()
    expect(host.subscribers).toBe(0)
  })
})
