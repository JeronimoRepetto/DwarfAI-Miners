// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  MESSAGE_PANEL_ASK_HEIGHT,
  MESSAGE_PANEL_MAX_HEIGHT,
  MESSAGE_PANEL_MIN_HEIGHT,
  initialPanelHeight
} from '../../lib/message/panelHeight'
import { APPROVAL_AT_TERMINAL_NOTE } from '../../lib/delivery/actionBar'
import { SEND_AGAIN_LABEL, sendMarker } from '../../lib/delivery/deliveryVerdict'
import { NO_TRANSCRIPT_NOTE, NOTHING_SAID_NOTE, READING_NOTE } from '../../lib/message/conversation'
import type { MessageEcho } from '../../lib/message/echo'
import { defaultDwarf } from '../../testing/factories'
import { MAX_DWARF_TEXT_CHARS, type DwarfPermissionRequest, type DwarfSendState } from '../../types'
import DwarfMessagePanel from './DwarfMessagePanel.vue'

/*
 * WHERE DwarfActionBar's TESTS WENT (#159).
 *
 * The interim icon bar (#27) died here and this file is where its behaviours
 * are now pinned: the console action, Escape, the whole send path (Enter,
 * Shift+Enter, the blank refusal, the char cap, the channel hint, the in-flight
 * lock, the two-phase verdict), the whole kick path (one click since #293, the
 * channel-specific hints, the in-flight lock, the verdict) and Boost's
 * disabled reason with its per-provider effort label.
 *
 * Three of its behaviours went with the bar rather than moving, and none of
 * them silently:
 *
 * - **The `pressEnter` checkbox** ("Press Enter in the session") and its test.
 *   `screens/mine.md` says Enter sends and the panel it draws carries no second
 *   control to say otherwise, so a message now always arrives with the
 *   session's own Enter. A console-delivered line can no longer be typed
 *   without submitting it.
 * - **The chat toggle** and its two tests (hide until clicked, collapse on a
 *   second click). The design's panel has no toggle: the input is the surface.
 * - **The disarm-on-chat-open test**, whose gesture no longer exists. The case
 *   that survived it — a half-confirmed kick cleared when the panel moved to
 *   another dwarf — has since gone the same way: #293 took the confirmation off
 *   the control, so there is no half-confirmed state left to clear.
 *
 * The bar's four shape tests (icon order, inline pixel art, aria-labels, the
 * hover tooltip) described a surface that no longer exists; this file's own
 * shape tests describe the one that replaced it. `lib/delivery/actionBar.ts`
 * and its tests are untouched — the capability model outlived the component
 * that rendered it, and the panel reads the same entries.
 */

const LONG_REPLY = 'x'.repeat(1200)

const HELD = [
  { role: 'user' as const, text: 'dig here', timestamp: '2026-09-03T09:00:00.000Z' },
  { role: 'assistant' as const, text: 'Found the seam.', timestamp: '2026-09-03T09:00:01.000Z' }
]

function panel(props: Record<string, unknown> = {}) {
  return mount(DwarfMessagePanel, {
    props: {
      dwarf: defaultDwarf({ textDelivery: 'terminal', conversation: HELD }),
      ...props
    }
  })
}

/**
 * A pointer gesture on the resize handle.
 *
 * Dispatched rather than triggered: `clientY` is a getter on jsdom's
 * MouseEvent, so test-utils' own `trigger(type, { clientY })` cannot set it —
 * the constructor is the only way in. `pointerId` is deliberately absent,
 * which is also what jsdom gives a real listener here.
 */
function pointer(wrapper: ReturnType<typeof panel>, type: string, clientY: number, clientX = 0) {
  wrapper
    .find('.panel-resize')
    .element.dispatchEvent(new MouseEvent(type, { clientY, clientX, bubbles: true }))
  return wrapper.vm.$nextTick()
}

/** The panel's own height, as the style attribute carries it. */
function heightOf(wrapper: ReturnType<typeof panel>): number {
  const style = wrapper.find('.message-panel').attributes('style') ?? ''
  return Number(/height:\s*([\d.]+)px/.exec(style)?.[1] ?? '0')
}

describe('DwarfMessagePanel shape', () => {
  it('names the selected dwarf, as the design puts it at the top left', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ name: 'Durin', conversation: HELD }) })
    expect(wrapper.find('.panel-agent').text()).toBe('Durin')
  })

  it("draws the dwarf's own portrait beside what it said", () => {
    const worker = panel({ dwarf: defaultDwarf({ role: 'worker', conversation: HELD }) })
    const worker2 = panel({ dwarf: defaultDwarf({ role: 'worker2', conversation: HELD }) })
    const foreman = panel({ dwarf: defaultDwarf({ role: 'foreman', conversation: HELD }) })
    expect(worker.find('.message.is-agent .portrait').attributes('src')).toContain('worker-face')
    expect(worker2.find('.message.is-agent .portrait').attributes('src')).toContain('worker2-face')
    expect(foreman.find('.message.is-agent .portrait').attributes('src')).toContain('foreman')
  })

  it('draws the launching agent against a prompt that agent issued', async () => {
    // #175: a worker's first message came from the foreman that spawned it, and
    // the panel was drawing the user's own face against it. The portrait is the
    // rank and the alt text is the name — the design draws no per-message
    // label, and inventing one is what `ui-rebuild` forbids.
    const wrapper = panel({
      dwarf: defaultDwarf({ role: 'worker', name: 'survey the seam', conversation: undefined }),
      feed: {
        readable: true,
        messages: [
          {
            role: 'user',
            text: 'survey the seam',
            timestamp: 't0',
            issuer: { role: 'foreman', name: 'coordinator' }
          },
          { role: 'assistant', text: 'On my way.', timestamp: 't1' }
        ]
      }
    })
    await wrapper.vm.$nextTick()

    const portraits = wrapper.findAll('.message .portrait')
    expect(portraits[0]!.attributes('src')).toContain('foreman')
    expect(portraits[0]!.attributes('alt')).toBe('coordinator, foreman')
    // The reply is still the dwarf speaking for itself.
    expect(portraits[1]!.attributes('src')).toContain('worker-face')
    expect(portraits[1]!.attributes('alt')).toBe('survey the seam, worker')
  })

  it("keeps the user's own face on a launch the human typed", async () => {
    // The other half of #175, and the case the design's launch flow draws: a
    // session the panel launched opens with the user's submitted prompt, and no
    // issuer is what says so.
    const wrapper = panel({
      dwarf: defaultDwarf({ role: 'foreman', name: 'coordinator', conversation: HELD })
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.message.is-user .portrait').attributes('alt')).toBe('You')
  })

  it('start-aligns the agent and end-aligns the user, as the design does', () => {
    const messages = panel().findAll('.message')
    expect(messages[0]!.classes()).toContain('is-user')
    expect(messages[1]!.classes()).toContain('is-agent')
  })

  /*
   * AMENDED for #348. The name is now wrapped in `.panel-who`, so that the
   * worktree label can ride beside it without taking a column of the header's
   * three-column grid — which is what centres the history tab. The subject is
   * unchanged: three cells, the tab in the middle.
   */
  it('centres the history tab between the name and the close, as the design does', () => {
    const bar = [...panel().find('.panel-bar').element.children]
    expect(bar.map((child) => child.className)).toEqual([
      'panel-who',
      'panel-history',
      'panel-close'
    ])
    expect(panel().find('.panel-who .panel-agent').exists()).toBe(true)
  })

  /**
   * Which worktree the dwarf is in, beside its name (#348) — a mine is a
   * project, and its crew can be spread over every worktree of that project.
   */
  it('names the branch beside the dwarf when it works in a worktree', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        name: 'Scout',
        conversation: HELD,
        workplace: { path: 'C:\\Code\\Anvil-worktrees\\forge', branch: 'feat/console-paste' }
      })
    })
    expect(wrapper.find('.panel-workplace').text()).toBe('· feat/console-paste')
    // Text, never a control: there is nothing to press about where a dwarf is.
    expect(wrapper.find('.panel-workplace').element.tagName).toBe('SPAN')
  })

  it('names the worktree s folder when its HEAD is detached and carries no branch', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        conversation: HELD,
        workplace: { path: 'C:\\Code\\Anvil-worktrees\\forge' }
      })
    })
    expect(wrapper.find('.panel-workplace').text()).toBe('· forge')
  })

  it('says nothing beside the name for a dwarf in the mine s own folder', () => {
    // Absent means the mine's own folder, and most dwarfs are there. A label
    // with nothing in it would read as a fact that failed to load.
    expect(panel().find('.panel-workplace').exists()).toBe(false)
  })

  it('carries the three controls the design draws: kick, boost and close', () => {
    const wrapper = panel()
    expect(wrapper.find('.control-kick').exists()).toBe(true)
    expect(wrapper.find('.control-boost').exists()).toBe(true)
    expect(wrapper.find('.panel-close').exists()).toBe(true)
  })

  it('gives the messages their own scroll, so history reads without expanding anything', () => {
    expect(panel().find('.panel-conversation').exists()).toBe(true)
  })

  it('opens showing the latest message rather than the oldest', async () => {
    // Oldest first is the design's order, so an unscrolled panel would open on
    // the message furthest from what just happened.
    const wrapper = panel()
    const list = wrapper.find('.panel-conversation').element
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(list.scrollTop).toBe(900)
  })
})

/**
 * #294 folded every run of consecutive activity lines into one collapsed
 * disclosure row, so the lines the two blocks below are about are one press
 * away rather than on screen from the start. Every test in them is AMENDED with
 * this press and nothing else: what each one claims about a line is exactly
 * what it claimed before, and #294's own block pins the folding itself.
 */
async function openRun(wrapper: ReturnType<typeof panel>): Promise<void> {
  await wrapper.find('.activity-disclosure').trigger('click')
}

/**
 * One line per tool call, interleaved between the speech bubbles (#240).
 * `screens/mine.md`'s activity-line amendment: the meta token, no icon, no
 * bubble surface and no portrait, ellipsis-truncated with the full text as
 * `title`, aligned with the bubble text rather than the portrait.
 */
describe('DwarfMessagePanel activity lines (#240)', () => {
  const CONVERSATION = [
    { role: 'user' as const, text: 'dig here', timestamp: 't0' },
    {
      role: 'assistant' as const,
      text: 'Ran pnpm test',
      timestamp: 't1',
      activity: { kind: 'run' as const, target: 'pnpm test' }
    },
    { role: 'assistant' as const, text: 'Tests pass.', timestamp: 't2' }
  ]

  it('draws a tool call as its own muted line rather than a bubble', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: CONVERSATION }) })
    await openRun(wrapper)
    const line = wrapper.find('.activity-line')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe('Ran pnpm test')
  })

  it('carries the full text as the title, for the truncated line to expand on hover', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: CONVERSATION }) })
    await openRun(wrapper)
    expect(wrapper.find('.activity-line').attributes('title')).toBe('Ran pnpm test')
  })

  it('draws no portrait and no bubble surface for a tool-call line', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: CONVERSATION }) })
    await openRun(wrapper)
    const line = wrapper.find('.activity-line')
    expect(line.find('.portrait').exists()).toBe(false)
    expect(line.classes()).not.toContain('bubble')
  })

  it('still draws the ordinary bubbles either side of the tool-call line', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: CONVERSATION }) })
    expect(wrapper.findAll('.bubble').map((bubble) => bubble.text())).toEqual([
      'dig here',
      'Tests pass.'
    ])
  })

  it('counts the tool-call line as one row in the conversation, same as a bubble', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: CONVERSATION }) })
    await openRun(wrapper)
    expect(wrapper.findAll('.bubble')).toHaveLength(2)
    expect(wrapper.findAll('.activity-line')).toHaveLength(1)
  })

  it('draws a run line as a plain paragraph rather than a clickable control', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: CONVERSATION }) })
    await openRun(wrapper)
    expect(wrapper.find('.activity-line').element.tagName).toBe('P')
  })
})

/**
 * Only an `edit` or `read` activity line's own path opens the file (#279);
 * `run` and `search` stay the plain paragraph #240 drew, pinned by the sibling
 * describe block above. Opening itself happens in MAIN, never here: this
 * component only emits the click and the exact target `FeedActivity` carried.
 */
describe('DwarfMessagePanel path-opening lines (#279)', () => {
  const WITH_EDIT = [
    { role: 'user' as const, text: 'fix the bug', timestamp: 't0' },
    {
      role: 'assistant' as const,
      text: 'Edited src/main/index.ts',
      timestamp: 't1',
      activity: { kind: 'edit' as const, target: 'src/main/index.ts' }
    }
  ]

  const WITH_READ = [
    {
      role: 'assistant' as const,
      text: 'Read src/shared/contracts.ts',
      timestamp: 't0',
      activity: { kind: 'read' as const, target: 'src/shared/contracts.ts' }
    }
  ]

  it('draws an edit line as a keyboard-reachable button, not an anchor, styled as text', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: WITH_EDIT }) })
    await openRun(wrapper)
    const line = wrapper.find('.activity-line')
    expect(line.element.tagName).toBe('BUTTON')
    expect(line.attributes('type')).toBe('button')
    expect(line.classes()).toContain('is-openable')
  })

  it('draws a read line the same way an edit line is drawn', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: WITH_READ }) })
    await openRun(wrapper)
    expect(wrapper.find('.activity-line').element.tagName).toBe('BUTTON')
  })

  it("emits the activity's own target on click, not the display text", async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: WITH_EDIT }) })
    await openRun(wrapper)
    await wrapper.find('.activity-line').trigger('click')
    expect(wrapper.emitted('open-path')).toEqual([['src/main/index.ts']])
  })

  it('still carries the full text as the title, same as a plain activity line', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: WITH_EDIT }) })
    await openRun(wrapper)
    expect(wrapper.find('.activity-line').attributes('title')).toBe('Edited src/main/index.ts')
  })
})

/**
 * One run of consecutive tool calls, folded into one disclosure row under the
 * preceding bubble (#294). `lib/message/activityGroup` owns where a run
 * starts and what it is called; what is pinned here is the row itself — closed
 * on arrival, a button so a keyboard reaches it, and opening in place to the
 * exact lines #240 drew with the paths #279 made clickable still clickable.
 */
describe('DwarfMessagePanel activity disclosure (#294)', () => {
  const RUN_OF_THREE = [
    { role: 'user' as const, text: 'fix the bug', timestamp: 't0' },
    {
      role: 'assistant' as const,
      text: 'Read src/shared/contracts.ts',
      timestamp: 't1',
      activity: { kind: 'read' as const, target: 'src/shared/contracts.ts' }
    },
    {
      role: 'assistant' as const,
      text: 'Ran pnpm test',
      timestamp: 't2',
      activity: { kind: 'run' as const, target: 'pnpm test' }
    },
    {
      role: 'assistant' as const,
      text: 'Edited src/main/index.ts',
      timestamp: 't3',
      activity: { kind: 'edit' as const, target: 'src/main/index.ts' }
    },
    { role: 'assistant' as const, text: 'Fixed it.', timestamp: 't4' }
  ]

  it('draws one disclosure row for the whole run, and none of its lines, until it is pressed', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: RUN_OF_THREE }) })
    expect(wrapper.findAll('.activity-disclosure')).toHaveLength(1)
    expect(wrapper.findAll('.activity-line')).toHaveLength(0)
    expect(wrapper.findAll('.bubble')).toHaveLength(2)
  })

  it('is a button carrying its own state, so Enter and Space reach it like any other control', () => {
    const row = panel({ dwarf: defaultDwarf({ conversation: RUN_OF_THREE }) }).find(
      '.activity-disclosure'
    )
    expect(row.element.tagName).toBe('BUTTON')
    expect(row.attributes('type')).toBe('button')
    expect(row.attributes('aria-expanded')).toBe('false')
  })

  it('counts the run and names its last call, once a bubble has closed it', () => {
    const row = panel({ dwarf: defaultDwarf({ conversation: RUN_OF_THREE }) }).find(
      '.activity-disclosure'
    )
    expect(row.text()).toBe('3 steps — Edited src/main/index.ts')
    expect(row.attributes('title')).toBe('3 steps — Edited src/main/index.ts')
  })

  it('reads Working... while the run is the last thing a live session has done', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ status: 'working', conversation: RUN_OF_THREE.slice(0, 4) })
    })
    expect(wrapper.find('.activity-disclosure').text()).toBe('Working...')
  })

  it('counts the run instead, once the session behind it has ended', () => {
    // Nothing further can join it, so the honest label is the finished one —
    // a "Working..." row on an ended session claims work still going on.
    const wrapper = panel({
      dwarf: defaultDwarf({ status: 'leaving', conversation: RUN_OF_THREE.slice(0, 4) })
    })
    expect(wrapper.find('.activity-disclosure').text()).toBe('3 steps — Edited src/main/index.ts')
  })

  it('opens in place to the exact lines of the run, in order, on a press', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: RUN_OF_THREE }) })
    await wrapper.find('.activity-disclosure').trigger('click')

    expect(wrapper.findAll('.activity-line').map((line) => line.text())).toEqual([
      'Read src/shared/contracts.ts',
      'Ran pnpm test',
      'Edited src/main/index.ts'
    ])
    expect(wrapper.find('.activity-disclosure').attributes('aria-expanded')).toBe('true')
  })

  it('collapses again on a second press', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: RUN_OF_THREE }) })
    await wrapper.find('.activity-disclosure').trigger('click')
    await wrapper.find('.activity-disclosure').trigger('click')

    expect(wrapper.findAll('.activity-line')).toHaveLength(0)
    expect(wrapper.find('.activity-disclosure').attributes('aria-expanded')).toBe('false')
  })

  it("still emits an opened line's own target from inside an expanded run", async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: RUN_OF_THREE }) })
    await wrapper.find('.activity-disclosure').trigger('click')
    await wrapper.findAll('.activity-line.is-openable')[1]!.trigger('click')

    expect(wrapper.emitted('open-path')).toEqual([['src/main/index.ts']])
  })

  it('keeps each run its own, so opening one leaves the other closed', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        conversation: [
          ...RUN_OF_THREE,
          {
            role: 'assistant' as const,
            text: 'Searched TODO',
            timestamp: 't5',
            activity: { kind: 'search' as const, target: 'TODO' }
          }
        ]
      })
    })
    const rows = wrapper.findAll('.activity-disclosure')
    expect(rows).toHaveLength(2)

    await rows[1]!.trigger('click')

    const after = wrapper.findAll('.activity-disclosure')
    expect(after[0]!.attributes('aria-expanded')).toBe('false')
    expect(after[1]!.attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('.activity-line').map((line) => line.text())).toEqual(['Searched TODO'])
  })
})

/**
 * The disclosure and the stick-to-bottom rule (#294 against #195/#243). Two
 * separate promises: a run that GROWS while collapsed must leave a reader who
 * scrolled up alone, and OPENING one must not move the list at all — the reader
 * asked to see more, not to be taken somewhere.
 */
describe('DwarfMessagePanel activity disclosure and scroll (#294)', () => {
  /** As the #195 block's own helper, but counting every row the list holds. */
  function growingScrollHeight(list: Element, perRow = 40): void {
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () =>
        list.querySelectorAll('.message, .activity-line, .activity-disclosure').length * perRow
    })
  }

  const WITH_RUN = [
    { role: 'user' as const, text: 'fix the bug', timestamp: 't0' },
    {
      role: 'assistant' as const,
      text: 'Ran pnpm test',
      timestamp: 't1',
      activity: { kind: 'run' as const, target: 'pnpm test' }
    }
  ]

  it('leaves the list exactly where the reader had it when a run is opened', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: WITH_RUN }) })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    Object.defineProperty(list, 'clientHeight', { value: 30, configurable: true })
    await wrapper.vm.$nextTick()
    list.scrollTop = 5

    await wrapper.find('.activity-disclosure').trigger('click')
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(5)
  })

  it('does not yank a reader who scrolled up when a collapsed run grows', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: WITH_RUN }) })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    Object.defineProperty(list, 'clientHeight', { value: 30, configurable: true })
    await wrapper.vm.$nextTick()
    list.scrollTop = 5 // 80 - 30 - 5 = 45, well past the tolerance: scrolled up.

    await wrapper.setProps({
      dwarf: defaultDwarf({
        conversation: [
          ...WITH_RUN,
          {
            role: 'assistant',
            text: 'Edited src/main/index.ts',
            timestamp: 't2',
            activity: { kind: 'edit', target: 'src/main/index.ts' }
          }
        ]
      })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(5)
  })
})

/**
 * #195: the only scroll-to-bottom used to be `showLatest()`, fired on mount
 * and on the history tab expanding — never when the row list itself grew. A
 * newly-selected dwarf mounts before its feed comes back (App.vue's read is
 * async), so that mount-time call was a no-op against an empty list, and
 * nothing ran again once the feed prop landed on this same instance. These
 * tests pin the fix: a watch on the row list itself, applying
 * `lib/message/listScroll`'s pure verdict once new rows are actually in the
 * DOM.
 */
describe('DwarfMessagePanel scroll (#195)', () => {
  /**
   * jsdom does no layout, so `scrollHeight` is always 0 unless overridden. A
   * getter tied to the number of `.message` elements actually in the list lets
   * it grow the way a real list would once Vue patches new rows in — a static
   * value would report the SAME height before and after the patch, which is
   * exactly the distinction these tests exist to tell apart.
   */
  function growingScrollHeight(list: Element, perMessage = 40): void {
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => list.querySelectorAll('.message').length * perMessage
    })
  }

  function fixedClientHeight(list: Element, value: number): void {
    Object.defineProperty(list, 'clientHeight', { value, configurable: true })
  }

  it('scrolls to the newest message once a delayed read lands, even though the panel mounted with nothing to show', async () => {
    // The core of #195: a brand new dwarf mounts before its feed has come
    // back, so onMounted's own scroll-to-bottom lands on whatever is there.
    // App.vue keeps this same component instance once the feed lands (see its
    // own tests) rather than remounting, so nothing but a watch on the rows
    // themselves can still catch the moment they arrive.
    //
    // AMENDED for #332 (was: asserting scrollTop stayed at 0 on mount). The
    // empty state now draws its own placeholder row — the dwarf's portrait,
    // no conversation yet — so `showLatest` lands on THAT row's height first;
    // there is still no real conversation to have scrolled past.
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: undefined }), feed: undefined })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    expect(list.scrollTop).toBe(40) // 1 row (the empty-state placeholder) * 40.

    await wrapper.setProps({
      feed: {
        readable: true,
        messages: [
          { role: 'assistant', text: 'Found the seam.', timestamp: 't0' },
          { role: 'assistant', text: 'Halfway down the shaft.', timestamp: 't1' }
        ]
      }
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(80) // 2 rows * 40, the new bottom.
  })

  it('sticks to the bottom when a new row arrives and the reader was already there', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: HELD }) })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 50 // HELD has 2 rows: 80 - 30 - 50 = 0, exactly at the bottom.

    await wrapper.setProps({
      dwarf: defaultDwarf({
        conversation: [...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }]
      })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(120) // 3 rows * 40, the new bottom.
  })

  it("keeps the reader's own scroll position when a row arrives below where they had scrolled up to", async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: HELD }) })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 5 // 80 - 30 - 5 = 45, well past the tolerance: scrolled up.

    await wrapper.setProps({
      dwarf: defaultDwarf({
        conversation: [...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }]
      })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // A row landed below the fold; a reader who had scrolled up must not be
    // yanked back down to read it (#195).
    expect(list.scrollTop).toBe(5)
  })
})

/**
 * Every sizing rule `screens/mine.md` states, in its own words: the initial
 * height derives from the latest message, new messages never resize the panel,
 * reopening recalculates, and the user may resize it vertically only.
 */
describe('DwarfMessagePanel height', () => {
  it("opens at the height its dwarf's latest message calls for", () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        conversation: [{ role: 'assistant', text: LONG_REPLY, timestamp: 'now' }]
      })
    })
    expect(heightOf(wrapper)).toBe(initialPanelHeight(LONG_REPLY))
    expect(heightOf(wrapper)).toBeGreaterThan(MESSAGE_PANEL_MIN_HEIGHT)
  })

  it('never resizes itself when a new message arrives', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ conversation: [{ role: 'assistant', text: 'ok', timestamp: 'now' }] })
    })
    const opened = heightOf(wrapper)

    await wrapper.setProps({
      dwarf: defaultDwarf({
        conversation: [
          { role: 'assistant', text: 'ok', timestamp: 'now' },
          { role: 'assistant', text: LONG_REPLY, timestamp: 'later' }
        ]
      })
    })

    expect(heightOf(wrapper)).toBe(opened)
  })

  it('recalculates from the latest message when it is closed and opened again', () => {
    // The panel is mounted per selection, so "reopening" is a fresh mount —
    // which is the whole reason the height rule is a pure function.
    const short = panel({
      dwarf: defaultDwarf({ conversation: [{ role: 'assistant', text: 'ok', timestamp: 'now' }] })
    })
    const long = panel({
      dwarf: defaultDwarf({
        conversation: [{ role: 'assistant', text: LONG_REPLY, timestamp: 'now' }]
      })
    })
    expect(heightOf(long)).toBeGreaterThan(heightOf(short))
  })

  it('resizes vertically from the drag handle, and only vertically', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)

    await pointer(wrapper, 'pointerdown', 400, 100)
    await pointer(wrapper, 'pointermove', 330, 900)

    // Dragging the top edge UP makes a bottom-docked panel taller.
    expect(heightOf(wrapper)).toBe(opened + 70)
    // Nothing the pointer did sideways reached the panel: there is no width to set.
    expect(wrapper.find('.message-panel').attributes('style')).not.toContain('width:')
  })

  it('stops the drag at the floor and at the ceiling', async () => {
    const wrapper = panel()

    await pointer(wrapper, 'pointerdown', 400)
    await pointer(wrapper, 'pointermove', 4000)
    expect(heightOf(wrapper)).toBe(MESSAGE_PANEL_MIN_HEIGHT)

    await pointer(wrapper, 'pointermove', -4000)
    expect(heightOf(wrapper)).toBe(MESSAGE_PANEL_MAX_HEIGHT)
  })

  it('ignores a pointer that moved without ever grabbing the handle', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)
    await pointer(wrapper, 'pointermove', 100)
    expect(heightOf(wrapper)).toBe(opened)
  })

  it('resizes from the keyboard too, because a drag handle is not reachable without one', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)
    await wrapper.find('.panel-resize').trigger('keydown', { key: 'ArrowUp' })
    expect(heightOf(wrapper)).toBeGreaterThan(opened)
    await wrapper.find('.panel-resize').trigger('keydown', { key: 'ArrowDown' })
    expect(heightOf(wrapper)).toBe(opened)
  })
})

describe('DwarfMessagePanel history tab', () => {
  it('starts collapsed and expands to the full transcript', async () => {
    const wrapper = panel()
    expect(wrapper.find('.panel-history').attributes('aria-expanded')).toBe('false')

    await wrapper.find('.panel-history').trigger('click')
    expect(wrapper.find('.panel-history').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.message-panel').classes()).toContain('is-history')
    expect(heightOf(wrapper)).toBe(MESSAGE_PANEL_MAX_HEIGHT)
  })

  it('gives the height back exactly as it was when the history closes again', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)
    await wrapper.find('.panel-history').trigger('click')
    await wrapper.find('.panel-history').trigger('click')
    expect(heightOf(wrapper)).toBe(opened)
  })

  it('draws a portrait against every message in the transcript, both sides', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-history').trigger('click')
    expect(wrapper.findAll('.message .portrait')).toHaveLength(2)
  })
})

describe('DwarfMessagePanel input', () => {
  it('sends on Enter and writes a newline on Shift+Enter', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-input').setValue('dig deeper')

    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([[{ text: 'dig deeper', pressEnter: true }]])
  })

  it('clears the box once the message has left', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect((wrapper.find('.panel-input').element as HTMLTextAreaElement).value).toBe('')
  })

  it('refuses to send a blank message', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-input').setValue('   ')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('sends nothing while a send is still in flight', async () => {
    const wrapper = panel({ sendState: { phase: 'sending' } })
    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('caps the message at the shared delivery limit', () => {
    expect(panel().find('.panel-input').attributes('maxlength')).toBe(String(MAX_DWARF_TEXT_CHARS))
  })

  it('keeps the input selectable, which the design asks for by name', () => {
    // Guarded here because it is a stated rule that a stylesheet change could
    // silently take away.
    expect(panel().find('.panel-input').classes()).toContain('is-selectable')
  })

  it('disables the box, with its reason, for a session that cannot be written to', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: undefined }) })
    const input = wrapper.find('.panel-input')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('title')).toContain("can't receive messages yet")
  })

  it('disables the box, saying the session has ended, for a dwarf that is leaving', () => {
    // #192: the channel the session HAD is still on the dwarf, frozen by the
    // grace window; the box must read the capability model, not the field.
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', status: 'leaving', conversation: HELD })
    })
    const input = wrapper.find('.panel-input')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('title')).toContain('ended')
    expect(wrapper.find('.panel-note').text()).toContain('ended')
  })

  it('names the channel a message would travel through', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: 'foreman-relay' }) })
    expect(panel().find('.panel-input').attributes('title')).toContain('console')
    expect(wrapper.find('.panel-input').attributes('title')).toContain('foreman')
  })

  /*
   * #217. A control the panel disables says why IN the panel. Two dead
   * controls with nothing said is the "it looks broken" report this comes
   * from: the reason existed all along and lived only in a hover tooltip,
   * which is a refusal somebody has to go looking for.
   */
  it('says in the panel why the composer is disabled, not only on hover', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null }
      })
    })
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.panel-refusal').text()).toContain('codex exec')
    // The provenance note keeps its own row: what the panel may claim about a
    // transcript is a different fact from why a control is disabled.
    expect(wrapper.find('.panel-note').exists()).toBe(true)
  })

  /*
   * AMENDED for #293 (was: "shows the kick's refusal in the panel when the
   * composer works and it does not", expecting the queue's "between turns"
   * sentence on the refusal row). Neither control refuses this dwarf any more —
   * the composer sends and the kick dismisses — so the row would be the panel
   * apologising for two controls that both work. What the kick does is on the
   * control itself.
   */
  it('draws no refusal for a queue-only thread: the composer sends, the kick dismisses', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        textDelivery: 'codex-queue',
        capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
      })
    })
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.panel-refusal').exists()).toBe(false)
    expect(wrapper.find('.control-kick').attributes('title')).toContain('off the rock')
  })

  it('draws no refusal row at all when both controls work', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      })
    })
    expect(wrapper.find('.panel-refusal').exists()).toBe(false)
  })

  it('lets a failure reason take the floor rather than doubling up with a refusal', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: undefined }),
      sendState: { phase: 'failed', error: 'The relay never answered.' }
    })
    expect(wrapper.find('.panel-alert').text()).toBe('The relay never answered.')
    expect(wrapper.find('.panel-refusal').exists()).toBe(false)
  })

  it('shows the send verdict without ever blurring handed over and reacted', () => {
    const handed = panel({
      sendState: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
    expect(handed.find('.panel-status').text()).toContain('Handed over')
    expect(handed.find('.panel-status').text()).not.toContain('reacted.')

    const reacted = panel({ sendState: { phase: 'reacted', via: 'terminal' } })
    expect(reacted.find('.panel-status').text()).toContain('the session reacted')

    const failed = panel({ sendState: { phase: 'failed', error: 'The relay never answered.' } })
    expect(failed.find('.panel-alert').text()).toBe('The relay never answered.')
  })
})

describe('DwarfMessagePanel controls', () => {
  const kickable = defaultDwarf({
    textDelivery: 'terminal',
    conversation: HELD,
    capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
  })

  /*
   * AMENDED for #293 (was: 'asks for a second click before it kicks', which
   * asserted the arm state and its 'is-armed' class). The arming was #11's
   * implementation choice, the design source listed the confirmation under
   * Unspecified, and a first click that visibly did nothing read as a kick that
   * had failed.
   */
  it('kicks on one click, with no confirmation to press through', async () => {
    const wrapper = panel({ dwarf: kickable })
    await wrapper.find('.control-kick').trigger('click')
    expect(wrapper.emitted('kick')).toHaveLength(1)
    expect(wrapper.find('.control-kick').classes()).not.toContain('is-armed')
  })

  /*
   * AMENDED for #293 (was: 'disables kick, with the reason, when the session
   * cannot be cancelled', expecting the disabled attribute and "can't be
   * canceled yet"). Nothing can interrupt this session, which is now the reason
   * the control means something else rather than the reason it is dead.
   */
  /*
   * AMENDED again for #305, step 3: `status: 'waiting'` pinned on both fixtures
   * below, where they used to inherit `defaultDwarf`'s `'working'`. The
   * dismissal is unchanged for an idle dwarf; mid-turn the control is now
   * refused, which is the test that follows them.
   */
  it('keeps kick live where nothing can be cancelled, and says it dismisses', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        capabilities: { sendText: null, cancel: null, adjustEffort: null }
      })
    })
    expect(wrapper.find('.control-kick').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.control-kick').attributes('title')).toContain('off the rock')
  })

  /* AMENDED for #293, same reason (was: 'disables kick when the dwarf ...'). */
  it('keeps kick live when the dwarf carries no capability matrix at all', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ status: 'waiting', capabilities: undefined }) })
    expect(wrapper.find('.control-kick').attributes('disabled')).toBeUndefined()
  })

  /*
   * The other half of #305, step 3, and the only place it is proven to reach
   * the DOM: a dismissal on a dwarf mid-turn is undone by the next poll, so the
   * button is genuinely disabled rather than merely re-worded.
   */
  it('disables kick while a turn nothing can interrupt is open, with the reason', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'working',
        capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
      })
    })
    expect(wrapper.find('.control-kick').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.control-kick').attributes('title')).toContain('cannot be stopped from')
  })

  /*
   * A finished worker (#219, #293). Its session ended, so there is nothing to
   * interrupt — and that is exactly why the control is worth having here: it
   * ends the leaving walk instead of leaving the dwarf standing on the rock
   * for the rest of its grace.
   */
  it('offers kick on a session that has ended, to end its walk', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ status: 'leaving' }) })
    const control = wrapper.find('.control-kick')
    expect(control.attributes('disabled')).toBeUndefined()
    expect(control.attributes('title')).toContain('has ended')
    await control.trigger('click')
    expect(wrapper.emitted('kick')).toHaveLength(1)
  })

  it('names what kicking THIS channel actually does, rather than one generic promise', () => {
    const relay = panel({
      dwarf: defaultDwarf({
        capabilities: { sendText: 'claude-relay', cancel: 'claude-relay', adjustEffort: null }
      })
    })
    expect(relay.find('.control-kick').attributes('title')).toBe(
      'Asks the agent to stop — it decides how.'
    )
  })

  it('locks the kick control while a kick is in flight', async () => {
    const wrapper = panel({ dwarf: kickable, kickState: { phase: 'kicking' } })
    const control = wrapper.find('.control-kick')
    expect(control.attributes('disabled')).toBeDefined()
    expect(control.attributes('aria-label')).toBe('Kicking...')
    await control.trigger('click')
    expect(wrapper.emitted('kick')).toBeUndefined()
  })

  it('shows the kick verdict, keeping handed over apart from reacted', () => {
    const wrapper = panel({
      dwarf: kickable,
      kickState: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
    expect(wrapper.find('.panel-status').text()).toContain('Kick handed over')
  })

  /*
   * Ending a session and interrupting a turn are different acts, and the person
   * must not be told the wrong one (#217).
   */
  it('says a kick ENDED the session where that is what it did', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null }
      }),
      kickState: { phase: 'delivered', via: 'launched-process' }
    })
    const line = wrapper.find('.panel-status').text()
    expect(line).toContain('Ended the session')
    expect(line).not.toContain('handed over')
  })

  it('draws Boost where the design puts it and refuses to pretend it works', () => {
    // The spike found `applyFlagSettings` resolves as a silent no-op with no
    // supportsEffort guard, and no provider here exposes an effort channel at
    // all — so the control is rendered and disabled with its reason, never
    // wired to something that would answer a click with silence.
    const wrapper = panel({ dwarf: defaultDwarf({ provider: 'claude', effort: 'xhigh' }) })
    const boost = wrapper.find('.control-boost')
    expect(boost.attributes('disabled')).toBeDefined()
    expect(boost.attributes('title')).toContain(
      "No provider supports changing a running session's effort yet."
    )
    expect(boost.attributes('title')).toContain('Extra high')
  })

  it('passes a Codex reasoning_effort value through as it was reported', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ provider: 'codex', effort: 'medium' }) })
    expect(wrapper.find('.control-boost').attributes('title')).toContain('medium')
  })

  it('closes on the close control and on Escape', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-close').trigger('click')
    await wrapper.find('.message-panel').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it("focuses the session's console from the dwarf's own name", async () => {
    // Where the old action bar's console icon went: the design draws a name
    // here and no fourth icon, so the name is the control.
    const wrapper = panel()
    await wrapper.find('.panel-agent').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })
})

/**
 * The question card, re-homed (#128, #159). Its own behaviours are its own
 * tests; what belongs here is that the panel gives it the designed place —
 * above the input — and forwards both of its channels unchanged.
 */
describe('DwarfMessagePanel question', () => {
  const pendingQuestion = {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }]
  }

  function asking(props: Record<string, unknown> = {}) {
    return panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', conversation: HELD, pendingQuestion }),
      ...props
    })
  }

  it('opens tall enough to hold the whole ask, without squashing the conversation', () => {
    expect(heightOf(asking())).toBe(MESSAGE_PANEL_ASK_HEIGHT)
  })

  it('shows no question surface for a dwarf with nothing outstanding', () => {
    expect(panel().find('.question-card').exists()).toBe(false)
  })

  it('replaces the composer with the ask, exactly as the design draws it', () => {
    // The two question exports show the option cards and the card's own
    // `Other Thing` box where the ordinary input sits — one input, not two.
    const wrapper = asking()
    const composer = [...wrapper.find('.panel-composer').element.children]
    expect(composer[0]?.classList.contains('question-card')).toBe(true)
    expect(wrapper.find('.panel-input').exists()).toBe(false)
    // The two controls stay beside it, where every export puts them.
    expect(wrapper.find('.panel-composer .control-kick').exists()).toBe(true)
  })

  it('forwards the chosen option once Enter confirms it', async () => {
    const wrapper = asking()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('answer')).toEqual([['SQLite']])
  })

  it('routes a free-form reply through the ordinary message path, not the ask', async () => {
    const wrapper = asking()
    await wrapper.find('.freeform-input').setValue('neither, keep the file store')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([
      [{ text: 'neither, keep the file store', pressEnter: true }]
    ])
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it("hands main's refusal down to the card so the panel can explain itself", () => {
    const wrapper = asking({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'That session is not one this panel is holding.'
      }
    })
    expect(wrapper.find('.answer-error').text()).toBe(
      'That session is not one this panel is holding.'
    )
  })
})

/**
 * A permission prompt (#203): the tool call a held session is blocked inside
 * right now. It takes precedence over an ordinary ask, because it is the
 * thing keeping the session from moving at all — see the comment beside
 * `initialPanelHeight` in DwarfMessagePanel.vue.
 */
describe('DwarfMessagePanel permission (#203)', () => {
  const pendingPermission: DwarfPermissionRequest = {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    title: 'Claude wants to run a command',
    input: 'rm -rf /tmp/scratch',
    channel: 'held',
    askedAt: '2026-09-05T09:00:00.000Z'
  }

  const pendingQuestion = {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }]
  }

  function withPermission(props: Record<string, unknown> = {}) {
    return panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', conversation: HELD, pendingPermission }),
      ...props
    })
  }

  it('opens tall enough to hold the whole prompt, without squashing the conversation', () => {
    expect(heightOf(withPermission())).toBe(MESSAGE_PANEL_ASK_HEIGHT)
  })

  it('replaces the composer with the permission card, exactly as an ask would', () => {
    const wrapper = withPermission()
    const composer = [...wrapper.find('.panel-composer').element.children]
    expect(composer[0]?.classList.contains('permission-card')).toBe(true)
    expect(wrapper.find('.panel-input').exists()).toBe(false)
    expect(wrapper.find('.panel-composer .control-kick').exists()).toBe(true)
  })

  it('forwards the chosen decision once Enter confirms it', async () => {
    const wrapper = withPermission()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.permission-card').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('decide')).toEqual([['allow']])
  })

  it('shows the permission card, and not the question card, for a dwarf with both open', () => {
    // The session is blocked on the tool call, not on the ask: the permission
    // is the thing keeping it from moving, so it wins the composer. The ask
    // reappears once the permission is decided — main's next snapshot drops
    // it, not this component.
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        conversation: HELD,
        pendingPermission,
        pendingQuestion
      })
    })
    expect(wrapper.find('.permission-card').exists()).toBe(true)
    expect(wrapper.find('.question-card').exists()).toBe(false)
  })

  it('routes a free-form reply through the ordinary message path, not the decision', async () => {
    const wrapper = withPermission()
    await wrapper.find('.freeform-input').setValue('let me check this first')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([
      [{ text: 'let me check this first', pressEnter: true }]
    ])
    expect(wrapper.emitted('decide')).toBeUndefined()
  })
})

/**
 * What each session type may honestly show. The resolution itself is
 * lib/message/conversation's; what is checked here is that the panel prints
 * the claim rather than dropping it, and never invents a bubble.
 */
describe('DwarfMessagePanel honesty', () => {
  it("says a held session's exchange is the one this panel watched happen", () => {
    expect(panel().find('.panel-note').text()).toContain('holding this session')
  })

  it("says an observed session's messages are its latest activity", () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: {
        readable: true,
        messages: [{ role: 'assistant', text: 'Blasting', timestamp: 'now' }]
      }
    })
    expect(wrapper.find('.panel-note').text()).toContain('Latest activity')
    expect(wrapper.findAll('.message')).toHaveLength(1)
  })

  it('draws an empty state, never a bubble, for a session it cannot read', () => {
    // AMENDED for #332 (was: asserting no `.message` row at all — the panel
    // drew a bare paragraph with no face). The empty state now draws as an
    // agent row so the dwarf's own portrait is never blank; what this case
    // still guarantees is that nothing said is invented — no bubble, ever.
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: { readable: false, messages: [] }
    })
    expect(wrapper.findAll('.bubble')).toHaveLength(0)
    expect(wrapper.find('.panel-empty').text()).toBe(NO_TRANSCRIPT_NOTE)
  })

  it('says it is still reading rather than that there is nothing', () => {
    const wrapper = panel({ dwarf: defaultDwarf() })
    expect(wrapper.find('.panel-empty').text()).toBe(READING_NOTE)
  })
})

/**
 * #332: silence says nothing about a dwarf's rank, and a dwarf that has not
 * spoken still has a face. `dwarf.role` is on the prop regardless of what the
 * transcript holds, so the empty state draws as an agent row — the same
 * portrait treatment, same alignment as any other agent row — with the note
 * standing where the bubble text would, never inferring the rank from
 * anything the session said.
 */
describe('DwarfMessagePanel empty portrait (#332)', () => {
  it("draws the dwarf's own portrait beside the empty-state note", () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ conversation: undefined }),
      feed: { readable: true, messages: [] }
    })
    const row = wrapper.find('.message.is-agent')
    expect(row.find('.portrait').attributes('src')).toContain('worker-face')
    expect(row.find('.panel-empty').text()).toBe(NOTHING_SAID_NOTE)
  })

  it('draws no empty row once the conversation has messages', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: HELD }) })
    expect(wrapper.find('.panel-empty').exists()).toBe(false)
    expect(wrapper.findAll('.message')).toHaveLength(HELD.length)
  })

  it.each([
    ['worker', 'worker-face'],
    ['worker2', 'worker2-face'],
    ['foreman', 'foreman-face']
  ] as const)("shows %s's own face, never the message's", (role, needle) => {
    const wrapper = panel({
      dwarf: defaultDwarf({ role, conversation: undefined }),
      feed: { readable: true, messages: [] }
    })
    expect(wrapper.find('.message.is-agent .portrait').attributes('src')).toContain(needle)
  })
})

/**
 * The observed half of #203. A session somebody runs in their own terminal
 * cannot be answered from here — the keystrokes that would work its dialog have
 * never been measured on a live build — so the panel says where the dialog is
 * and offers the jump it already had. No Allow and no Deny.
 */
describe('DwarfMessagePanel awaiting approval', () => {
  const asked = defaultDwarf({
    waitingReason: 'approval',
    textDelivery: 'terminal',
    conversation: HELD
  })

  it('says where the dialog is, above the composer', () => {
    const wrapper = panel({ dwarf: asked })
    expect(wrapper.find('.panel-approval').text()).toContain(APPROVAL_AT_TERMINAL_NOTE)
  })

  it('jumps to that terminal through the console channel the panel already has', async () => {
    const wrapper = panel({ dwarf: asked })
    await wrapper.find('.approval-jump').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })

  it('offers no answer of its own: the dialog is not this panel’s to decide', () => {
    const wrapper = panel({ dwarf: asked })
    expect(wrapper.find('.permission-card').exists()).toBe(false)
    expect(wrapper.find('.panel-input').exists()).toBe(true)
  })

  it('says nothing for a dwarf that is merely waiting', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ status: 'waiting', conversation: HELD }) })
    expect(wrapper.find('.panel-approval').exists()).toBe(false)
  })

  it('stands aside for a prompt this panel can decide itself', () => {
    // A held session's card answers structurally (#246); a line pointing at a
    // terminal would send somebody away from the control that works.
    const wrapper = panel({
      dwarf: defaultDwarf({
        waitingReason: 'approval',
        conversation: HELD,
        pendingPermission: {
          toolUseId: 'toolu_09',
          toolName: 'Bash',
          title: 'Run a command',
          input: 'pnpm test',
          channel: 'held',
          askedAt: '2026-09-04T09:00:00.000Z'
        }
      })
    })
    expect(wrapper.find('.panel-approval').exists()).toBe(false)
  })
})

/**
 * Issue #203. A prompt an OBSERVED session raised: main named it from an
 * unresolved `tool_use`, so the panel can draw the card rather than only the
 * sentence #251 shipped.
 *
 * Which of the two shows is the whole question here, and it is decided by
 * what is KNOWN. The card wins wherever the request's content is, because it
 * says what the session wants to do and offers the answer; the sentence stays
 * where only the hook spoke and the content could not be named. Never both —
 * they describe one dialog, and two rows about it read as two.
 */
describe('DwarfMessagePanel observed permission (#203)', () => {
  const observedPermission: DwarfPermissionRequest = {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    input: 'pnpm test',
    channel: 'terminal',
    askedAt: '2026-09-05T09:00:00.000Z'
  }

  function observed(extra: Record<string, unknown> = {}) {
    return defaultDwarf({
      waitingReason: 'approval',
      textDelivery: 'terminal',
      conversation: HELD,
      pendingPermission: observedPermission,
      ...extra
    })
  }

  it('draws the card for a session it only watches, exactly as for one it holds', () => {
    const wrapper = panel({ dwarf: observed() })
    expect(wrapper.find('.permission-card').exists()).toBe(true)
    expect(wrapper.find('.permission-input').text()).toBe('pnpm test')
  })

  it('shows the card instead of the terminal sentence, never both', () => {
    const wrapper = panel({ dwarf: observed() })
    expect(wrapper.find('.panel-approval').exists()).toBe(false)
  })

  it('keeps the sentence where the hook spoke and the content could not be named', () => {
    // The #251 case, unchanged: a dialog is open and the tail held no single
    // unresolved call to name it by, so the panel says where it is and stops.
    const wrapper = panel({
      dwarf: defaultDwarf({
        waitingReason: 'approval',
        textDelivery: 'terminal',
        conversation: HELD
      })
    })
    expect(wrapper.find('.panel-approval').text()).toContain(APPROVAL_AT_TERMINAL_NOTE)
    expect(wrapper.find('.permission-card').exists()).toBe(false)
  })

  it('passes a decision made on the card up to whoever owns the channel', async () => {
    const wrapper = panel({ dwarf: observed() })
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    wrapper
      .find('.permission-card')
      .element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    expect(wrapper.emitted('decide')).toEqual([['deny']])
  })

  it('forwards the card’s jump, so a refused decision still reaches that console', async () => {
    const wrapper = panel({
      dwarf: observed(),
      answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
    })
    await wrapper.find('.answer-jump').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })
})

/*
 * The dismissal's own verdict line (#293). The panel has to keep three acts
 * apart under one control: an interrupt handed to a session, a session this
 * app ended, and a dwarf taken off the board without the session being asked
 * anything at all.
 */
describe('DwarfMessagePanel on a dismissed dwarf', () => {
  it('says the dwarf was sent off, and never that anything was handed over', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        textDelivery: 'codex-queue',
        capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
      }),
      kickState: { phase: 'delivered', via: 'dismiss' }
    })
    const line = wrapper.find('.panel-status').text()
    expect(line).toContain('off the rock')
    expect(line).not.toContain('handed over')
    expect(line).not.toContain('Ended the session')
  })
})

/**
 * The message the person just sent, drawn before any channel answered (#309).
 *
 * The panel takes these as a prop and decides nothing about them: which
 * messages are pending is the delivery store's, the glyph and the hover copy
 * are `lib/delivery/deliveryVerdict`'s, and where the row goes is
 * `lib/message/echo`'s. What is pinned here is that the panel draws them, that
 * the tick copy is the SAME copy the sprite marker in the shell uses rather
 * than a second wording of it, and that a failed message keeps its words and
 * offers the one control that sends them again.
 */
describe('DwarfMessagePanel echoes (#309)', () => {
  function echo(overrides: Partial<MessageEcho> = {}): MessageEcho {
    return {
      id: 'e1',
      text: 'dig deeper',
      sentAt: Date.parse('2026-09-09T10:00:00.000Z'),
      state: { phase: 'sending' },
      ...overrides
    }
  }

  /** The last bubble in the conversation, which is where an echo belongs. */
  function lastMessageRow(wrapper: ReturnType<typeof panel>) {
    return wrapper.findAll('.message').at(-1)!
  }

  it("draws a sent message as the person's own bubble, after everything the transcript carried", () => {
    const wrapper = panel({ echoes: [echo()] })
    const rows = wrapper.findAll('.message')
    // HELD is two rows; the echo is the third and last.
    expect(rows).toHaveLength(3)
    expect(rows.at(-1)!.classes()).toContain('is-user')
    expect(rows.at(-1)!.find('.bubble').text()).toBe('dig deeper')
    expect(rows.at(-1)!.find('.portrait').attributes('alt')).toBe('You')
  })

  it('carries the pending glyph while the message is still in flight', () => {
    const wrapper = panel({ echoes: [echo({ state: { phase: 'sending' } })] })
    const marker = lastMessageRow(wrapper).find('.bubble-marker')
    expect(marker.text()).toBe(sendMarker({ phase: 'sending' })!.glyph)
    expect(marker.classes()).toContain('is-sending')
  })

  it("carries one tick when the message reached the session's queue, in the verdict's own words", () => {
    const state: DwarfSendState = { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    const wrapper = panel({ echoes: [echo({ state })] })
    const marker = lastMessageRow(wrapper).find('.bubble-marker')
    expect(marker.text()).toBe('✓')
    expect(marker.attributes('title')).toBe(sendMarker(state)!.title)
    // Handed over, never a claimed reaction — the whole point of #21.
    expect(marker.attributes('title')).not.toContain('reacted')
  })

  it('says so on the tick when the watch closed without seeing a reaction', () => {
    const state: DwarfSendState = { phase: 'delivered', via: 'terminal', awaitingReaction: false }
    const wrapper = panel({ echoes: [echo({ state })] })
    expect(lastMessageRow(wrapper).find('.bubble-marker').attributes('title')).toBe(
      sendMarker(state)!.title
    )
  })

  it('carries two ticks only once the session was seen acting', () => {
    const state: DwarfSendState = { phase: 'reacted', via: 'terminal' }
    const wrapper = panel({ echoes: [echo({ state })] })
    const marker = lastMessageRow(wrapper).find('.bubble-marker')
    expect(marker.text()).toBe('✓✓')
    expect(marker.attributes('title')).toBe(sendMarker(state)!.title)
    expect(marker.classes()).toContain('is-reacted')
  })

  it('carries a ✕ with the reason on hover, and keeps the words readable', () => {
    const state: DwarfSendState = { phase: 'failed', error: 'The relay never started.' }
    const wrapper = panel({ echoes: [echo({ state })] })
    const row = lastMessageRow(wrapper)
    expect(row.find('.bubble-marker').text()).toBe('✕')
    expect(row.find('.bubble-marker').attributes('title')).toBe('The relay never started.')
    // The bubble is kept rather than removed: it is the only copy of what the
    // person typed, and it is about to be sent again.
    expect(row.find('.bubble').text()).toBe('dig deeper')
  })

  it('falls back to the verdict’s own sentence when the channel gave no reason', () => {
    const state: DwarfSendState = { phase: 'failed' }
    const wrapper = panel({ echoes: [echo({ state })] })
    expect(lastMessageRow(wrapper).find('.bubble-marker').attributes('title')).toBe(
      sendMarker(state)!.title
    )
  })

  it('offers Send again on a failed message, and on no other', () => {
    const failed = panel({ echoes: [echo({ state: { phase: 'failed', error: 'nope' } })] })
    expect(failed.find('.bubble-retry').text()).toBe(SEND_AGAIN_LABEL)

    for (const phase of ['sending', 'delivered', 'reacted'] as const) {
      const other = panel({ echoes: [echo({ state: { phase } })] })
      expect(other.find('.bubble-retry').exists()).toBe(false)
    }
  })

  it("emits the failed message's own id, so a retry cannot land on another bubble", async () => {
    const wrapper = panel({
      echoes: [
        echo({ id: 'e1', text: 'first', state: { phase: 'delivered' } }),
        echo({ id: 'e2', text: 'second', state: { phase: 'failed', error: 'nope' } })
      ]
    })
    await wrapper.find('.bubble-retry').trigger('click')
    expect(wrapper.emitted('send-again')).toEqual([['e2']])
  })

  it('offers no retry for a session that can no longer be written to', () => {
    // A dwarf whose session has ended, or one with no channel at all: sending
    // again would promise a delivery the capability model has already refused.
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: undefined, conversation: HELD }),
      echoes: [echo({ state: { phase: 'failed', error: 'nope' } })]
    })
    expect(wrapper.find('.bubble-retry').exists()).toBe(false)
  })

  it('draws no marker at all against a row read off the transcript', () => {
    const wrapper = panel()
    expect(wrapper.find('.bubble-marker').exists()).toBe(false)
  })

  it('never folds an echo into a run of tool calls, because it is not the agent working', () => {
    // #294 groups consecutive activity rows and labels an open run
    // "Working...". A message somebody typed must not close that run.
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        conversation: [
          { role: 'assistant', text: 'Ran pnpm test', timestamp: 't0' },
          { role: 'assistant', text: 'Edited src/foo.ts', timestamp: 't1' }
        ]
      }),
      feed: undefined,
      echoes: [echo()]
    })
    expect(wrapper.find('.message.is-user .bubble').text()).toBe('dig deeper')
  })
})

/**
 * Stick-to-bottom, for the one row the reader wrote themselves (#195/#243, #309).
 *
 * The existing rule is deliberately conservative: a row arriving from the
 * session must not yank somebody who scrolled up. A message the person just
 * sent is the opposite case — it is their own action, and they are owed the
 * sight of it — and a tick changing on a bubble is neither, so it moves
 * nothing.
 */
describe('DwarfMessagePanel echo scroll (#309)', () => {
  function growingScrollHeight(list: Element, perMessage = 40): void {
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => list.querySelectorAll('.message').length * perMessage
    })
  }

  function fixedClientHeight(list: Element, value: number): void {
    Object.defineProperty(list, 'clientHeight', { value, configurable: true })
  }

  function echo(id: string, state: DwarfSendState): MessageEcho {
    return { id, text: 'dig deeper', sentAt: 0, state }
  }

  it('goes to a new echo even for a reader who had scrolled away, because they wrote it', async () => {
    const wrapper = panel({ echoes: [] })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 5 // 80 - 30 - 5 = 45, well past the tolerance: scrolled up.

    await wrapper.setProps({ echoes: [echo('e1', { phase: 'sending' })] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(120) // 3 rows * 40, the new bottom.
  })

  it('leaves the list exactly where it was when only a tick changed', async () => {
    const wrapper = panel({ echoes: [echo('e1', { phase: 'sending' })] })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 5

    await wrapper.setProps({
      echoes: [echo('e1', { phase: 'delivered', via: 'terminal', awaitingReaction: true })]
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(5)
  })
})

/**
 * Markdown in the bubbles (#347).
 *
 * What a construct MEANS is `lib/message/markdown`'s and how it is drawn is
 * `MarkdownBubble`'s; both have their own tests. What is pinned HERE is the
 * panel's own three decisions: that the bubble is that component, that the
 * person's rows and echoes get the same treatment as the agent's — the
 * maintainer's ruling, where the issue had left it open — and that the rows
 * which are not speech are untouched by any of it.
 */
describe('DwarfMessagePanel markdown (#347)', () => {
  const REPLY = '**Done**\n\n- Updated the provider\n- Added `pnpm test` coverage'

  function withReply(text: string, role: 'assistant' | 'user' = 'assistant') {
    return panel({
      dwarf: defaultDwarf({
        conversation: [{ role, text, timestamp: '2026-09-09T09:00:00.000Z' }]
      })
    })
  }

  it("renders an agent's Markdown as real elements, not as delimiters", () => {
    const wrapper = withReply(REPLY)
    expect(wrapper.find('.bubble strong').text()).toBe('Done')
    expect(wrapper.findAll('.bubble ul > li')).toHaveLength(2)
    expect(wrapper.find('.bubble code').text()).toBe('pnpm test')
    expect(wrapper.find('.bubble').text()).not.toContain('**')
  })

  /*
   * Symmetric, by maintainer ruling: the issue left the person's own bubbles
   * open, and half a panel that renders formatting is worse than either whole.
   */
  it("renders the person's own transcript rows the same way", () => {
    expect(withReply('**Done**', 'user').find('.message.is-user .bubble strong').text()).toBe(
      'Done'
    )
  })

  it('renders an echo the same way, so a message does not change on delivery', () => {
    const wrapper = panel({
      echoes: [
        {
          id: 'e1',
          text: '**now**',
          sentAt: Date.parse('2026-09-09T10:00:00.000Z'),
          state: { phase: 'sending' }
        }
      ]
    })
    expect(wrapper.findAll('.message').at(-1)!.find('.bubble strong').text()).toBe('now')
  })

  it('leaves plain text exactly as it was, line breaks included', () => {
    expect(withReply('Found the seam.\nTwo lines.').find('.bubble').text()).toBe(
      'Found the seam.\nTwo lines.'
    )
  })

  /*
   * An activity line is a sentence this app wrote about a tool call (#240), not
   * something anybody said — so it is not Markdown, and a path with an
   * underscore in it must not come out italic.
   */
  it('leaves an activity line as the literal text it always was', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        conversation: [
          {
            role: 'assistant',
            text: 'Edited src/_internal_/index.ts',
            timestamp: 't0',
            activity: { kind: 'edit', target: 'src/_internal_/index.ts' }
          }
        ]
      })
    })
    await wrapper.find('.activity-disclosure').trigger('click')
    const line = wrapper.find('.activity-line')
    expect(line.text()).toBe('Edited src/_internal_/index.ts')
    expect(line.find('em').exists()).toBe(false)
  })

  /*
   * The panel reports the press and opens nothing, exactly as it does for an
   * activity line's own path (#279): opening happens in MAIN.
   */
  it("reports a pressed link's address and opens nothing itself", async () => {
    const wrapper = withReply('see [the issue](https://example.test/347)')
    await wrapper.find('.bubble .markdown-link').trigger('click')
    expect(wrapper.emitted('open-link')).toEqual([['https://example.test/347']])
  })
})
