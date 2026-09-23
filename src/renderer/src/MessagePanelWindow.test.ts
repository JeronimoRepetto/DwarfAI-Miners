// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DOMKeyframesDefinition } from 'motion-v'
import { MotionConfig } from 'motion-v'
import MessagePanelWindow from './MessagePanelWindow.vue'
import type { MotionAnimate, ScheduleAfterRender } from './lib/shell/boundedMotion'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfPaging } from './composables/useDwarfPaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMines } from './composables/useMines'
import {
  BEYOND_REACH_NOTE,
  CONVERSATION_START_NOTE,
  NO_OLDER_PAGES_NOTE
} from './lib/message/feedPages'
// ADDED for #389 — the deadline the window's own leave is bounded by.
import { motionBoundMs } from './lib/shell/motionTiming'
// ADDED for #566 T3 — the root's own MotionConfig transition override.
import { REDUCED_MOTION_TRANSITION } from './lib/shell/presence'
// ADDED for #370 — the faces this window paints with before main answers.
import { DEFAULT_TYPOGRAPHY_PREFERENCES } from './types'

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
    // One page of scrollback (#364), asked for when the reader reaches the top
    // of what the panel holds. A readable answer with nothing older is the
    // quiet default, on the same rule as the feed above.
    getDwarfFeedPage: vi
      .fn()
      .mockResolvedValue({ readable: true, messages: [], reachedStart: true }),
    setWatchedDwarf: vi.fn(),
    sendDwarfText: vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' }),
    /*
     * ADDED for #457 (was: absent). The verdict of a message main HELD arrives
     * on its own push, and this window subscribes to it unconditionally on
     * mount — exactly like `onLaunchFailed` above, and like it, a missing stub
     * would break every test in this file rather than the ones about a hold.
     * The default hears nothing, which is what a delivered send produces.
     */
    onDwarfSendSettled: vi.fn().mockReturnValue(() => undefined),
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
    // ADDED for #389: the one report behind the deferred hide. Fire-and-forget
    // like the height above — main either had a hide waiting on it or did not,
    // and there is no verdict for this window to draw either way.
    reportMessagePanelSettled: vi.fn(),
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
    // A press on a link inside a bubble (#347), on the same rule as the line
    // above: opened is the quiet default, and the refusal path is asserted by
    // the tests that override it.
    openExternalLink: vi.fn().mockResolvedValue({ opened: true }),
    /*
     * AMENDED for #370 (was: absent). This window paints the messaging face, so
     * it adopts the stored faces on mount and subscribes to the change the
     * SHELL makes — both members have to exist even in tests that never open
     * Settings, and `onTypographyPreferences` in particular is subscribed
     * unconditionally like `onLaunchFailed` above. The defaults answer with what
     * the stylesheet already carries. No existing assertion changed.
     */
    getTypographyPreferences: vi.fn().mockResolvedValue({ ...DEFAULT_TYPOGRAPHY_PREFERENCES }),
    onTypographyPreferences: vi.fn().mockReturnValue(() => undefined),
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

/**
 * `props` is new in #566, optional and last so every call above it is
 * untouched: only the motion suite near the bottom of this file ever passes
 * `engine`, to hand the window a hand-written fake in place of the real
 * motion-v import. `afterRender` is its sibling (#566 hotfix), for a test
 * that needs to decide exactly when a scheduled re-apply fires rather than
 * racing motion-v's real `frame.postRender`.
 */
async function mountPanel(
  panel: { surface: string; mineId: string; dwarfId: string },
  overrides: Record<string, unknown> = {},
  props: { engine?: MotionAnimate; afterRender?: ScheduleAfterRender } = {}
) {
  const api = stubApi({ getMessagePanel: vi.fn().mockResolvedValue(panel), ...overrides })
  const wrapper = mount(MessagePanelWindow, { props })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, api }
}

/**
 * The window as it comes up when a dwarf was clicked in the shell: main was
 * asked for the message surface on that dwarf, and this window reads it back.
 */
async function openOn(
  dwarfs: unknown[],
  dwarfId: string,
  overrides: Record<string, unknown> = {},
  props: { engine?: MotionAnimate; afterRender?: ScheduleAfterRender } = {}
) {
  return mountPanel(
    { surface: 'message', mineId: MINE.id, dwarfId },
    {
      getMines: vi.fn().mockResolvedValue({ mines: [{ ...MINE, dwarfs }], tokensObserved: 0 }),
      ...overrides
    },
    props
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

/*
 * AMENDED throughout this file for #436. A held session's exchange used to ride
 * the snapshot on `Dwarf.conversation`, so a held dwarf was one that carried
 * that field. It comes back through `getDwarfFeed` now, marked `source: 'held'`,
 * so a held dwarf here is an ordinary dwarf whose feed says so — which is also
 * the shape main actually publishes.
 */
const HELD_DWARF = {
  ...OBSERVED_DWARF,
  id: 'claude:s2',
  sessionId: 's2',
  name: 'Held'
}

/** What `Runtime.dwarfFeed` answers for a session this panel holds (#436). */
function heldFeed(messages: unknown[]): unknown {
  return { readable: true, messages, source: 'held' }
}

/** The bridge stub for a held dwarf's feed, ready to hand to `openOn`. */
function heldFeedStub(messages: unknown[]): Record<string, unknown> {
  return { getDwarfFeed: vi.fn().mockResolvedValue(heldFeed(messages)) }
}

const HELD_EXCHANGE = [{ role: 'user', text: 'dig here', timestamp: 'then' }]

beforeEach(() => {
  // Every store here is a module-scope singleton, and the delivery ones hold a
  // verdict for a minute while they watch for a reaction — so a test that sent,
  // kicked, answered or launched would leave its state in the next one.
  useMines().clear()
  // The pages a reader scrolled back to are a singleton too (#364), and one
  // left standing would be drawn under the next test's dwarf.
  useDwarfPaging().clear()
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

  /*
   * AMENDED for #436 (was: 'never reads a transcript for a session it is
   * holding: it has the words first-hand', asserting `getDwarfFeed` was never
   * called). It is called now, and the answer is still first-hand: main serves
   * a held session's own rows on that channel in front of any transcript read
   * of it, so the panel gets the better evidence by asking rather than by
   * having been handed it on every poll.
   */
  it('asks main for a held session’s exchange, and is told it is first-hand', async () => {
    const { wrapper, api } = await openOn([HELD_DWARF], 'claude:s2', heldFeedStub(HELD_EXCHANGE))

    expect(api.getDwarfFeed).toHaveBeenCalledWith('claude:s2')
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
    // AMENDED for #383 (was: relying on the default kickDwarf stub's
    // `via: 'terminal'`, asserting the status contained 'Kick handed over via
    // terminal' — true before #329/#383 made the terminal tier end the
    // session outright, which now reports "Ended the session…" instead. This
    // test's point is that a click lands its verdict on this exact panel, not
    // the terminal tier's own wording, so a channel that still only asks,
    // claude-relay, keeps that point covered.)
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: {
            sendText: 'terminal',
            cancel: 'terminal',
            adjustEffort: null,
            attach: 'terminal'
          }
        }
      ],
      'claude:s1',
      { kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'claude-relay' }) }
    )

    // One click since #293: the arm-then-fire confirmation is gone.
    await wrapper.find('.control-kick').trigger('click')
    await flushPromises()

    expect(api.kickDwarf).toHaveBeenCalledWith({ dwarfId: 'claude:s1' })
    // Handed over, never "reacted": only a session SEEN stopping earns that.
    expect(wrapper.find('.panel-status').text()).toContain('Kick handed over via claude-relay')
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
  const WITH_EDIT_ACTIVITY = HELD_DWARF
  // AMENDED for #436: the rows reached the panel on the dwarf, and reach it
  // through the feed now. The line pressed below is the same line.
  const EDIT_FEED = heldFeedStub([
    {
      role: 'assistant' as const,
      text: 'Edited src/main/index.ts',
      timestamp: 't0',
      activity: { kind: 'edit' as const, target: 'src/main/index.ts' }
    }
  ])

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
    const { wrapper, api } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id, EDIT_FEED)

    await openLine(wrapper)
    await flushPromises()

    // The dwarf travels with it as of #348, so main can resolve the path
    // against THIS dwarf's worktree when the mine is folded from several. Still
    // no folder: an id the board can check, exactly like the mine's.
    expect(api.openMinePath).toHaveBeenCalledWith({
      mineId: MINE.id,
      target: 'src/main/index.ts',
      dwarfId: WITH_EDIT_ACTIVITY.id
    })
  })

  it("says out loud main's fixed refusal when the path could not be opened", async () => {
    const { wrapper } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id, {
      ...EDIT_FEED,
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
    const { wrapper } = await openOn([WITH_EDIT_ACTIVITY], WITH_EDIT_ACTIVITY.id, EDIT_FEED)

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
    // AMENDED for #383 (was: relying on the default kickDwarf stub's
    // `via: 'terminal'` to promote to 'reacted' on the next poll — true
    // before #329/#383 made the terminal tier end the session outright,
    // which now stays 'delivered' forever with nothing watched. This test's
    // point is the promotion mechanism itself, so it keeps that covered
    // through a channel that still only asks, claude-relay.)
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: {
            sendText: 'terminal',
            cancel: 'terminal',
            adjustEffort: null,
            attach: 'terminal'
          }
        }
      ],
      'claude:s1',
      { kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'claude-relay' }) }
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
    // AMENDED for #383 (was: relying on the default kickDwarf stub's
    // `via: 'terminal'`. Since the terminal tier now ends the session
    // outright it opens no reaction watch at all, so this assertion would
    // hold trivially — nothing was ever being watched — rather than
    // exercising the "watched, but nothing changed" path this test is
    // actually about. A channel that still only asks, claude-relay, keeps
    // that path genuinely covered.)
    const { wrapper, api } = await openOn(
      [
        {
          ...OBSERVED_DWARF,
          capabilities: {
            sendText: 'terminal',
            cancel: 'terminal',
            adjustEffort: null,
            attach: 'terminal'
          }
        }
      ],
      'claude:s1',
      { kickDwarf: vi.fn().mockResolvedValue({ delivered: true, via: 'claude-relay' }) }
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
  // AMENDED for #443 (was: the question's fields flat on the ask): the wire
  // shape carries the call's questions as a list.
  const PENDING_QUESTION = {
    toolUseId: 'toolu_01',
    questions: [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }]
      }
    ]
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

  /* --- Answering in the person's own words (#481) — one block, appended ---- */

  /** The same dwarf, with its ask drawn at its OWN terminal rather than held. */
  async function openWatchedAsk(overrides: Record<string, unknown> = {}) {
    return openOn(
      [
        {
          ...ASKING_DWARF,
          // AMENDED for #443 (was: `questionCount: 1` beside the channel): the
          // fixture's one-entry `questions` list already says one question.
          pendingQuestion: { ...PENDING_QUESTION, channel: 'terminal' }
        }
      ],
      'claude:s1',
      overrides
    )
  }

  it('carries the typed answer to main over the ANSWER channel, not the message one', async () => {
    // The whole loop #481 reopened: the box is offered again on a watched
    // single-select ask, and what leaves it is an answer for the picker's own
    // "Other" row — never a message, which on that channel writes into the
    // console the picker is drawn in.
    const { wrapper, api } = await openWatchedAsk()
    await wrapper.find('.freeform-input').setValue('put it in Redis')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(api.answerDwarfQuestion).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      text: 'put it in Redis'
    })
    expect(api.sendDwarfText).not.toHaveBeenCalled()
  })

  it('shows main’s reason when the typed answer was refused', async () => {
    const { wrapper } = await openWatchedAsk({
      answerDwarfQuestion: vi.fn().mockResolvedValue({
        answered: false,
        error: 'There was nothing written to send, so nothing was typed.'
      })
    })
    await wrapper.find('.freeform-input').setValue('put it in Redis')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.find('.answer-error').text()).toContain('nothing was typed')
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

  // AMENDED for #436: a held dwarf carried its own `conversation` field, which
  // is why the two cases below used to assert this panel never touched
  // `getDwarfFeed` for one. That field is gone — what says a dwarf is held now
  // is its FEED, not itself — so this is an ordinary dwarf again and the two
  // cases it feeds are named for what actually happens today.
  const HELD_REFRESH_DWARF = {
    ...REFRESH_DWARF,
    id: 'claude:s2',
    sessionId: 's2'
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

  /*
   * AMENDED for #436. This was "never reads a transcript for a session it is
   * holding, even from its own send", pinning that a held dwarf's
   * `conversation` field made a read unnecessary. A held session's words are
   * served by `getDwarfFeed` now, marked `source: 'held'`, exactly like an
   * observed one — and a delivered send is read back sooner for a held
   * session than for an observed one (#428): main records the panel's own
   * message on the exchange the moment the stream takes it, so the row is
   * there to be fetched before the agent has said anything at all.
   */
  it("reads a held session's feed like any other, including after its own send", async () => {
    const { wrapper, api } = await openOn(
      [HELD_REFRESH_DWARF],
      'claude:s2',
      heldFeedStub(HELD_EXCHANGE)
    )
    expect(api.getDwarfFeed).toHaveBeenCalledTimes(1)

    await sendFromPanel(wrapper, 'dig deeper')

    expect(api.getDwarfFeed).toHaveBeenCalledTimes(2)
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

  /*
   * AMENDED for #436 (was: "watches nothing for a held session, which already
   * carries its own words" — asserting `null`, on the reading that a held
   * dwarf's `conversation` field made this push unnecessary). That field is
   * gone: a held session's words are served on demand now, and this push is
   * the ONLY thing that keeps such a session live, since a hosted process
   * writes no transcript and none of the signals the other watch keys on ever
   * move for it.
   */
  it('watches a held session exactly like an observed one', async () => {
    const { api } = await openOn([HELD_REFRESH_DWARF], 'claude:s2')
    expect(api.setWatchedDwarf).toHaveBeenLastCalledWith('claude:s2')
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

  /**
   * The dwarf a launch of `prompt` leaves behind: held, and seeded with it.
   *
   * AMENDED for #436 (was: `conversation: [{ role: 'user', text: prompt, ... }]`
   * — the whole retained exchange, of which the launch receipt was the first
   * row). The receipt is `openingPrompt` now, one row rather than the front of
   * an exchange that rode every snapshot; `launchedDwarfIn` reads that field.
   */
  function launchedDwarf(prompt: string) {
    return {
      id: 'claude:s9',
      provider: 'claude',
      role: 'foreman',
      name: 'Newcomer',
      status: 'working',
      sessionId: 's9',
      openingPrompt: { role: 'user', text: prompt, timestamp: 'then' }
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
   * The reconciliation. The held registry seeds the new session's exchange
   * with the prompt this panel sent, and `Runtime.dwarfFeed` answers it on
   * demand (#436) — so the MessagePanel draws it once it has asked, and
   * prepending a second copy here would show the user's own first words
   * twice, from a source that is not main's record of them.
   */
  it('shows the first message exactly once after the transition', async () => {
    const { wrapper, api } = await openAddPanel({
      getMines: vi.fn().mockResolvedValue({ mines: [MINE], tokensObserved: 0 }),
      ...heldFeedStub([{ role: 'user', text: 'dig the east gallery', timestamp: 'then' }])
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

  /*
   * Issue #523's wiring, end to end: the toggle opens this panel's composer
   * with no chip pressed, and the checkbox beside it collapses #509's two
   * Enters into one. Nothing above this line could tell a missing listener
   * from a dead rule — the Add Panel emits, this window decides where the
   * press goes, and the decision is exactly what this pins.
   */
  it('launches an auto-accepted Jev decision in one Enter, with no chip chosen', async () => {
    // Local spies for the two members this file's stub does not carry by
    // default — asked is exactly what the no-chip Enter must now do, and the
    // assertion has to reach it even though the base stub answers "hidden".
    const askJev = vi.fn().mockResolvedValue({
      kind: 'decision',
      provider: 'claude',
      confidence: 0.9,
      truncated: false
    })
    const { api, wrapper } = await openAddPanel({
      getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
      routeJevLaunch: askJev
    })

    await wrapper.get('.jev-toggle').trigger('click')
    await wrapper.get('.jev-auto').setValue(true)
    await wrapper.find('.launch-input').setValue('dig the east gallery')
    await wrapper.find('.launch-input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(askJev).toHaveBeenCalledWith({ prompt: 'dig the east gallery' })
    // The decision's own provider, applied to the pickers and launched on the
    // same Enter — the second press the card used to demand is gone.
    expect(api.launchHeldSession).toHaveBeenCalledWith({
      mineId: MINE.id,
      provider: 'claude',
      prompt: 'dig the east gallery',
      routedByJev: true
    })
  })
})

/**
 * The sent message on screen at once, with its own verdict (#309).
 *
 * This is where the two halves meet: the store mints the echo before it asks
 * any channel anything, and the panel draws it. The block above pins that the
 * SHELL still hears one verdict per dwarf, and the last test here pins that
 * nothing about an echo has joined that report — the sprite marker's semantics
 * are deliberately untouched.
 */
describe('the sent message, drawn at once (#309)', () => {
  const ECHO_DWARF = { ...OBSERVED_DWARF, lastMessage: '', textDelivery: 'terminal' }

  async function sendFrom(wrapper: VueWrapper, text: string) {
    await wrapper.find('.panel-input').setValue(text)
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
  }

  it('draws the message before any channel has answered, and clears the composer with it', async () => {
    // The delivery never resolves, which is the case the issue is about: a
    // relay that takes seconds, or a terminal that cannot be focused.
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', {
      sendDwarfText: vi.fn(() => new Promise(() => {}))
    })

    await sendFrom(wrapper, 'dig deeper')

    expect(wrapper.find('.message.is-user .bubble').text()).toBe('dig deeper')
    expect(wrapper.find('.bubble-marker').text()).toBe('…')
    expect((wrapper.find('.panel-input').element as HTMLTextAreaElement).value).toBe('')
  })

  it("turns the bubble's own marker into one tick when the delivery lands", async () => {
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1')

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    const marker = wrapper.find('.bubble-marker')
    expect(marker.text()).toBe('✓')
    expect(marker.attributes('title')).toContain('Handed to the session')
  })

  it('marks the bubble with a ✕ and its reason, keeping the words on screen', async () => {
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', {
      sendDwarfText: vi.fn().mockResolvedValue({
        delivered: false,
        via: 'terminal',
        error: 'The terminal would not come forward.'
      })
    })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    expect(wrapper.find('.bubble-marker').text()).toBe('✕')
    expect(wrapper.find('.bubble-marker').attributes('title')).toBe(
      'The terminal would not come forward.'
    )
    expect(wrapper.find('.message.is-user .bubble').text()).toBe('dig deeper')
  })

  it('sends a failed message again from its own bubble, and keeps the failed one marked', async () => {
    const sendDwarfText = vi
      .fn()
      .mockResolvedValueOnce({ delivered: false, via: 'terminal', error: 'nope' })
      .mockResolvedValue({ delivered: true, via: 'claude-relay' })
    const { wrapper, api } = await openOn([ECHO_DWARF], 'claude:s1', { sendDwarfText })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    await wrapper.find('.bubble-retry').trigger('click')
    await flushPromises()

    expect(api.sendDwarfText).toHaveBeenCalledTimes(2)
    expect(api.sendDwarfText).toHaveBeenLastCalledWith({
      dwarfId: 'claude:s1',
      text: 'dig deeper',
      pressEnter: true
    })
    const markers = wrapper.findAll('.bubble-marker')
    expect(markers.map((marker) => marker.text())).toEqual(['✕', '✓'])
  })

  it('shows the words once, not twice, when the transcript catches up', async () => {
    // The reconciliation (#309): a `user` turn with the same words, stamped
    // after the send, IS this message — so the feed's row replaces the echo
    // rather than standing beside it.
    let reads = 0
    const getDwarfFeed = vi.fn(() => {
      reads++
      return Promise.resolve(
        reads === 1
          ? { readable: true, messages: [] }
          : {
              readable: true,
              messages: [
                {
                  role: 'user',
                  text: 'dig deeper',
                  timestamp: new Date(Date.now() + 1_000).toISOString()
                }
              ]
            }
      )
    })
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', { getDwarfFeed })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    const bubbles = wrapper.findAll('.message.is-user .bubble')
    expect(bubbles.map((bubble) => bubble.text())).toEqual(['dig deeper'])
    // The row that survived is the transcript's, which carries no verdict of
    // its own: the session HAS the message now.
    expect(wrapper.find('.bubble-marker').exists()).toBe(false)
  })

  it('keeps the echo when the transcript carries an older turn with the same words', async () => {
    // The near miss: the person said this before, the transcript already had
    // it, and saying it again is exactly why there is an echo.
    const getDwarfFeed = vi.fn().mockResolvedValue({
      readable: true,
      messages: [
        { role: 'user', text: 'dig deeper', timestamp: new Date(Date.now() - 60_000).toISOString() }
      ]
    })
    const { wrapper } = await openOn([ECHO_DWARF], 'claude:s1', { getDwarfFeed })

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    expect(wrapper.findAll('.message.is-user .bubble')).toHaveLength(2)
    expect(wrapper.find('.bubble-marker').text()).toBe('✓')
  })

  it('forgets the echoes when the panel moves to another dwarf, and coming back does not revive them', async () => {
    // The panel is keyed by dwarf, so ANOTHER dwarf's surface draws none of
    // these anyway — going away and coming back is what proves the store let
    // go of them rather than the component merely not asking.
    const SECOND = { ...ECHO_DWARF, id: 'claude:s3', sessionId: 's3', name: 'Digger' }
    const { wrapper, api } = await openOn([ECHO_DWARF, SECOND], 'claude:s1', {
      sendDwarfText: vi.fn(() => new Promise(() => {}))
    })

    await sendFrom(wrapper, 'dig deeper')
    expect(wrapper.find('.message.is-user .bubble').exists()).toBe(true)

    const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
    push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s3' })
    await flushPromises()
    expect(wrapper.find('.message.is-user .bubble').exists()).toBe(false)

    push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' })
    await flushPromises()
    expect(wrapper.find('.message.is-user .bubble').exists()).toBe(false)
  })

  it('reports nothing about an echo to the shell: a dwarf still has one verdict', async () => {
    // #309 adds no wire shape. The sprite marker reads the same two maps it
    // always did, and an echo is renderer-only state that never crosses.
    const { wrapper, api } = await openOn([ECHO_DWARF], 'claude:s1')

    await sendFrom(wrapper, 'dig deeper')
    await flushPromises()

    const last = api.reportDwarfDelivery.mock.lastCall?.[0] as Record<string, unknown>
    expect(Object.keys(last).sort()).toEqual(['kick', 'send'])
    expect(last.send).toEqual({
      'claude:s1': { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
  })
})

/**
 * A press on a link inside a bubble (#347).
 *
 * The same division #279 drew one describe above: this window relays the
 * address and renders whatever main decided, on the same `.notice` line. It
 * validates nothing itself and it opens nothing itself — the browser is main's,
 * and a renderer's word is never a permission.
 */
describe('opening a link inside a bubble', () => {
  const WITH_LINK = HELD_DWARF
  // AMENDED for #436: same rows, now through the feed rather than the dwarf.
  const LINK_FEED = heldFeedStub([
    {
      role: 'assistant' as const,
      text: 'see [the issue](https://example.test/347)',
      timestamp: 't0'
    }
  ])

  it('asks main with the exact address, not the words that carried it', async () => {
    const { wrapper, api } = await openOn([WITH_LINK], HELD_DWARF.id, {
      ...LINK_FEED,
      openExternalLink: vi.fn().mockResolvedValue({ opened: true })
    })

    await wrapper.find('.bubble .markdown-link').trigger('click')
    await flushPromises()

    expect(api.openExternalLink).toHaveBeenCalledWith('https://example.test/347')
  })

  it("says out loud main's fixed refusal when the link could not be opened", async () => {
    const { wrapper } = await openOn([WITH_LINK], HELD_DWARF.id, {
      ...LINK_FEED,
      openExternalLink: vi
        .fn()
        .mockResolvedValue({ opened: false, reason: 'That link could not be opened.' })
    })

    await wrapper.find('.bubble .markdown-link').trigger('click')
    await flushPromises()

    expect(wrapper.find('.notice').text()).toBe('That link could not be opened.')
  })

  it('says nothing when the browser took it', async () => {
    const { wrapper } = await openOn([WITH_LINK], HELD_DWARF.id, {
      ...LINK_FEED,
      openExternalLink: vi.fn().mockResolvedValue({ opened: true })
    })

    await wrapper.find('.bubble .markdown-link').trigger('click')
    await flushPromises()

    expect(wrapper.find('.notice').exists()).toBe(false)
  })
})

/**
 * Paging back through a conversation (#364), wired end to end: the panel
 * reports that the reader reached the top of what it holds, this window asks
 * main for the page before it, and the answer is drawn in front of the newest
 * page without the poll's own pushes ever erasing it.
 *
 * The two facts this block exists for are the ones the issue calls the hard
 * part: the accumulated pages are what the panel renders, and a push after
 * paging back is an ordinary push rather than a feed that lost forty rows.
 */
describe('paging back through the conversation (#364)', () => {
  const PAGED_DWARF = {
    id: 'claude:s1',
    provider: 'claude',
    role: 'foreman',
    name: 'Foreman',
    status: 'working',
    sessionId: 's1',
    lastMessage: '',
    textDelivery: 'terminal'
  }

  const NEWEST = [
    { role: 'assistant' as const, text: 'Halfway down the shaft', timestamp: 't2' },
    { role: 'assistant' as const, text: 'Seam exhausted', timestamp: 't3' }
  ]

  const OLDER = [
    { role: 'assistant' as const, text: 'Starting the shaft', timestamp: 't0' },
    { role: 'assistant' as const, text: 'Through the topsoil', timestamp: 't1' }
  ]

  /** The panel, open on an observed dwarf whose newest page has come back. */
  async function openPaged(overrides: Record<string, unknown> = {}) {
    return openOn([PAGED_DWARF], 'claude:s1', {
      getDwarfFeed: vi.fn().mockResolvedValue({ readable: true, messages: NEWEST }),
      ...overrides
    })
  }

  /** The reader running out of conversation at the top of the list. */
  async function scrollToTop(wrapper: VueWrapper) {
    const list = wrapper.find('.panel-conversation')
    list.element.scrollTop = 0
    await list.trigger('scroll')
    await flushPromises()
  }

  function textsOf(wrapper: VueWrapper): string[] {
    return wrapper.findAll('.bubble').map((bubble) => bubble.text())
  }

  it('asks main for the page before the oldest row it holds', async () => {
    const { wrapper, api } = await openPaged()

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      before: { timestamp: 't2', text: 'Halfway down the shaft' }
    })
  })

  it('draws the page in front of the newest one, oldest at the top', async () => {
    const { wrapper } = await openPaged({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })

    await scrollToTop(wrapper)

    expect(textsOf(wrapper)).toEqual([
      'Starting the shaft',
      'Through the topsoil',
      'Halfway down the shaft',
      'Seam exhausted'
    ])
  })

  it('asks for the page before the page it just drew, walking back one at a time', async () => {
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValueOnce({ readable: true, messages: OLDER, reachedStart: false })
      .mockResolvedValueOnce({
        readable: true,
        messages: [{ role: 'assistant', text: 'Arrived at the mine', timestamp: 't-1' }],
        reachedStart: true
      })
    const { wrapper } = await openPaged({ getDwarfFeedPage })

    await scrollToTop(wrapper)
    await scrollToTop(wrapper)

    expect(getDwarfFeedPage).toHaveBeenLastCalledWith({
      dwarfId: 'claude:s1',
      before: { timestamp: 't0', text: 'Starting the shaft' }
    })
    expect(textsOf(wrapper)[0]).toBe('Arrived at the mine')
  })

  it('says where the conversation begins, and asks for nothing more', async () => {
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: true })
    const { wrapper } = await openPaged({ getDwarfFeedPage })

    await scrollToTop(wrapper)
    expect(wrapper.find('.panel-note').text()).toContain(CONVERSATION_START_NOTE)

    await scrollToTop(wrapper)
    expect(getDwarfFeedPage).toHaveBeenCalledTimes(1)
  })

  it('says a conversation cannot be paged in its own words, never as a beginning', async () => {
    const { wrapper } = await openPaged({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: false, messages: [], reachedStart: false })
    })

    await scrollToTop(wrapper)

    const note = wrapper.find('.panel-note').text()
    expect(note).toContain(NO_OLDER_PAGES_NOTE)
    expect(note).not.toContain(CONVERSATION_START_NOTE)
  })

  it('says the transcript outran the read when the page comes back beyond reach', async () => {
    // The reader is not at the beginning and the panel must not say they are:
    // the file goes on past the window walk's own ceiling, and the rest of it
    // is only reachable in the session's own terminal.
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValue({ readable: true, messages: [], reachedStart: false })
    const { wrapper } = await openPaged({ getDwarfFeedPage })

    await scrollToTop(wrapper)

    const note = wrapper.find('.panel-note').text()
    expect(note).toContain(BEYOND_REACH_NOTE)
    expect(note).not.toContain(CONVERSATION_START_NOTE)

    await scrollToTop(wrapper)
    expect(getDwarfFeedPage).toHaveBeenCalledTimes(1)
  })

  it('keeps every page the reader loaded when the poll pushes a fresh newest one', async () => {
    const { wrapper, api } = await openPaged({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(4)

    // The push the issue names as the hard part (#196): main re-read the
    // watched dwarf's feed on its own pass and carries the newest twelve with
    // the snapshot. Four pages of scrollback must not be the price of it.
    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...PAGED_DWARF, transcriptUpdatedAt: 1_000 }] }],
      tokensObserved: 0,
      watchedFeed: {
        dwarfId: 'claude:s1',
        feed: {
          readable: true,
          messages: [...NEWEST, { role: 'assistant', text: 'Packing up', timestamp: 't4' }]
        }
      }
    })
    await flushPromises()

    expect(textsOf(wrapper)).toEqual([
      'Starting the shaft',
      'Through the topsoil',
      'Halfway down the shaft',
      'Seam exhausted',
      'Packing up'
    ])
  })

  it('does not cry wolf about a shrinking feed on that push (#249)', async () => {
    // The warning is about the NEWEST page losing rows. Measured against the
    // drawn conversation it would fire on every push once somebody had paged
    // back — twelve pushed rows against forty-eight held ones — and a warning
    // that fires twice a second says nothing at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { wrapper, api } = await openPaged({
        getDwarfFeedPage: vi
          .fn()
          .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
      })
      await scrollToTop(wrapper)

      pushSnapshot(api, {
        mines: [{ ...MINE, dwarfs: [{ ...PAGED_DWARF, transcriptUpdatedAt: 1_000 }] }],
        tokensObserved: 0,
        watchedFeed: { dwarfId: 'claude:s1', feed: { readable: true, messages: NEWEST } }
      })
      await flushPromises()

      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('throws the pages away when the panel opens on another dwarf', async () => {
    const SECOND = { ...PAGED_DWARF, id: 'claude:s3', sessionId: 's3', name: 'Digger' }
    const getDwarfFeed = vi.fn((dwarfId: string) =>
      Promise.resolve({
        readable: true,
        messages:
          dwarfId === 'claude:s1'
            ? NEWEST
            : [{ role: 'assistant', text: 'Just arrived at the seam', timestamp: 'u0' }]
      })
    )
    const { wrapper, api } = await openOn([PAGED_DWARF, SECOND], 'claude:s1', {
      getDwarfFeed,
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(4)

    const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
    push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s3' })
    await flushPromises()

    expect(textsOf(wrapper)).toEqual(['Just arrived at the seam'])
  })

  /*
   * AMENDED for #430 (was: 'never pages a held session, which carries its own
   * exchange first-hand', asserting the same call was never made). The claim
   * was reversed by the issue: a held Claude session is a Claude Code process
   * with the same transcript on disk, and it pages back through it like any
   * other. What survives is the ROW-level refusal, which is all HELD_DWARF can
   * exercise — its whole conversation is one turn of the person's, and the
   * transcript may not spell that turn the way this app holds it (see
   * `heldFeedPageCursorOf`). Nothing else in this test changed.
   */
  it('asks for nothing while a held conversation holds only the person’s own words', async () => {
    const { wrapper, api } = await openOn([HELD_DWARF], 'claude:s2')

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).not.toHaveBeenCalled()
  })
})

/**
 * ADDED for #430. A session this panel LAUNCHED pages back through its own
 * transcript, exactly as an observed one does since #364.
 *
 * The held exchange is the newest page — twelve things said, replaced whole by
 * every poll — and the pages read stand in front of it rather than being folded
 * into it, which is the same split the block above pins for an observed
 * session and the same reason: a reader four pages back must not lose them to
 * the session saying one more word.
 */
describe('paging back through a held conversation (#430)', () => {
  const HELD = [
    { role: 'user' as const, text: 'dig here', timestamp: 'h0' },
    { role: 'assistant' as const, text: 'Down the shaft', timestamp: 'h1' },
    { role: 'assistant' as const, text: 'Seam found', timestamp: 'h2' }
  ]

  /*
   * AMENDED for #436: this dwarf carried its own `conversation` field, which
   * is what named it "held" throughout this block. That field is gone — a
   * held session's rows come from `getDwarfFeed` now, marked `source: 'held'`
   * — so `openHeld` below stubs that feed by default, and the test that used
   * to update `conversation` on a push instead pushes a fresh WATCHED FEED,
   * which is how main actually keeps a held session live post-#436 (it writes
   * no transcript signal for the ordinary re-read watch to key on).
   */
  const HELD_PAGED_DWARF = {
    id: 'claude:s4',
    provider: 'claude',
    role: 'foreman',
    name: 'Launched',
    status: 'working',
    sessionId: 's4',
    lastMessage: '',
    textDelivery: 'held'
  }

  const OLDER = [
    { role: 'user' as const, text: 'start here', timestamp: 't0' },
    { role: 'assistant' as const, text: 'Arrived at the mine', timestamp: 't1' }
  ]

  async function openHeld(overrides: Record<string, unknown> = {}) {
    return openOn([HELD_PAGED_DWARF], 'claude:s4', { ...heldFeedStub(HELD), ...overrides })
  }

  async function scrollToTop(wrapper: VueWrapper) {
    const list = wrapper.find('.panel-conversation')
    list.element.scrollTop = 0
    await list.trigger('scroll')
    await flushPromises()
  }

  function textsOf(wrapper: VueWrapper): string[] {
    return wrapper.findAll('.bubble').map((bubble) => bubble.text())
  }

  it('asks main for the page before the oldest turn its agent took', async () => {
    const { wrapper, api } = await openHeld()

    await scrollToTop(wrapper)

    // Never the person's own row above it: the transcript's `user` record for a
    // send is not always this app's spelling of it, and a cursor the file does
    // not hold would come back as a conversation that had reached its start.
    expect(api.getDwarfFeedPage).toHaveBeenCalledWith({
      dwarfId: 'claude:s4',
      before: { timestamp: 'h1', text: 'Down the shaft' }
    })
  })

  it('draws the page in front of the held exchange, oldest at the top', async () => {
    const { wrapper } = await openHeld({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })

    await scrollToTop(wrapper)

    expect(textsOf(wrapper)).toEqual([
      'start here',
      'Arrived at the mine',
      'dig here',
      'Down the shaft',
      'Seam found'
    ])
  })

  it('asks for the page before the page it just drew, walking back one at a time', async () => {
    const getDwarfFeedPage = vi
      .fn()
      .mockResolvedValueOnce({ readable: true, messages: OLDER, reachedStart: false })
      .mockResolvedValueOnce({ readable: true, messages: [], reachedStart: true })
    const { wrapper } = await openHeld({ getDwarfFeedPage })

    await scrollToTop(wrapper)
    await scrollToTop(wrapper)

    // Off the PAGE's own oldest row now, whichever half of the exchange it is:
    // every row of it came out of the transcript, so the ordinary rule applies.
    expect(getDwarfFeedPage).toHaveBeenLastCalledWith({
      dwarfId: 'claude:s4',
      before: { timestamp: 't0', text: 'start here' }
    })
  })

  it('keeps every page the reader loaded when the poll pushes a fresh exchange', async () => {
    const { wrapper, api } = await openHeld({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: true, messages: OLDER, reachedStart: false })
    })
    await scrollToTop(wrapper)
    expect(textsOf(wrapper)).toHaveLength(5)

    // A held session's newest words arrive on the WATCHED FEED push now
    // (#436): main reads `Runtime.dwarfFeed` on its own pass because this
    // panel reported it as the watched dwarf, and replaces `selectedFeed`
    // whole with it — this is the push the issue names as the hard part for a
    // launched session, and the pages in front of it belong to the reader's
    // own scroll rather than to whatever the push carried.
    pushSnapshot(api, {
      mines: [{ ...MINE, dwarfs: [{ ...HELD_PAGED_DWARF, lastMessage: 'Packing up' }] }],
      tokensObserved: 0,
      watchedFeed: {
        dwarfId: 'claude:s4',
        feed: heldFeed([...HELD, { role: 'assistant', text: 'Packing up', timestamp: 'h3' }])
      }
    })
    await flushPromises()

    expect(textsOf(wrapper)).toEqual([
      'start here',
      'Arrived at the mine',
      'dig here',
      'Down the shaft',
      'Seam found',
      'Packing up'
    ])
  })

  it('says a held session cannot be paged in its own words when its provider says so', async () => {
    // The Antigravity case, decided where it belongs: the provider has no
    // transcript filed for this dwarf and answers null, main turns that into
    // `readable: false`, and the panel says the one sentence that is true. Not
    // the held/observed distinction, which is what refused it before.
    const { wrapper, api } = await openHeld({
      getDwarfFeedPage: vi
        .fn()
        .mockResolvedValue({ readable: false, messages: [], reachedStart: false })
    })

    await scrollToTop(wrapper)

    expect(api.getDwarfFeedPage).toHaveBeenCalled()
    const note = wrapper.find('.panel-note').text()
    expect(note).toContain(NO_OLDER_PAGES_NOTE)
    expect(note).not.toContain(CONVERSATION_START_NOTE)
  })
})

/**
 * ADDED for #389. The window's own motion: the surface rises when the window
 * arrives, and settles before it goes.
 *
 * The two halves are asymmetric on purpose, because the window's two moments
 * are. Main creates or re-places it HIDDEN and the first height report is what
 * reveals it (#312), so an entering surface has somewhere to wait: it holds its
 * hidden keyframe from the moment the surface opens and rises in the same turn
 * as the report that shows the window. A LEAVE has nothing equivalent — main
 * would hide the window in the frame the state changed — so main defers the
 * hide until this window says the surface has settled, which is what
 * `reportMessagePanelSettled` is.
 *
 * What jsdom cannot prove is the part a compositor owns: that the first painted
 * frame after `show()` is the hidden keyframe rather than the panel popping in
 * and then animating. Nothing here lays out, paints, or runs a real animation.
 * What these hold is the ORDER the renderer puts the two in, which is the whole
 * of what the renderer controls.
 */
describe('rising into place and settling before the window goes', () => {
  /**
   * A surface as tall as what it contains, and 0 while it contains nothing —
   * `fakeContentMeasurement`'s rule above, restated here because the enter
   * hangs off the FIRST report and a constant height would fire one before
   * either panel exists.
   */
  function fakeContentHeight(height: number) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.querySelector('.message-panel, .add-panel') === null ? 0 : height
      }
    })
    return { restore: () => Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight') }
  }

  /**
   * A hand-written stand-in for motion-v's own `animate()` — AMENDED for #566
   * (was: stubbing `HTMLElement.prototype.animate`, WAAPI's own entry point,
   * which the runner no longer calls). `engine` is handed to
   * `mountPanel`/`openOn` as a prop (`createBoundedMotion({ animate })`);
   * `HTMLElement.prototype.animate` still gets a bare stub below, because
   * `still()` reads its mere PRESENCE as the app's proxy for "a real
   * Chromium window" and never calls it.
   *
   * AMENDED again for #566: no `timing` argument any more — the runner
   * passes `animate()` no transition at all now, so a fake that recorded one
   * would be recording something the real call site never sends.
   */
  function fakeAnimations(order: string[] = []) {
    const runs: {
      element: Element
      keyframes: DOMKeyframesDefinition
      finish: () => void
      cancel: ReturnType<typeof vi.fn>
    }[] = []
    const animate: MotionAnimate = (element, keyframes) => {
      order.push('animate')
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const cancel = vi.fn()
      runs.push({ element, keyframes, finish, cancel })
      return {
        cancel,
        then: (onResolve: () => void, onReject?: () => void) => finished.then(onResolve, onReject)
      }
    }
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: () => undefined
    })
    return {
      runs,
      order,
      engine: animate,
      restore: () => Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    }
  }

  /** Reduced motion, or the ordinary machine that has not asked for it. */
  function prefersReducedMotion(reduced: boolean) {
    const media = new EventTarget() as MediaQueryList
    Object.defineProperty(media, 'matches', { configurable: true, value: reduced })
    vi.stubGlobal('matchMedia', () => media)
    return media
  }

  const RISE: DOMKeyframesDefinition = { opacity: [0, 1], y: [12, 0] }
  const SETTLE: DOMKeyframesDefinition = { opacity: [1, 0], y: [0, 12] }

  /** The close both windows make, which is the only close there is. */
  function closePanel(api: Record<string, ReturnType<typeof vi.fn>>): void {
    const push = api.onMessagePanel!.mock.calls[0]![0] as (state: unknown) => void
    push(CLOSED)
  }

  /**
   * A hand-written stand-in for the scheduler `run`'s ender uses to re-apply
   * `settle` after the engine's own deferred render (#566 T2b), mirroring
   * `boundedMotion.test.ts`'s own `fakeAfterRender`: it only RECORDS what it
   * was asked to schedule, so a test can decide exactly when a re-apply fires
   * instead of racing jsdom's `requestAnimationFrame`.
   */
  function fakeAfterRender() {
    const scheduled: (() => void)[] = []
    const afterRender: ScheduleAfterRender = (callback) => {
      scheduled.push(callback)
    }
    return { afterRender, scheduled }
  }

  /** Report the window as Chromium sees it once main has actually hidden it. */
  function occludeWindow(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    Reflect.deleteProperty(document, 'hidden')
  })

  it('holds the surface at its hidden keyframe while the window is still hidden', async () => {
    // The board that decides which dwarf to draw lands after the surface does
    // (#312), so this is the real gap between "a surface opened" and "there is
    // something to measure" — and the window is hidden for all of it.
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    let settleBoard!: (snapshot: unknown) => void
    const board = new Promise<unknown>((resolve) => {
      settleBoard = resolve
    })
    try {
      const { wrapper, api } = await mountPanel(
        { surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' },
        { getMines: vi.fn().mockReturnValue(board) },
        { engine: animated.engine }
      )
      const surface = wrapper.find('.message-surface').element as HTMLElement
      expect(surface.style.opacity).toBe('0')
      expect(surface.style.transform).toBe('translateY(12px)')
      expect(api.setMessagePanelHeight).not.toHaveBeenCalled()
      expect(animated.runs).toHaveLength(0)

      settleBoard({ mines: [{ ...MINE, dwarfs: [OBSERVED_DWARF] }], tokensObserved: 0 })
      await flushPromises()

      expect(animated.runs).toHaveLength(1)
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  it('rises on the surface itself, with the shell’s own timing, once the report has gone', async () => {
    const measured = fakeContentHeight(426)
    const order: string[] = []
    const animated = fakeAnimations(order)
    try {
      const { wrapper, api } = await openOn(
        [OBSERVED_DWARF],
        'claude:s1',
        { setMessagePanelHeight: vi.fn(() => order.push('report')) },
        { engine: animated.engine }
      )
      expect(api.setMessagePanelHeight).toHaveBeenCalledWith(426)
      // The report is what reveals the window, so the rise may only be started
      // after it: started first, the surface would spend part of its motion
      // animating inside a window nobody can see yet.
      expect(order).toEqual(['report', 'animate'])
      expect(animated.runs[0]!.element).toBe(wrapper.find('.message-surface').element)
      // No transition is asked for any more (#566) — the runner hands
      // motion-v only the keyframes, and lets `getDefaultTransition` pick.
      expect(animated.runs[0]!.keyframes).toEqual(RISE)
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  it('leaves the surface drawn at full strength once the rise has finished', async () => {
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    try {
      const { wrapper } = await openOn(
        [OBSERVED_DWARF],
        'claude:s1',
        {},
        { engine: animated.engine }
      )
      const surface = wrapper.find('.message-surface').element as HTMLElement
      animated.runs[0]!.finish()
      await flushPromises()
      // Cleared BEFORE the run is let go: this window's own `releaseHidden`
      // owns writing that state, exactly as it did under WAAPI's `fill:
      // 'both'` — motion-v would otherwise leave its own last frame sitting
      // on the element with nothing to hand it back (`releaseWritten` in
      // `boundedMotion.ts` only does that for a caller with no `settle`).
      expect(surface.style.opacity).toBe('')
      expect(surface.style.transform).toBe('')
      expect(animated.runs[0]!.cancel).toHaveBeenCalledOnce()
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  it('keeps the conversation on screen through the leave, and tells main only when it has settled', async () => {
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    try {
      const { wrapper, api } = await openOn(
        [OBSERVED_DWARF],
        'claude:s1',
        {},
        { engine: animated.engine }
      )
      animated.runs[0]!.finish()
      await flushPromises()

      closePanel(api)
      await flushPromises()

      // The window is still up, so what it draws has to be the panel itself:
      // an empty surface fading is the content vanishing and a transparent box
      // settling after it.
      expect(wrapper.find('.message-panel').exists()).toBe(true)
      expect(animated.runs[1]!.keyframes).toEqual(SETTLE)
      expect(api.reportMessagePanelSettled).not.toHaveBeenCalled()

      animated.runs[1]!.finish()
      await flushPromises()

      expect(wrapper.find('.message-panel').exists()).toBe(false)
      expect(api.reportMessagePanelSettled).toHaveBeenCalledOnce()
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  it('still tells main when the leave never reports finishing (#266)', async () => {
    // Chromium freezes the document timeline for an occluded window, so the
    // settle lands on the compositor and `finished` never resolves. Main bounds
    // the hide on its own side too; this is the renderer not being the reason
    // it has to.
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    try {
      const { api } = await openOn([OBSERVED_DWARF], 'claude:s1', {}, { engine: animated.engine })
      animated.runs[0]!.finish()
      await flushPromises()
      vi.useFakeTimers()

      closePanel(api)
      await flushPromises()
      expect(api.reportMessagePanelSettled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(motionBoundMs(SETTLE))
      await flushPromises()

      expect(api.reportMessagePanelSettled).toHaveBeenCalledOnce()
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  it('takes the instant path under reduced motion, in both directions', async () => {
    prefersReducedMotion(true)
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    try {
      const { wrapper, api } = await openOn([OBSERVED_DWARF], 'claude:s1')
      const surface = wrapper.find('.message-surface').element as HTMLElement
      expect(animated.runs).toHaveLength(0)
      expect(surface.style.opacity).toBe('')

      closePanel(api)
      await flushPromises()

      expect(animated.runs).toHaveLength(0)
      expect(wrapper.find('.message-panel').exists()).toBe(false)
      // Immediately, and that is the point of the report rather than a fixed
      // deferral: a window left up for a third of a second with nothing drawn
      // in it is a transparent rectangle taking clicks off whatever is behind.
      expect(api.reportMessagePanelSettled).toHaveBeenCalledOnce()
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  it('cuts between two dwarfs of one open window, rather than animating the swap', async () => {
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    try {
      const { wrapper, api } = await openOn(
        [OBSERVED_DWARF, HELD_DWARF],
        'claude:s1',
        {},
        { engine: animated.engine }
      )
      animated.runs[0]!.finish()
      await flushPromises()

      const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
      push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s2' })
      await flushPromises()

      expect(wrapper.find('.panel-agent').text()).toBe('Held')
      expect(animated.runs).toHaveLength(1)
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  it('gives a reopen inside the leave the window that is still there', async () => {
    // Main defers the hide, so a second click landing inside that wait finds
    // the window still up. The leave loses its say — reporting it settled would
    // hide a window that is open again — and the surface it had been taking
    // away is drawn at full strength.
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    try {
      const { wrapper, api } = await openOn(
        [OBSERVED_DWARF],
        'claude:s1',
        {},
        { engine: animated.engine }
      )
      animated.runs[0]!.finish()
      await flushPromises()

      closePanel(api)
      await flushPromises()

      const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
      push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' })
      await flushPromises()
      animated.runs[1]!.finish()
      await flushPromises()

      const surface = wrapper.find('.message-surface').element as HTMLElement
      expect(wrapper.find('.message-panel').exists()).toBe(true)
      expect(surface.style.opacity).toBe('')
      expect(api.reportMessagePanelSettled).not.toHaveBeenCalled()
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  /*
   * ADDED for the #566 hotfix. User-visible on main and in release 0.12.1:
   * open a mine, click a dwarf, click again to close, repeat — on about the
   * third open/close the reopened panel is invisible. The leave that closes
   * this window ends with `settle = holdHidden` and a re-apply left pending
   * (#566 T2b); main hides the actual window before that scheduled frame
   * ever renders, so it stays outstanding. On reopen `armRise` releases the
   * element and writes `holdHidden` itself, then `riseWhenRevealed` takes
   * the INSTANT path (`motion.still` is true while `document.hidden`) and
   * writes `releaseHidden` directly — it never calls `run()`, which used to
   * be the only thing that withdrew a stale re-apply. Once frames resume,
   * the leave's stale re-apply fired anyway and wrote `holdHidden` back over
   * the now-revealed surface.
   */
  it('withdraws the closed leave’s pending re-apply on reopen, so a late frame cannot re-hide the risen surface', async () => {
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    const after = fakeAfterRender()
    try {
      const { wrapper, api } = await openOn(
        [OBSERVED_DWARF],
        'claude:s1',
        {},
        { engine: animated.engine, afterRender: after.afterRender }
      )
      animated.runs[0]!.finish()
      await flushPromises()

      // The rise's own completion schedules a re-apply too (T2b); it stays in
      // `after.scheduled` — the fake never removes what it recorded, same
      // rule as `boundedMotion.test.ts`'s own `fakeAfterRender` — so the
      // LEAVE's own re-apply, scheduled below, is whichever entry lands last.
      const beforeLeave = after.scheduled.length

      // The leave: settles at `holdHidden` and ends with a re-apply pending —
      // main hides the real window before that scheduled frame ever runs.
      closePanel(api)
      await flushPromises()
      animated.runs[1]!.finish()
      await flushPromises()
      expect(after.scheduled.length).toBe(beforeLeave + 1)
      const staleReapply = after.scheduled[after.scheduled.length - 1]!

      const surface = wrapper.find('.message-surface').element as HTMLElement
      expect(surface.style.opacity).toBe('0')

      occludeWindow(true)

      // Reopen while the window is still hidden: `armRise` -> height report
      // -> `riseWhenRevealed`'s instant path, never `run()`.
      const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
      push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' })
      await flushPromises()

      expect(surface.style.opacity).toBe('')
      expect(surface.style.transform).toBe('')

      // Frames resume and the leave's stale re-apply fires. It must not
      // write the panel invisible over the reopened surface.
      occludeWindow(false)
      staleReapply()

      expect(surface.style.opacity).toBe('')
      expect(surface.style.transform).toBe('')
    } finally {
      animated.restore()
      measured.restore()
    }
  })

  /*
   * ADDED for the follow-up to the #566 hotfix. A reopen (same dwarf, or a
   * different one — the two examples that motivated `claim`) landing while
   * the leave it is reopening on top of is STILL IN FLIGHT lands on the CUT
   * branch of the `panel` watch, below (verified: `drawn.value.surface`
   * stays whatever it was before the leave, since only `settleAndLeave`'s
   * OWN completion ever sets it to `'none'` — a leave still running has not
   * reached that yet, so `messageSurfaceMotion` reads both sides as
   * non-`'none'` and returns `'cut'`, never `'enter'`). The cut branch used
   * to call `release`, which — once ending an active run stopped
   * withdrawing its own fresh re-apply (the fold's own need, above) — would
   * leave THIS leave's re-apply standing to fire `holdHidden` later, right
   * over the `releaseHidden` the cut branch itself had just written. `claim`
   * closes that: it withdraws the re-apply its own ending schedules too.
   */
  it('withdraws even an in-flight leave’s own re-apply when a reopen cuts it off, so a late frame cannot re-hide it', async () => {
    const measured = fakeContentHeight(426)
    const animated = fakeAnimations()
    const after = fakeAfterRender()
    try {
      const { wrapper, api } = await openOn(
        [OBSERVED_DWARF],
        'claude:s1',
        {},
        { engine: animated.engine, afterRender: after.afterRender }
      )
      animated.runs[0]!.finish()
      await flushPromises()

      closePanel(api)
      await flushPromises()
      // The leave's own run (animated.runs[1]) is deliberately left
      // unfinished: it is still ACTIVE when the reopen below lands, exactly
      // like a fast double-click. The rise's own completion, above, already
      // scheduled its own re-apply into `after.scheduled` — the fake never
      // removes what it recorded, the same rule as `boundedMotion.test.ts`'s
      // own `fakeAfterRender` — so the leave's own re-apply, checked below,
      // is whichever entry lands last.
      expect(animated.runs).toHaveLength(2)
      const beforeCut = after.scheduled.length

      const push = api.onMessagePanel.mock.calls[0]![0] as (state: unknown) => void
      push({ surface: 'message', mineId: MINE.id, dwarfId: 'claude:s1' })
      await flushPromises()

      // No third `animate()` call: the cut branch never runs a new motion,
      // it only ends the leave and writes the element's state directly —
      // confirming this reopen really did land on the CUT branch.
      expect(animated.runs).toHaveLength(2)
      // Ending the in-flight leave through `claim` still schedules a
      // re-apply of its OWN settle (T2b) — `claim` withdraws it right after,
      // rather than never scheduling one at all.
      expect(after.scheduled.length).toBe(beforeCut + 1)
      const staleReapply = after.scheduled[after.scheduled.length - 1]!

      const surface = wrapper.find('.message-surface').element as HTMLElement
      // The cut branch's own write stands: released, never held hidden.
      expect(surface.style.opacity).toBe('')
      expect(surface.style.transform).toBe('')

      // Frames resume and the leave's own re-apply fires. It must not write
      // `holdHidden` back over what the cut branch just released.
      staleReapply()

      expect(surface.style.opacity).toBe('')
      expect(surface.style.transform).toBe('')
    } finally {
      animated.restore()
      measured.restore()
    }
  })
})

/**
 * Typography preferences (#370) — APPENDED, nothing above changed.
 *
 * The SECOND root, and the reason the preference needs a push at all. Settings
 * is in the shell; the bubbles and the Add Panel are here, and this window has
 * its own document — so a face chosen over there has to reach this page rather
 * than wait for a reload it may never get.
 */
describe('typography preferences (#370)', () => {
  it('adopts the stored faces on mount, painting its own document root', async () => {
    await mountPanel(CLOSED, {
      getTypographyPreferences: vi
        .fn()
        .mockResolvedValue({ interfaceFont: 'tiny5', messagingFont: 'roboto' })
    })
    expect(document.documentElement.style.getPropertyValue('--font-conversation')).toBe(
      'var(--font-family-roboto)'
    )
  })

  it('follows a change made in the shell, which is the only window with Settings', async () => {
    const { api } = await mountPanel(CLOSED)
    const push = api.onTypographyPreferences.mock.calls[0]![0] as (preferences: {
      interfaceFont: string
      messagingFont: string
    }) => void
    push({ interfaceFont: 'arial', messagingFont: 'arial' })
    await flushPromises()
    expect(document.documentElement.style.getPropertyValue('--font-pixel')).toBe(
      'var(--font-family-arial)'
    )
    expect(document.documentElement.style.getPropertyValue('--font-conversation')).toBe(
      'var(--font-family-arial)'
    )
  })

  it('draws the Add Panel in the messaging face, the same one the bubbles use', async () => {
    // #370's own complaint: the launch panel was the one conversation surface
    // still on the Pixel UI face. Asserted through the class the stylesheet
    // hangs `var(--font-conversation)` on, because a `<style scoped>` block has
    // no import a test could read (see designTokens.test.ts, which pins the
    // declaration itself).
    const { wrapper } = await mountPanel({ surface: 'launch', mineId: MINE.id, dwarfId: '' })
    expect(wrapper.find('.add-panel').exists()).toBe(true)
  })
})

/**
 * APPENDED for #566 T3. This window's own `<MotionConfig>` — see `reduced`,
 * `MessagePanelWindow.vue`'s own comment. Stubbed the way `App.test.ts`'s
 * matching root test does, for the one query `sceneMotion` owns.
 */
describe('MessagePanelWindow MotionConfig root (#566 T3)', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia')
  })

  function stubReducedMotion(matches: boolean): void {
    const media = new EventTarget() as MediaQueryList
    Object.defineProperty(media, 'matches', { configurable: true, value: matches })
    vi.stubGlobal('matchMedia', () => media)
  }

  it('hands MotionConfig "never" and no transition override when the viewer asked for no such thing', async () => {
    stubReducedMotion(false)
    const { wrapper } = await mountPanel(CLOSED)
    const config = wrapper.findComponent(MotionConfig)
    expect(config.props('reducedMotion')).toBe('never')
    expect(config.props('transition')).toBeUndefined()
  })

  it('hands MotionConfig "always" and REDUCED_MOTION_TRANSITION once sceneMotion reports reduced motion', async () => {
    stubReducedMotion(true)
    const { wrapper } = await mountPanel(CLOSED)
    const config = wrapper.findComponent(MotionConfig)
    expect(config.props('reducedMotion')).toBe('always')
    expect(config.props('transition')).toEqual(REDUCED_MOTION_TRANSITION)
  })
})
