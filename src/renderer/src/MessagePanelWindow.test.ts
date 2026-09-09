// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MessagePanelWindow from './MessagePanelWindow.vue'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMines } from './composables/useMines'

/*
 * The message panel's own window (#162).
 *
 * MOVED HERE FROM App.test.ts, whole and by subject, because the surfaces they
 * are about moved: the MessagePanel and the Add Panel are a second
 * BrowserWindow beside the shell now, the way the design draws them, so a test
 * that clicked a dwarf in the mine and then looked at the panel was asserting
 * across two processes. The blocks that came over are named in App.test.ts's
 * own header where they stood.
 *
 * What changed in each of them is the OPENING GESTURE and nothing else. The
 * shell no longer hands this window a selection; it asks main for a surface,
 * and main tells this window (see MessagePanelState). So `openOn` below stands
 * in for "a dwarf was clicked over there", and every assertion about what the
 * panel then shows, reads, sends and refuses is the one that was already there.
 */

const CLOSED = { surface: 'none' as const, mineId: '', dwarfId: '' }

/**
 * Full window.api stub, on the same rule App.test.ts states at length: anything
 * the window AWAITS resolves the shape its contract declares, and anything
 * fire-and-forget is a plain spy.
 *
 * A bare `vi.fn()` resolves `undefined`, and both delivery stores read their
 * verdict off the result the moment it lands — outside the `catch`, which means
 * "the panel lost contact with the app" rather than "what came back was
 * garbage". Since the send is fired without being awaited, the throw one line
 * later becomes an unhandled rejection that lands after the test has already
 * passed: `Errors 1 error`, exit 1, every test green.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    hidePanel: vi.fn(),
    // Fire-and-forget: this window reports its own presses so main can raise
    // it, and there is no verdict to render (#162, #165).
    raisePanel: vi.fn(),
    getMines: vi.fn().mockResolvedValue({ mines: [], tokensObserved: 0 }),
    onMinesUpdated: vi.fn().mockReturnValue(() => undefined),
    // The launch-failure push (#263), subscribed unconditionally on mount —
    // see useAgentLaunch's listenFailures. Not wrapped in a try/catch the way
    // the awaited launch members are, so a missing stub here would break
    // every test in this file rather than just the ones about a launch.
    onLaunchFailed: vi.fn().mockReturnValue(() => undefined),
    // Answers "a window was focused", the verdict that leaves the panel alone.
    activateDwarf: vi.fn().mockResolvedValue({ focused: true, openedTerminal: false, feed: [] }),
    // An observed session's transcript, read on selection (#159); a
    // readable-but-empty answer is the quiet default.
    getDwarfFeed: vi.fn().mockResolvedValue({ readable: true, messages: [] }),
    setWatchedDwarf: vi.fn(),
    sendDwarfText: vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' }),
    kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' }),
    retireDwarf: vi.fn(),
    answerDwarfQuestion: vi.fn().mockResolvedValue({ answered: true }),
    answerDwarfPermission: vi.fn().mockResolvedValue({ answered: true }),
    // The state main holds for both windows (#162). Answering with the request
    // is what main does when it can satisfy it.
    getMessagePanel: vi.fn().mockResolvedValue(CLOSED),
    setMessagePanel: vi.fn().mockImplementation((state: unknown) => Promise.resolve(state)),
    onMessagePanel: vi.fn().mockReturnValue(() => undefined),
    setMessagePanelHeight: vi.fn(),
    reportDwarfDelivery: vi.fn(),
    // The launch surface (#86). Claude detected and launchable is the ordinary
    // machine; a launch answers "started", which claims no dwarf.
    listAgentProviders: vi.fn().mockResolvedValue({
      providers: [{ provider: 'claude', installed: true, launchable: true }]
    }),
    launchHeldSession: vi.fn().mockResolvedValue({ launched: true }),
    // A click on an activity line's own path (#279). Opened is the quiet
    // default; individual tests override it to assert the refusal path.
    openMinePath: vi.fn().mockResolvedValue({ opened: true }),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

const MINE = {
  id: 'mine:c:\\x\\anvil',
  path: 'C:\\x\\anvil',
  name: 'anvil',
  tier: 'bronze',
  dwarfs: [],
  tokensObserved: 0,
  updatedAt: 0
}

/**
 * Every mounted window, so afterEach can take it down again.
 *
 * Unmounting is not tidiness here, it is correctness: the mines store is a
 * module-scope singleton, so a window left mounted still holds the dwarf it was
 * opened on and still answers the next test's snapshot pushes — reading a feed
 * through whatever api stub happens to be installed by then. Which is one
 * test's assertion counting another test's reads.
 */
const mounted: VueWrapper[] = []

async function mountPanel(
  panel: { surface: string; mineId: string; dwarfId: string },
  overrides: Record<string, unknown> = {}
) {
  const api = stubApi({ getMessagePanel: vi.fn().mockResolvedValue(panel), ...overrides })
  const wrapper = mount(MessagePanelWindow)
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, api }
}

/**
 * The window as it comes up when a dwarf was clicked in the shell: main was
 * asked for the message surface on that dwarf, and this window reads it back.
 */
async function openOn(dwarfs: unknown[], dwarfId: string, overrides: Record<string, unknown> = {}) {
  return mountPanel(
    { surface: 'message', mineId: MINE.id, dwarfId },
    {
      getMines: vi.fn().mockResolvedValue({ mines: [{ ...MINE, dwarfs }], tokensObserved: 0 }),
      ...overrides
    }
  )
}

/** The poll, as main publishes it to this window too (#162). */
function pushSnapshot(api: Record<string, ReturnType<typeof vi.fn>>, snapshot: unknown) {
  const push = api.onMinesUpdated!.mock.calls[0]![0] as (snapshot: unknown) => void
  push(snapshot)
}

const OBSERVED_DWARF = {
  id: 'claude:s1',
  provider: 'claude',
  role: 'foreman',
  name: 'Foreman',
  status: 'working',
  sessionId: 's1',
  lastMessage: 'Halfway down the shaft'
}

const HELD_DWARF = {
  ...OBSERVED_DWARF,
  id: 'claude:s2',
  sessionId: 's2',
  name: 'Held',
  conversation: [{ role: 'user', text: 'dig here', timestamp: 'then' }]
}

beforeEach(() => {
  // Every store here is a module-scope singleton, and the delivery ones hold a
  // verdict for a minute while they watch for a reaction — so a test that sent,
  // kicked, answered or launched would leave its state in the next one.
  useMines().clear()
  useDwarfMessaging().clearAll()
  useDwarfKicking().clearAll()
  useDwarfQuestion().clearAll()
  useAgentLaunch().close()
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('the message panel window', () => {
  it('draws nothing at all until main says what to show', async () => {
    const { wrapper } = await mountPanel(CLOSED)
    expect(wrapper.find('.message-panel').exists()).toBe(false)
    expect(wrapper.find('.add-panel').exists()).toBe(false)
  })

  it('opens on the dwarf main named, with no mine anywhere near it', async () => {
    // The mine stays in the shell: that is the whole point of the second
    // window, and the design's own mock draws the two side by side.
    const { wrapper } = await openOn([OBSERVED_DWARF], 'claude:s1')
    expect(wrapper.find('.message-panel').exists()).toBe(true)
    expect(wrapper.find('.panel-agent').text()).toBe('Foreman')
    expect(wrapper.find('.mine-scene').exists()).toBe(false)
  })

  it('adopts a surface main pushes after it is already up', async () => {
    // The shell can select a dwarf while this window is open on another one,
    // or on nothing: the push is how it hears, and there is no other route.
    const { wrapper, api } = await mountPanel(CLOSED, {
      getMines: vi
        .fn()
        .mockResolvedValue({ mines: [{ ...MINE, dwarfs: [OBSERVED_DWARF] }], tokensObserved: 0 })
    })
    expect(wrapper.find('.message-panel').exists()).toBe(false)

    const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
    push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' })
    await flushPromises()

    expect(wrapper.find('.message-panel').exists()).toBe(true)
    expect(wrapper.find('.panel-agent').text()).toBe('Foreman')
  })

  it('closes itself through main, so the shell hears about it', async () => {
    // The halo on the sprite is drawn from the state main holds, so a panel
    // that closed only locally would leave a dwarf marked selected forever.
    const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1')

    await wrapper.find('.panel-close').trigger('click')
    await flushPromises()

    expect(api.setMessagePanel).toHaveBeenLastCalledWith(CLOSED)
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it('raises its OWN window on a press, never the shell', async () => {
    // Both are frameless transparent windows the platform does not reliably
    // bring forward (#165), and main answers for the sender — so a press on
    // the composer must not raise the other window instead of this one.
    const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1')
    await wrapper.find('.message-window').trigger('pointerdown')
    expect(api.raisePanel).toHaveBeenCalledOnce()
  })

  it("reads an observed session's transcript, and shows what came back", async () => {
    const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1', {
      getDwarfFeed: vi.fn().mockResolvedValue({
        readable: true,
        messages: [{ role: 'assistant', text: 'Blasting the last metre', timestamp: 'now' }]
      })
    })

    expect(api.getDwarfFeed).toHaveBeenCalledWith('claude:s1')
    expect(wrapper.find('.bubble').text()).toBe('Blasting the last metre')
    expect(wrapper.find('.panel-note').text()).toContain('Latest activity')
  })

  it('never reads a transcript for a session it is holding: it has the words first-hand', async () => {
    const { wrapper, api } = await openOn([HELD_DWARF], 'claude:s2')

    expect(api.getDwarfFeed).not.toHaveBeenCalled()
    expect(wrapper.find('.bubble').text()).toBe('dig here')
    expect(wrapper.find('.panel-note').text()).toContain('holding this session')
  })

  it('sends what was typed over the ordinary message channel', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1'
    )

    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.sendDwarfText).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      text: 'dig deeper',
      pressEnter: true
    })
    // The verdict has to LAND, not just be asked for. Asserting it is what
    // makes a stub that resolves the wrong shape fail this test outright,
    // instead of rejecting into the void after it has already passed: the send
    // is fire-and-forget, so nothing else in the app would ever notice.
    expect(wrapper.find('.panel-status').text()).toContain('Handed over via terminal')
  })

  it('kicks through the panel, and the verdict lands where it was asked for', async () => {
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
        }
      ],
      'claude:s1'
    )

    // One click since #293: the arm-then-fire confirmation is gone.
    await wrapper.find('.control-kick').trigger('click')
    await flushPromises()

    expect(api.kickDwarf).toHaveBeenCalledWith({ dwarfId: 'claude:s1' })
    // Handed over, never "reacted": only a session SEEN stopping earns that.
    expect(wrapper.find('.panel-status').text()).toContain('Kick handed over via terminal')
    expect(wrapper.find('.panel-status').text()).not.toContain('the session reacted')
  })

  /*
   * AMENDED (#192, then #162 for the gesture). This used to assert the panel
   * DROPPED when its dwarf left the board, which threw the conversation away —
   * final reply included — at the one moment a person is most likely to be
   * reading it. The panel stays on the dwarf as the board last reported it,
   * says the session has ended, and waits to be closed by hand.
   */
  it('keeps the panel on the last known dwarf when it walks out of the mine, and says so', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1',
      {
        getDwarfFeed: vi.fn().mockResolvedValue({
          readable: true,
          messages: [{ role: 'assistant', text: 'Blasting the last metre', timestamp: 'now' }]
        })
      }
    )
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeUndefined()

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()

    expect(wrapper.find('.message-panel').exists()).toBe(true)
    expect(wrapper.find('.panel-agent').text()).toBe('Foreman')
    expect(wrapper.find('.bubble').text()).toBe('Blasting the last metre')
    // Ended is said in words, and typing into a session that is gone is
    // refused with the same words rather than handed to main to refuse.
    expect(wrapper.find('.panel-note').text()).toContain('ended')
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.panel-input').attributes('title')).toContain('ended')
  })

  it("leaves closing an ended session's panel to the person", async () => {
    const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1')

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()
    expect(wrapper.find('.message-panel').exists()).toBe(true)

    await wrapper.find('.panel-close').trigger('click')
    await flushPromises()
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it('says out loud when the session’s own console could not be brought forward', async () => {
    // The sentence used to be the shell's, beside the mine. The click that
    // raises a console is here now, so the answer to it is too — including the
    // failure, which is the only part of it anybody has to read.
    const { wrapper } = await openOn([OBSERVED_DWARF], 'claude:s1', {
      activateDwarf: vi.fn().mockResolvedValue({ focused: false, openedTerminal: false, feed: [] })
    })

    await wrapper.find('.panel-agent').trigger('click')
    await flushPromises()

    expect(wrapper.find('.notice').text()).toContain('could not be opened')
  })
})

/**
 * A click on an `edit`/`read` activity line's own path (#279). Resolution and
 * verification both happen in main — this window only relays the mine id and
 * the target, and renders whatever main decided on the same `.notice` status
 * line `activate`'s own console-not-opened case already uses.
 */
describe('opening an activity line’s path', () => {
  const WITH_EDIT_ACTIVITY = {
    ...HELD_DWARF,
    conversation: [
      {
        role: 'assistant' as const,
        text: 'Edited src/main/index.ts',
        timestamp: 't0',
        activity: { kind: 'edit' as const, target: 'src/main/index.ts' }
      }
    ]
  }

  /**
   * #294 folded the run this line belongs to into one collapsed disclosure row,
   * so reaching the line is a press first. The three tests below are AMENDED
   * with that press and nothing else — what each claims about the relay is what
   * it claimed before.
   */
  async function openLine(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('.activity-disclosure').trigger('click')
    await wrapper.find('.activity-line').trigger('click')
  }

  it('asks main with the current mine id and the exact target, not the display text', async () => {
    const { wrapper, api } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id)

    await openLine(wrapper)
    await flushPromises()

    expect(api.openMinePath).toHaveBeenCalledWith({
      mineId: MINE.id,
      target: 'src/main/index.ts'
    })
  })

  it("says out loud main's fixed refusal when the path could not be opened", async () => {
    const { wrapper } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id, {
      openMinePath: vi.fn().mockResolvedValue({
        opened: false,
        reason: "That path is outside this mine's folder."
      })
    })

    await openLine(wrapper)
    await flushPromises()

    expect(wrapper.find('.notice').text()).toBe("That path is outside this mine's folder.")
  })

  it('says nothing when the file opened successfully', async () => {
    const { wrapper } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id)

    await openLine(wrapper)
    await flushPromises()

    expect(wrapper.find('.notice').exists()).toBe(false)
  })
})

/**
 * The verdicts this window is the only writer of, published to the shell so the
 * mine can draw each one on the sprite it belongs to (#162).
 *
 * The stores used to be fed by MineScene, from the crew of the one mine it drew.
 * They live here now because this window is the one that sends and kicks, and a
 * watch for a reaction can only be resolved where it was opened.
 */
describe('publishing the delivery verdicts', () => {
  it('reports a send the moment its verdict lands', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1'
    )

    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const last = api.reportDwarfDelivery.mock.lastCall?.[0] as {
      send: Record<string, { phase: string }>
    }
    expect(last.send['claude:s1']?.phase).toBe('delivered')
  })

  it('reports plain objects, because a Vue proxy cannot cross the bridge', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1'
    )

    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    // structuredClone is what Electron's IPC does with the payload: a reactive
    // proxy throws there, and the throw would land in main rather than here.
    const last = api.reportDwarfDelivery.mock.lastCall?.[0]
    expect(() => structuredClone(last)).not.toThrow()
  })

  /*
   * MOVED from MineScene.test.ts's 'MineScene reaction feed' block (#162),
   * whole: the two stores are fed here now, and a scene that folded the poll
   * in from the other window could never resolve a watch this one opened.
   */
  it('promotes a delivered kick when the next poll shows the session stopped', async () => {
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
        }
      ],
      'claude:s1'
    )
    await wrapper.find('.control-kick').trigger('click')
    await flushPromises()
    expect(useDwarfKicking().stateFor('claude:s1')?.phase).toBe('delivered')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...OBSERVED_DWARF, status: 'waiting' }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(useDwarfKicking().stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('promotes a delivered message when the next poll shows new output', async () => {
    const { wrapper, api } = await openOn(
      [{ ...OBSERVED_DWARF, textDelivery: 'terminal' }],
      'claude:s1'
    )
    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(useDwarfMessaging().stateFor('claude:s1')?.phase).toBe('delivered')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...OBSERVED_DWARF, lastMessage: 'On it' }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(useDwarfMessaging().stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('leaves a delivery alone while nothing about the session changed', async () => {
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
        }
      ],
      'claude:s1'
    )
    await wrapper.find('.control-kick').trigger('click')
    await flushPromises()

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [OBSERVED_DWARF] }], tokensObserved: 0 })
    await flushPromises()

    // Delivered is what happened; 'reacted' would be a claim nothing supports.
    expect(useDwarfKicking().stateFor('claude:s1')?.phase).toBe('delivered')
  })
})

/**
 * How tall the window is (#162).
 *
 * The design's four sizing rules are still `lib/message/panelHeight`'s; what
 * this window adds is that the answer becomes the WINDOW's height. It measures
 * the surface it drew, which is the one reading that covers both panels — the
 * MessagePanel sets its own height and can be dragged, the Add Panel is
 * content-driven — and it means a drag on the panel's own handle resizes the
 * window with nothing extra wired to it.
 */
describe('reporting its own height', () => {
  /** jsdom lays nothing out and ships no ResizeObserver; both are faked here. */
  function fakeMeasurement(height: number) {
    const observers: { callback: () => void; target: HTMLElement | null }[] = []
    class FakeResizeObserver {
      target: HTMLElement | null = null
      constructor(public callback: () => void) {
        observers.push(this)
      }
      observe(element: HTMLElement) {
        this.target = element
      }
      disconnect() {
        this.target = null
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return height
      }
    })
    return {
      observers,
      restore: () => {
        vi.unstubAllGlobals()
        Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
      }
    }
  }

  it('reports the surface it measured, in design pixels', async () => {
    const measured = fakeMeasurement(235)
    try {
      const { api } = await openOn([OBSERVED_DWARF], 'claude:s1')
      // The page is zoomed by main, so what the renderer measures IS the
      // design world — which is the only unit main will take.
      expect(api.setMessagePanelHeight).toHaveBeenCalledWith(235)
    } finally {
      measured.restore()
    }
  })

  it('observes the surface, so a drag on the panel’s handle resizes the window', async () => {
    const measured = fakeMeasurement(578)
    try {
      const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1')
      const observer = measured.observers[0]
      expect(observer?.target).toBe(wrapper.find('.message-surface').element)

      api.setMessagePanelHeight.mockClear()
      observer?.callback()
      expect(api.setMessagePanelHeight).toHaveBeenCalledWith(578)
    } finally {
      measured.restore()
    }
  })

  it('reports again whenever the surface changes, so a hidden window is revealed', async () => {
    // The window is created HIDDEN and the first height report is what reveals
    // the window — see setMessagePanelHeight in main/shell/window.ts. Leaving that to
    // the ResizeObserver alone would leave the window hidden whenever the new
    // surface happens to be exactly as tall as the last one — a panel that
    // looks as though the click did nothing.
    const measured = fakeMeasurement(235)
    try {
      const { api } = await mountPanel(CLOSED, {
        getMines: vi
          .fn()
          .mockResolvedValue({ mines: [{ ...MINE, dwarfs: [OBSERVED_DWARF] }], tokensObserved: 0 })
      })
      api.setMessagePanelHeight.mockClear()

      const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
      push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' })
      await flushPromises()

      expect(api.setMessagePanelHeight).toHaveBeenCalledWith(235)
    } finally {
      measured.restore()
    }
  })

  it('reports nothing at all before anything has been laid out', async () => {
    // A height of zero is not a height: main refuses it, and a window of no
    // height is a panel that looks as though it never opened.
    const { api } = await openOn([OBSERVED_DWARF], 'claude:s1')
    expect(api.setMessagePanelHeight).not.toHaveBeenCalled()
  })

  /**
   * A surface that measures what it actually CONTAINS, with no observer
   * watching it change (#312).
   *
   * `fakeMeasurement` above answers one constant height whatever is on the
   * page, and that is what hid the first open of a run: it makes the report
   * fired from `onMounted` succeed before either panel exists, so the ORDER
   * the two answers arrive in never mattered. A real surface is 0 tall until
   * it holds a panel, and this getter says so.
   *
   * No ResizeObserver on purpose, and jsdom shipping none is the real
   * situation rather than an approximation of it: the panel window is created
   * hidden, a hidden window's frames are not drawn, and the observer callback
   * is delivered as part of drawing one. So the observer that backs up a
   * VISIBLE window is exactly what the open that has to reveal it cannot have.
   */
  function fakeContentMeasurement(height: number) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.querySelector('.message-panel, .add-panel') === null ? 0 : height
      }
    })
    return { restore: () => Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight') }
  }

  /** An answer from main this test holds back, so the two can land in one order. */
  function deferred<T>() {
    let settle: (value: T) => void = () => undefined
    const promise = new Promise<T>((resolve) => {
      settle = resolve
    })
    return { promise, settle }
  }

  it('reports the height once the dwarf’s panel mounts, not only when the surface changes', async () => {
    // The first open of a run, in the order the two answers actually arrive
    // (#312): main names the surface, and the board that decides WHICH dwarf
    // is drawn lands afterwards. So the report the surface change fires
    // measures a surface with nothing in it yet, and the one thing that
    // reveals the window is a report — which makes the panel that appears when
    // the board lands the moment there is finally something to say.
    const measured = fakeContentMeasurement(426)
    const board = deferred<unknown>()
    try {
      const { wrapper, api } = await mountPanel(
        { surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' },
        { getMines: vi.fn().mockReturnValue(board.promise) }
      )
      expect(wrapper.find('.message-panel').exists()).toBe(false)
      expect(api.setMessagePanelHeight).not.toHaveBeenCalled()

      board.settle({ mines: [{ ...MINE, dwarfs: [OBSERVED_DWARF] }], tokensObserved: 0 })
      await flushPromises()

      expect(wrapper.find('.message-panel').exists()).toBe(true)
      expect(api.setMessagePanelHeight).toHaveBeenCalledWith(426)
    } finally {
      measured.restore()
    }
  })

  it('reports again for the next dwarf, whose panel is a fresh one of its own height', async () => {
    // Selecting another dwarf never changes the SURFACE — it stays 'message' —
    // so the watch that only followed the surface left this to the observer,
    // which says nothing when the two panels happen to be the same height.
    const measured = fakeContentMeasurement(300)
    try {
      const { api } = await openOn([OBSERVED_DWARF, HELD_DWARF], 'claude:s1')
      api.setMessagePanelHeight.mockClear()

      const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
      push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s2' })
      await flushPromises()

      expect(api.setMessagePanelHeight).toHaveBeenCalledWith(300)
    } finally {
      measured.restore()
    }
  })
})

/**
 * The whole answer loop through the real components (#125): a question reaches
 * the panel on a snapshot, an option is chosen, and Enter releases the agent's
 * own blocked tool call over the answer channel.
 */
describe('answering an agent question', () => {
  const PENDING_QUESTION = {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }]
  }

  const ASKING_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'waiting',
    sessionId: 's1',
    pendingQuestion: PENDING_QUESTION
  }

  async function openAskingDwarf(overrides: Record<string, unknown> = {}) {
    return openOn([ASKING_DWARF], 'claude:s1', overrides)
  }

  it('answers the ask with the agent’s own words, over the answer channel', async () => {
    const { wrapper, api } = await openAskingDwarf()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.answerDwarfQuestion).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which database should the importer write to?': 'SQLite' }
    })
    // Free text is a different channel; answering must not have used it.
    expect(api.sendDwarfText).not.toHaveBeenCalled()
  })

  it('leaves the question standing after the answer was released', async () => {
    // Only main's next snapshot may drop a pendingQuestion. Clearing it here
    // would claim the ask was closed on the panel's own say-so.
    const { wrapper } = await openAskingDwarf()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.find('.question-card .question-text').text()).toBe(
      'Which database should the importer write to?'
    )
    expect(wrapper.find('.answer-ok').exists()).toBe(true)
  })

  it('shows main’s reason when the answer was refused', async () => {
    const { wrapper } = await openAskingDwarf({
      answerDwarfQuestion: vi.fn().mockResolvedValue({
        answered: false,
        error: 'That session is not one this panel is holding.'
      })
    })
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.find('.answer-error').text()).toBe(
      'That session is not one this panel is holding.'
    )
  })
})

/**
 * The whole decision loop through the real components (#203): a permission
 * prompt reaches the panel on a snapshot, Allow is chosen, and Enter releases
 * the blocked tool call over the permission channel — a sibling loop to the
 * question one above, over a sibling channel.
 */
describe('deciding a permission prompt', () => {
  const BLOCKED_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'waiting',
    sessionId: 's1',
    pendingPermission: {
      toolUseId: 'toolu_09',
      toolName: 'Bash',
      input: 'rm -rf /tmp/scratch',
      askedAt: '2026-09-05T09:00:00.000Z'
    }
  }

  it('shows the permission card, sends the decision over its own channel, and leaves it standing', async () => {
    const { wrapper, api } = await openOn([BLOCKED_DWARF], 'claude:s1')
    expect(wrapper.find('.permission-card').exists()).toBe(true)

    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.permission-card').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.answerDwarfPermission).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_09',
      decision: 'allow'
    })
    // Only main's next snapshot may drop a pendingPermission — the panel's
    // part ends at handing the decision over.
    expect(wrapper.find('.permission-card').exists()).toBe(true)
  })
})

/**
 * The feed for an observed dwarf used to refresh only when `lastMessage`
 * changed — the assistant's own last text — so a human turn typed into the
 * terminal, or sent from this panel, sat invisible until the agent next spoke
 * (#183). Two remedies, smallest first: re-read on the panel's OWN successful
 * send, and watch a second signal — `transcriptUpdatedAt`, the transcript's
 * raw mtime — that moves for any writer, not only the assistant.
 */
describe('feed refresh (#183)', () => {
  const REFRESH_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'Halfway down the shaft',
    textDelivery: 'terminal'
  }

  const HELD_REFRESH_DWARF = {
    ...REFRESH_DWARF,
    id: 'claude:s2',
    sessionId: 's2',
    conversation: [{ role: 'user', text: 'dig here', timestamp: 'then' }]
  }

  async function openRefreshDwarf(overrides: Record<string, unknown> = {}) {
    return openOn([REFRESH_DWARF], 'claude:s1', overrides)
  }

  async function sendFromPanel(wrapper: VueWrapper, text: string) {
    await wrapper.find('.panel-input').setValue(text)
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }

  it("re-reads the feed once the panel's own send lands, without waiting for the agent to reply", async () => {
    const { wrapper, api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.sendDwarfText).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      text: 'dig deeper',
      pressEnter: true
    })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(api.getDwarfFeed).toHaveBeenLastCalledWith('claude:s1')
  })

  it('does not re-read a failed delivery: nothing proves the tail moved', async () => {
    const { wrapper, api } = await openRefreshDwarf({
      sendDwarfText: vi.fn().mockResolvedValue({
        delivered: false,
        via: 'terminal',
        error: 'The terminal would not come forward.'
      })
    })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
  })

  it('never reads a transcript for a session it is holding, even from its own send', async () => {
    // Held sessions carry their exchange first-hand on `conversation`; a
    // delivered send must not open a second, second-hand channel for it.
    const { wrapper, api } = await openOn([HELD_REFRESH_DWARF], 'claude:s2')
    expect(api.getDwarfFeed).not.toHaveBeenCalled()

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.getDwarfFeed).not.toHaveBeenCalled()
  })

  it('drops a delivered send’s refresh once the panel is no longer open on that dwarf', async () => {
    // The relay can take seconds; the user is free to close the panel, or pick
    // another dwarf, before it answers. A stale delivery must not fetch a feed
    // nobody is looking at any more.
    let resolveSend: (value: { delivered: boolean; via: string }) => void = () => {}
    const sendDwarfText = vi.fn(
      () =>
        new Promise<{ delivered: boolean; via: string }>((resolve) => {
          resolveSend = resolve
        })
    )
    const { wrapper, api } = await openRefreshDwarf({ sendDwarfText })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    await wrapper.find('.panel-close').trigger('click')
    await flushPromises()
    resolveSend({ delivered: true, via: 'terminal' })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the transcript-movement signal changes, even when lastMessage does not', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
  })

  it('stays put on an ordinary poll where neither signal moved', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [REFRESH_DWARF] }], tokensObserved: 0 })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
  })

  /*
   * #192: the assistant's final reply and the session's end can land inside
   * one poll, so the snapshot that first shows the dwarf leaving is the first
   * that can read that reply — and the last: once the grace window drops the
   * dwarf, main no longer answers for it, and a read then would replace the
   * words with "no transcript". One more read, at the leaving edge, never after.
   */
  it('re-reads once when the dwarf turns leaving, and not again once the board drops it', async () => {
    const getDwarfFeed = vi
      .fn()
      .mockResolvedValueOnce({
        readable: true,
        messages: [{ role: 'assistant', text: 'Halfway down the shaft', timestamp: 't1' }]
      })
      .mockResolvedValue({
        readable: true,
        messages: [{ role: 'assistant', text: 'Seam exhausted, packing up.', timestamp: 't2' }]
      })
    const { wrapper, api } = await openRefreshDwarf({ getDwarfFeed })
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, status: 'leaving' }] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.bubble').text()).toBe('Seam exhausted, packing up.')

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [] }], tokensObserved: 0 })
    await flushPromises()

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.bubble').text()).toBe('Seam exhausted, packing up.')
  })

  /*
   * The maintainer's follow-up on #195: `readSelectedFeed` used to blank
   * `selectedFeed` to `undefined` before every await, not only the first one
   * for a dwarf — so a re-read for the SAME dwarf rebuilt the row list from
   * nothing while its answer was still in flight. That is what made a busy
   * session's panel look frozen: rows arrive below the fold and the list
   * snaps back to empty (and, via DwarfMessagePanel's own scroll, to the top)
   * before the same words reappear a moment later. The READING note is for
   * the first read of a dwarf only — a re-read keeps the previous result on
   * screen until the new one lands.
   */
  it('keeps the previous feed on screen while a re-read for the same dwarf is in flight', async () => {
    let resolveSecond: (value: { readable: boolean; messages: unknown[] }) => void = () => {}
    const getDwarfFeed = vi
      .fn()
      .mockResolvedValueOnce({
        readable: true,
        messages: [{ role: 'assistant', text: 'Halfway down the shaft', timestamp: 't1' }]
      })
      .mockImplementationOnce(
        () =>
          new Promise<{ readable: boolean; messages: unknown[] }>((resolve) => {
            resolveSecond = resolve
          })
      )
    const { wrapper, api } = await openRefreshDwarf({ getDwarfFeed })
    expect(wrapper.find('.bubble').text()).toBe('Halfway down the shaft')

    pushSnapshot(api, {
      // lastMessage cleared: conversationOf falls back to it while feed is
      // undefined, and that fallback would otherwise show the very same words
      // and mask a wrongful blank — this way a regression here has nothing
      // else to fall back to.
      mines: [
        { ...MINE, dwarfs: [{ ...REFRESH_DWARF, lastMessage: '', transcriptUpdatedAt: 1_000 }] }
      ],
      tokensObserved: 0
    })
    await flushPromises()

    // The second read is in flight and unresolved: the previous message must
    // stay on screen, and the note must not flash back to "reading" — a
    // re-read for the SAME dwarf is not a first read.
    expect(wrapper.find('.bubble').text()).toBe('Halfway down the shaft')
    expect(wrapper.find('.panel-note').text()).toContain('Latest activity')

    resolveSecond({
      readable: true,
      messages: [{ role: 'assistant', text: 'Seam exhausted, packing up.', timestamp: 't2' }]
    })
    await flushPromises()

    expect(wrapper.find('.bubble').text()).toBe('Seam exhausted, packing up.')
  })

  it('blanks back to the reading note when the panel switches to a different dwarf', async () => {
    // A change of dwarf IS a first read again — unlike the re-read above, the
    // previous dwarf's words must not linger under a different dwarf's name.
    // lastMessage cleared on both: conversationOf otherwise falls back to it
    // while feed is undefined, which would show a bubble either way and mask
    // a wrongful non-blank on the switch.
    const FIRST_DWARF = { ...REFRESH_DWARF, lastMessage: '' }
    const SECOND_DWARF = {
      ...REFRESH_DWARF,
      id: 'claude:s3',
      sessionId: 's3',
      name: 'Digger',
      lastMessage: ''
    }
    let resolveSecondDwarfFeed: (value: {
      readable: boolean
      messages: unknown[]
    }) => void = () => {}
    const getDwarfFeed = vi.fn((dwarfId: string) => {
      if (dwarfId === FIRST_DWARF.id) {
        return Promise.resolve({
          readable: true,
          messages: [{ role: 'assistant', text: 'Halfway down the shaft', timestamp: 't1' }]
        })
      }
      return new Promise<{ readable: boolean; messages: unknown[] }>((resolve) => {
        resolveSecondDwarfFeed = resolve
      })
    })
    const { wrapper, api } = await openOn([FIRST_DWARF, SECOND_DWARF], 'claude:s1', {
      getDwarfFeed
    })
    expect(wrapper.find('.bubble').text()).toBe('Halfway down the shaft')

    // The switch is the shell selecting somebody else, which reaches this
    // window as a pushed state rather than as a click in the mine.
    const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
    push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s3' })
    await flushPromises()

    expect(wrapper.find('.bubble').exists()).toBe(false)
    expect(wrapper.find('.panel-note').text()).toContain('Reading')

    resolveSecondDwarfFeed({
      readable: true,
      messages: [{ role: 'assistant', text: 'Just arrived at the seam.', timestamp: 't2' }]
    })
    await flushPromises()
    expect(wrapper.find('.bubble').text()).toBe('Just arrived at the seam.')
  })

  /**
   * The push riding the SAME snapshot as the board (#196): main reads the
   * watched dwarf's feed on its own pass and carries it with the poll,
   * instead of this panel noticing the moved signal and pulling a second
   * time over its own round trip.
   */
  describe('adopting a pushed feed (#196)', () => {
    it('adopts a pushed feed for the open dwarf without an extra getDwarfFeed call', async () => {
      const { wrapper, api } = await openRefreshDwarf()
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0,
        watchedFeed: {
          dwarfId: 'claude:s1',
          feed: {
            readable: true,
            messages: [
              { role: 'assistant', text: 'Pushed straight from the poll', timestamp: 't2' }
            ]
          }
        }
      })
      await flushPromises()

      // The very signal that would ordinarily trigger a pull already arrived
      // WITH its feed, so the watch must not pull a second time for it.
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
      expect(wrapper.find('.bubble').text()).toBe('Pushed straight from the poll')
    })

    it('still pulls once on the first selection, before any push has arrived', async () => {
      const { api } = await openRefreshDwarf()

      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)
      expect(api.getDwarfFeed).toHaveBeenCalledWith('claude:s1')
    })

    it('ignores a pushed feed for a dwarf this panel is no longer open on', async () => {
      const { wrapper, api } = await openRefreshDwarf()
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

      await wrapper.find('.panel-close').trigger('click')
      await flushPromises()

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0,
        watchedFeed: {
          dwarfId: 'claude:s1',
          feed: {
            readable: true,
            messages: [{ role: 'assistant', text: 'late arrival', timestamp: 't2' }]
          }
        }
      })
      await flushPromises()

      expect(wrapper.find('.message-panel').exists()).toBe(false)
    })

    it('still falls back to a pull when the snapshot carries no watched feed', async () => {
      const { api } = await openRefreshDwarf()
      expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...REFRESH_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0
      })
      await flushPromises()

      expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
    })
  })

  it('tells main which observed dwarf it has open, so the poll can carry its feed', async () => {
    const { api } = await openRefreshDwarf()
    expect(api.setWatchedDwarf).toHaveBeenLastCalledWith('claude:s1')
  })

  it('watches nothing for a held session, which already carries its own words', async () => {
    const { api } = await openOn([HELD_REFRESH_DWARF], 'claude:s2')
    expect(api.setWatchedDwarf).toHaveBeenLastCalledWith(null)
  })
})

/**
 * The Add Panel, wired end to end (#86): the mine's Add action asks main for
 * the launch surface, submitting starts a held session in that mine's folder,
 * and the panel hands over to the MessagePanel when the dwarf it started turns
 * up on an ordinary poll.
 */
describe('the add panel', () => {
  const OTHER_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: 'Halfway down the shaft'
  }

  /** The dwarf a launch of `prompt` leaves behind: held, and seeded with it. */
  function launchedDwarf(prompt: string) {
    return {
      id: 'claude:s9',
      provider: 'claude',
      role: 'foreman',
      name: 'Newcomer',
      status: 'working',
      sessionId: 's9',
      conversation: [{ role: 'user', text: prompt, timestamp: 'then' }]
    }
  }

  async function openAddPanel(overrides: Record<string, unknown> = {}) {
    return mountPanel({ surface: 'launch', mineId: MINE.id, dwarfId: '' }, overrides)
  }

  async function submitPrompt(wrapper: VueWrapper, prompt: string) {
    await wrapper.findAll('.provider-chip')[0]!.trigger('click')
    await wrapper.find('.launch-input').setValue(prompt)
    await wrapper.find('.launch-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }

  it('opens on the launch surface main was asked for', async () => {
    const { wrapper } = await openAddPanel()
    expect(wrapper.find('.add-panel').exists()).toBe(true)
  })

  it('asks main which providers this machine has when it opens', async () => {
    const { api, wrapper } = await openAddPanel()

    expect(api.listAgentProviders).toHaveBeenCalled()
    expect(wrapper.findAll('.provider-chip').map((chip) => chip.text())).toEqual([
      'claude',
      'Other'
    ])
  })

  /*
   * The design gives both panels the same place — the transition is one
   * replacing the other — so they cannot both be there. Which of them is drawn
   * follows the surface main holds, and this window is the only place that
   * decision is made.
   */
  it('takes the place of an open MessagePanel', async () => {
    const { wrapper, api } = await openOn([OTHER_DWARF], 'claude:s1')
    expect(wrapper.find('.message-panel').exists()).toBe(true)

    const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
    push({ surface: 'launch', mineId: MINE.id, dwarfId: '' })
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it('gives it back when a dwarf is selected instead', async () => {
    const { wrapper, api } = await mountPanel(
      { surface: 'launch', mineId: MINE.id, dwarfId: '' },
      {
        getMines: vi
          .fn()
          .mockResolvedValue({ mines: [{ ...MINE, dwarfs: [OTHER_DWARF] }], tokensObserved: 0 })
      }
    )
    expect(wrapper.find('.add-panel').exists()).toBe(true)

    const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
    push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' })
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(false)
    expect(wrapper.find('.message-panel').exists()).toBe(true)
  })

  it('closes from its own close control, through main', async () => {
    const { wrapper, api } = await openAddPanel()

    await wrapper.find('.launch-close').trigger('click')
    await flushPromises()

    expect(api.setMessagePanel).toHaveBeenLastCalledWith(CLOSED)
    expect(wrapper.find('.add-panel').exists()).toBe(false)
  })

  it('does not start a fresh panel when the same surface arrives twice', async () => {
    // `open()` starts a FRESH panel, so a repeated state — the shell
    // re-publishing, a push landing after the pull — would silently discard a
    // prompt somebody was half-way through typing.
    const { wrapper, api } = await openAddPanel()
    await wrapper.findAll('.provider-chip')[0]!.trigger('click')
    await wrapper.find('.launch-input').setValue('dig the east gallery')
    await flushPromises()

    const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
    push({ surface: 'launch', mineId: MINE.id, dwarfId: '' })
    await flushPromises()

    expect(wrapper.find<HTMLTextAreaElement>('.launch-input').element.value).toBe(
      'dig the east gallery'
    )
  })

  it('starts a held session in the mine it was opened from', async () => {
    const { wrapper, api } = await openAddPanel()

    await submitPrompt(wrapper, 'dig the east gallery')

    expect(api.launchHeldSession).toHaveBeenCalledWith({
      mineId: MINE.id,
      provider: 'claude',
      prompt: 'dig the east gallery'
    })
  })

  /*
   * The verdict says a session STARTED and claims no dwarf, so the panel
   * acknowledges from the verdict and waits — it must not look like nothing
   * happened for the two seconds before the poll finds the session.
   */
  it('acknowledges the launch and keeps the prompt on screen while it spawns', async () => {
    const { wrapper } = await openAddPanel()

    await submitPrompt(wrapper, 'dig the east gallery')

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.launch-first-message').text()).toBe('dig the east gallery')
  })

  it('hands over to the MessagePanel when the launched dwarf arrives', async () => {
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [launchedDwarf('dig the east gallery')] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(false)
    expect(wrapper.find('.message-panel').exists()).toBe(true)
    expect(wrapper.find('.panel-agent').text()).toBe('Newcomer')
  })

  it('tells main which dwarf the launch produced, so the mine can halo it', async () => {
    // Only this window can know: the handover is decided by the launch's own
    // arrival rules, from the board, here. The shell draws its halo from the
    // state main holds, so a handover nobody published is a dwarf that starts
    // work with no mark on it.
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [launchedDwarf('dig the east gallery')] }],
      tokensObserved: 0
    })
    await flushPromises()

    expect(api.setMessagePanel).toHaveBeenLastCalledWith({
      surface: 'message',
      mineId: MINE.id,
      dwarfId: 'claude:s9'
    })
  })

  /*
   * The reconciliation. The held registry seeds the new session's conversation
   * with the prompt this panel sent, so the MessagePanel already draws it —
   * prepending a second copy here would show the user's own first words twice,
   * and the copy that survives is main's record rather than this panel's
   * optimism about it.
   */
  it('shows the first message exactly once after the transition', async () => {
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [launchedDwarf('dig the east gallery')] }],
      tokensObserved: 0
    })
    await flushPromises()

    const said = wrapper
      .findAll('.message .bubble')
      .filter((bubble) => bubble.text() === 'dig the east gallery')
    expect(said).toHaveLength(1)
  })

  it('keeps waiting while only an unrelated session turns up', async () => {
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 })
    })
    await submitPrompt(wrapper, 'dig the east gallery')

    pushSnapshot(api, { mines: [{ ...MINE, dwarfs: [OTHER_DWARF] }], tokensObserved: 0 })
    await flushPromises()

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.message-panel').exists()).toBe(false)
  })

  it('stays open with main own reason when the launch is refused', async () => {
    const { wrapper } = await openAddPanel({
      launchHeldSession: vi
        .fn()
        .mockResolvedValue({ launched: false, error: 'Claude Code is not installed.' })
    })

    await submitPrompt(wrapper, 'dig the east gallery')

    expect(wrapper.find('.add-panel').exists()).toBe(true)
    expect(wrapper.find('.launch-alert').text()).toBe('Claude Code is not installed.')
  })

  /*
   * The failure channel (#263), end to end: main pushes what it learned
   * AFTER `agent:launch` already answered `launched: true`, and the panel
   * returns to the composer with the CLI's own words rather than staying
   * parked on "the session started" forever.
   */
  it('returns to the composer with the CLI’s own words when the launch fails after it started', async () => {
    const { wrapper, api } = await openAddPanel({
      listAgentProviders: vi.fn().mockResolvedValue({
        providers: [{ provider: 'codex', installed: true, launchable: true }]
      }),
      launchAgent: vi
        .fn()
        .mockResolvedValue({ launched: true, provider: 'codex', launchId: 'receipt:1' })
    })

    await submitPrompt(wrapper, 'dig the east gallery')
    // The detached wait, before anything failed.
    expect(wrapper.find('.launch-note').exists()).toBe(true)
    expect(wrapper.find('.launch-alert').exists()).toBe(false)

    const fail = api.onLaunchFailed.mock.calls[0]![0] as (push: unknown) => void
    fail({
      launchId: 'receipt:1',
      provider: 'codex',
      mineId: MINE.id,
      exitCode: 1,
      stderrTail: 'codex: another instance is already running'
    })
    await flushPromises()

    expect(wrapper.find('.launch-alert').text()).toBe('codex: another instance is already running')
    // The composer is back, prompt intact, so a retry costs one click.
    expect(wrapper.find<HTMLTextAreaElement>('.launch-input').element.value).toBe(
      'dig the east gallery'
    )
  })
})
