// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
/*
 * AMENDED for #635: motion-v's AnimatePresence and motion, and lib/message/panelHeight, are no
 * longer imported — the bubbles enter with the design's own pop-in and the panel has no height of
 * its own (see the REMOVED notes where their cases stood).
 */
import {
  APPROVAL_AT_TERMINAL_NOTE,
  NO_CHANNEL_REASON,
  SESSION_CLOSED_REASON
} from '../../lib/delivery/actionBar'
/* --- Message attachments (#408) — one block, appended -------------------- */
import { NO_ATTACH_CHANNEL_HINT, refusalSentence } from '../../lib/delivery/attachments'
/* --- end of the #408 block ----------------------------------------------- */
// AMENDED for #635 (was: SEND_AGAIN_LABEL): the design's Retry, decision log, Failed delivery.
import { COPY_LABEL, RETRY_LABEL, sendMarker } from '../../lib/delivery/deliveryVerdict'
import {
  NO_TRANSCRIPT_NOTE,
  NOTHING_SAID_NOTE,
  OBSERVED_NOTE,
  READING_NOTE
} from '../../lib/message/conversation'
import { CONVERSATION_START_NOTE, READING_OLDER_NOTE } from '../../lib/message/feedPages'
import { TOP_OF_LIST_TOLERANCE_PX } from '../../lib/message/listScroll'
import { TIP_DELAY_MS } from '../../lib/overlay/tipCard'
import type { MessageEcho } from '../../lib/message/echo'
import { defaultDwarf } from '../../testing/factories'
import {
  MAX_CODEX_QUEUE_TEXT_CHARS,
  MAX_DWARF_TEXT_CHARS,
  messageTooLongReason,
  type DwarfAttachment,
  type DwarfAttachmentPick,
  type DwarfFeedResult,
  type DwarfPermissionRequest,
  type DwarfSendState,
  type FeedMessage
} from '../../types'
import DwarfMessagePanel from './DwarfMessagePanel.vue'
import MenuButton from '../overlay/MenuButton.vue'
import DialogCard from '../overlay/DialogCard.vue'
import ModalDialog from '../overlay/ModalDialog.vue'
import type { MenuItem } from '../../lib/overlay/menu'
import {
  COMPOSER_HINT as COMPOSER_HINT_TEXT,
  MENU_CONSOLE,
  MENU_HISTORY,
  MENU_STOP
} from '../../lib/message/panelChrome'

// Every mounted panel is unmounted after its test, so no outcome clock or tooltip it started
// outlives the document jsdom's teardown empties (#635: CI caught five updating a detached tree).
enableAutoUnmount(afterEach)

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

const HELD = [
  { role: 'user' as const, text: 'dig here', timestamp: '2026-09-03T09:00:00.000Z' },
  { role: 'assistant' as const, text: 'Found the seam.', timestamp: '2026-09-03T09:00:01.000Z' }
]

/**
 * The exchange of a session this panel HOLDS, as `Runtime.dwarfFeed` answers it
 * since #436.
 *
 * These rows used to reach the component on `Dwarf.conversation`, which is why
 * nearly every case in this file used to hand them to the dwarf factory. They
 * come down the one feed channel now, marked first-hand, and `heldFeed` is that
 * one word: `source: 'held'` is the whole difference between the note this
 * panel draws over them and the one it draws over a transcript tail.
 */
function heldFeed(messages: readonly FeedMessage[]): DwarfFeedResult {
  return { readable: true, messages: [...messages], source: 'held' }
}

function panel(props: Record<string, unknown> = {}) {
  return mount(DwarfMessagePanel, {
    props: {
      dwarf: defaultDwarf({ textDelivery: 'terminal' }),
      feed: heldFeed(HELD),
      ...props
    }
  })
}

/*
 * REMOVED for #635, stated rather than passing unseen: `pointer` and `heightOf`, the helpers of
 * the resize-handle and height cases below. The panel has no height of its own: the dock sets it
 * and the person cannot resize it (decision log, MessagePanel and Add panel anchored).
 */

/** One animation frame, which the panel waits before it scrolls to the latest message (#635). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

describe('DwarfMessagePanel shape', () => {
  it('names the selected dwarf, as the design puts it at the top left', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ name: 'Durin' }) })
    expect(wrapper.find('.dm-msg__rename').text()).toBe('Durin')
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: "draws the dwarf's own portrait beside
   * what it said". The redesigned conversation draws no portrait beside a bubble (anatomy.md,
   * MessagePanel): the dwarf's face is the header's, and a bubble says who spoke by its side and
   * its name ("You" or "Dwarf").
   *
   * AMENDED for #635 (was: 'draws the launching agent against a prompt that agent issued', with
   * the issuer's portrait and name as its alt). #175's guarantee — a prompt another agent issued
   * is never drawn as the person's own — holds on the bubble itself: it is the dwarf side's.
   */
  it('draws a prompt another agent issued on the dwarf side, never as the person’s own', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ role: 'worker', name: 'survey the seam' }),
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

    const bubbles = wrapper.findAll('.dm-bubble')
    expect(bubbles[0]!.classes()).not.toContain('dm-bubble--user')
    expect(bubbles[0]!.attributes('aria-label')).toBe('Dwarf')
    expect(bubbles[1]!.classes()).not.toContain('dm-bubble--user')
  })

  // AMENDED for #635 (was: "keeps the user's own face on a launch the human typed", the portrait's
  // alt): the person's own prompt is the person's own bubble.
  it('keeps a launch the human typed as the person’s own bubble', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ role: 'foreman', name: 'coordinator' })
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.dm-bubble--user').attributes('aria-label')).toBe('You')
  })

  // AMENDED for #635 (was: the `.message.is-user` and `.is-agent` rows): the bubbles themselves.
  it('start-aligns the agent and end-aligns the user, as the design does', () => {
    const messages = panel().findAll('.dm-bubble')
    expect(messages[0]!.classes()).toContain('dm-bubble--user')
    expect(messages[1]!.classes()).not.toContain('dm-bubble--user')
  })

  /*
   * AMENDED for #635 (was: 'centres the history tab between the name and the close', the old
   * three-cell bar): the header is the portrait, the name over its chips, and the tools, in that
   * order (screens/message.md, As built, MessagePanel).
   */
  it('draws the portrait, the name and the tools across the header, as the design does', () => {
    const bar = [...panel().find('.dm-msg__head').element.children]
    expect(bar.map((child) => child.classList[0])).toEqual([
      'dm-portrait',
      'dm-msg__who',
      'dm-msg__tools'
    ])
    expect(panel().find('.dm-msg__who .dm-msg__rename').exists()).toBe(true)
  })

  /**
   * Which worktree the dwarf is in, beside its name (#348) — a mine is a
   * project, and its crew can be spread over every worktree of that project.
   */
  // AMENDED for #635 (was: the `· <branch>` label beside the name): the worktree meta chip.
  it('names the branch under the dwarf when it works in a worktree', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        name: 'Scout',
        workplace: { path: 'C:/Code/Anvil-worktrees/forge', branch: 'feat/console-paste' }
      })
    })
    const chips = wrapper.findAll('.dm-msg__chips .dm-meta')
    expect(chips.at(-1)!.text()).toBe('worktree: feat/console-paste')
    // Text, never a control: there is nothing to press about where a dwarf is.
    expect(chips.at(-1)!.element.tagName).toBe('SPAN')
  })

  it('names the worktree s folder when its HEAD is detached and carries no branch', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        workplace: { path: 'C:/Code/Anvil-worktrees/forge' }
      })
    })
    expect(wrapper.findAll('.dm-msg__chips .dm-meta').at(-1)!.text()).toBe('worktree: forge')
  })

  it('says nothing beside the name for a dwarf in the mine s own folder', () => {
    // Absent means the mine's own folder, and most dwarfs are there. A label
    // with nothing in it would read as a fact that failed to load.
    const chips = panel().findAll('.dm-msg__chips .dm-meta')
    expect(chips.map((chip) => chip.text())).toEqual(['Claude · test-model · medium'])
  })

  /*
   * AMENDED for #635 (was: 'carries the three controls the design draws: kick, boost and close').
   * The redesign's tools are Mine history, Open console, More and Close; the kick moved into the
   * ⋯ menu as Stop dwarf… and Boost is not drawn (screens/message.md, W4·6).
   */
  it('carries the tools the design draws, and no kick or boost beside the composer', () => {
    const wrapper = panel()
    const tools = wrapper.findAll('.dm-msg__tools button').map((tool) => tool.attributes('title'))
    expect(tools).toEqual(['Mine history', 'Open console', 'More', 'Close chat'])
    expect(wrapper.find('.dm-composer .dm-composer__kick').exists()).toBe(false)
  })

  it('gives the messages their own scroll, so history reads without expanding anything', () => {
    expect(panel().find('.dm-msg__log').exists()).toBe(true)
  })

  it('opens showing the latest message rather than the oldest', async () => {
    // Oldest first is the design's order, so an unscrolled panel would open on
    // the message furthest from what just happened.
    const wrapper = panel()
    const list = wrapper.find('.dm-msg__log').element
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })
    await wrapper.vm.$nextTick()
    // AMENDED for #635: one frame after it is built, as the design's panel does it.
    await nextFrame()
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
  await wrapper.find('.dm-activity__toggle').trigger('click')
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
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(CONVERSATION) })
    await openRun(wrapper)
    const line = wrapper.find('.dm-activity__list li')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe('Ran pnpm test')
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: 'carries the full text as the title, for
   * the truncated line to expand on hover'. The redesigned step list (activity.css) wraps a step
   * rather than cutting it, so a plain step has nothing hidden for a title to carry; a step that
   * opens a path still carries it ('still carries the full text as the title…', below).
   */

  it('draws no portrait and no bubble surface for a tool-call line', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(CONVERSATION) })
    await openRun(wrapper)
    const line = wrapper.find('.dm-activity__list li')
    expect(line.find('.portrait').exists()).toBe(false)
    expect(line.classes()).not.toContain('bubble')
  })

  it('still draws the ordinary bubbles either side of the tool-call line', () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(CONVERSATION) })
    expect(wrapper.findAll('.dm-bubble__text').map((bubble) => bubble.text())).toEqual([
      'dig here',
      'Tests pass.'
    ])
  })

  it('counts the tool-call line as one row in the conversation, same as a bubble', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(CONVERSATION) })
    await openRun(wrapper)
    expect(wrapper.findAll('.dm-bubble__text')).toHaveLength(2)
    expect(wrapper.findAll('.dm-activity__list li')).toHaveLength(1)
  })

  // AMENDED for #635 (was: a `<p>`): a list item of the run's step list, with no control in it.
  it('draws a run line as plain text rather than a clickable control', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(CONVERSATION) })
    await openRun(wrapper)
    expect(wrapper.find('.dm-activity__list li').element.tagName).toBe('LI')
    expect(wrapper.find('.dm-activity__list li button').exists()).toBe(false)
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
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(WITH_EDIT) })
    await openRun(wrapper)
    // AMENDED for #635 (was: the line itself, `.activity-line.is-openable`): the step's own button.
    const line = wrapper.find('.dm-activity__list li .dm-activity__path')
    expect(line.element.tagName).toBe('BUTTON')
    expect(line.attributes('type')).toBe('button')
  })

  it('draws a read line the same way an edit line is drawn', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(WITH_READ) })
    await openRun(wrapper)
    expect(wrapper.find('.dm-activity__list li .dm-activity__path').element.tagName).toBe('BUTTON')
  })

  it("emits the activity's own target on click, not the display text", async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(WITH_EDIT) })
    await openRun(wrapper)
    await wrapper.find('.dm-activity__path').trigger('click')
    expect(wrapper.emitted('open-path')).toEqual([['src/main/index.ts']])
  })

  it('still carries the full text as the title, same as a plain activity line', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(WITH_EDIT) })
    await openRun(wrapper)
    expect(wrapper.find('.dm-activity__path').attributes('title')).toBe('Edited src/main/index.ts')
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

  // AMENDED for #635 (was: none of its lines rendered): the design's step list is drawn hidden.
  it('draws one disclosure row for the whole run, and none of its lines, until it is pressed', () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(RUN_OF_THREE) })
    expect(wrapper.findAll('.dm-activity__toggle')).toHaveLength(1)
    expect(wrapper.find('.dm-activity__list').attributes('hidden')).toBeDefined()
    expect(wrapper.findAll('.dm-bubble__text')).toHaveLength(2)
  })

  it('is a button carrying its own state, so Enter and Space reach it like any other control', () => {
    const row = panel({ dwarf: defaultDwarf(), feed: heldFeed(RUN_OF_THREE) }).find(
      '.dm-activity__toggle'
    )
    expect(row.element.tagName).toBe('BUTTON')
    expect(row.attributes('type')).toBe('button')
    expect(row.attributes('aria-expanded')).toBe('false')
  })

  /*
   * AMENDED for #635 (was: 'counts the run and names its last call', "3 steps — Edited …" with the
   * same words as its title): the design's disclosure reads "3 steps · activity" (anatomy.md,
   * MessagePanel), as the history's always did; the steps themselves are one press away.
   */
  it('counts the run, once a bubble has closed it', () => {
    const row = panel({ dwarf: defaultDwarf(), feed: heldFeed(RUN_OF_THREE) }).find(
      '.dm-activity__toggle'
    )
    expect(row.text()).toBe('3 steps · activity')
  })

  it('reads Working... while the run is the last thing a live session has done', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ status: 'working' }),
      feed: heldFeed(RUN_OF_THREE.slice(0, 4))
    })
    expect(wrapper.find('.dm-activity__toggle').text()).toBe('Working...')
  })

  it('counts the run instead, once the session behind it has ended', () => {
    // Nothing further can join it, so the honest label is the finished one —
    // a "Working..." row on an ended session claims work still going on.
    const wrapper = panel({
      dwarf: defaultDwarf({ status: 'leaving' }),
      feed: heldFeed(RUN_OF_THREE.slice(0, 4))
    })
    // AMENDED for #635: the design's count (was: "3 steps — Edited src/main/index.ts").
    expect(wrapper.find('.dm-activity__toggle').text()).toBe('3 steps · activity')
  })

  it('opens in place to the exact lines of the run, in order, on a press', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(RUN_OF_THREE) })
    await wrapper.find('.dm-activity__toggle').trigger('click')

    expect(wrapper.findAll('.dm-activity__list li').map((line) => line.text())).toEqual([
      'Read src/shared/contracts.ts',
      'Ran pnpm test',
      'Edited src/main/index.ts'
    ])
    expect(wrapper.find('.dm-activity__toggle').attributes('aria-expanded')).toBe('true')
  })

  it('collapses again on a second press', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(RUN_OF_THREE) })
    await wrapper.find('.dm-activity__toggle').trigger('click')
    await wrapper.find('.dm-activity__toggle').trigger('click')

    // AMENDED for #635: hidden again, as the design's list is (was: no lines rendered).
    expect(wrapper.find('.dm-activity__list').attributes('hidden')).toBeDefined()
    expect(wrapper.find('.dm-activity__toggle').attributes('aria-expanded')).toBe('false')
  })

  it("still emits an opened line's own target from inside an expanded run", async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(RUN_OF_THREE) })
    await wrapper.find('.dm-activity__toggle').trigger('click')
    await wrapper.findAll('.dm-activity__path')[1]!.trigger('click')

    expect(wrapper.emitted('open-path')).toEqual([['src/main/index.ts']])
  })

  it('keeps each run its own, so opening one leaves the other closed', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: heldFeed([
        ...RUN_OF_THREE,
        {
          role: 'assistant' as const,
          text: 'Searched TODO',
          timestamp: 't5',
          activity: { kind: 'search' as const, target: 'TODO' }
        }
      ])
    })
    const rows = wrapper.findAll('.dm-activity__toggle')
    expect(rows).toHaveLength(2)

    await rows[1]!.trigger('click')

    const after = wrapper.findAll('.dm-activity__toggle')
    expect(after[0]!.attributes('aria-expanded')).toBe('false')
    expect(after[1]!.attributes('aria-expanded')).toBe('true')
    // AMENDED for #635: the lines of the list that is not hidden (was: the only lines rendered).
    expect(
      wrapper.findAll('.dm-activity__list:not([hidden]) li').map((line) => line.text())
    ).toEqual(['Searched TODO'])
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
        // AMENDED for #635: the bubbles, the open steps and the disclosure rows.
        list.querySelectorAll(
          '.dm-bubble, .dm-activity__list:not([hidden]) li, .dm-activity__toggle'
        ).length * perRow
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
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(WITH_RUN) })
    const list = wrapper.find('.dm-msg__log').element
    growingScrollHeight(list)
    Object.defineProperty(list, 'clientHeight', { value: 30, configurable: true })
    await wrapper.vm.$nextTick()
    list.scrollTop = 5

    await wrapper.find('.dm-activity__toggle').trigger('click')
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(5)
  })

  it('does not yank a reader who scrolled up when a collapsed run grows', async () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: heldFeed(WITH_RUN) })
    const list = wrapper.find('.dm-msg__log').element
    growingScrollHeight(list)
    Object.defineProperty(list, 'clientHeight', { value: 30, configurable: true })
    await wrapper.vm.$nextTick()
    list.scrollTop = 5 // 80 - 30 - 5 = 45, well past the tolerance: scrolled up.

    await wrapper.setProps({
      dwarf: defaultDwarf(),
      feed: heldFeed([
        ...WITH_RUN,
        {
          role: 'assistant',
          text: 'Edited src/main/index.ts',
          timestamp: 't2',
          activity: { kind: 'edit', target: 'src/main/index.ts' }
        }
      ])
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
      get: () => list.querySelectorAll('.dm-bubble').length * perMessage
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
    const wrapper = panel({ dwarf: defaultDwarf(), feed: undefined })
    const list = wrapper.find('.dm-msg__log').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    await nextFrame()
    // AMENDED for #635 (was: 40, the empty-state placeholder row): the empty state is the note
    // line in the log, which is no bubble, so there is nothing to have scrolled past at all.
    expect(list.scrollTop).toBe(0)

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
    const wrapper = panel({ dwarf: defaultDwarf() })
    const list = wrapper.find('.dm-msg__log').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 50 // HELD has 2 rows: 80 - 30 - 50 = 0, exactly at the bottom.

    await wrapper.setProps({
      dwarf: defaultDwarf(),
      feed: heldFeed([...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }])
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(120) // 3 rows * 40, the new bottom.
  })

  it("keeps the reader's own scroll position when a row arrives below where they had scrolled up to", async () => {
    const wrapper = panel({ dwarf: defaultDwarf() })
    const list = wrapper.find('.dm-msg__log').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 5 // 80 - 30 - 5 = 45, well past the tolerance: scrolled up.

    await wrapper.setProps({
      dwarf: defaultDwarf(),
      feed: heldFeed([...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }])
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // A row landed below the fold; a reader who had scrolled up must not be
    // yanked back down to read it (#195).
    expect(list.scrollTop).toBe(5)
  })
})

/*
 * REMOVED for #635, stated rather than passing unseen: the whole 'DwarfMessagePanel height' block
 * (the opening height from the latest message, never resizing on a new one, recalculating on a
 * reopen, the vertical drag, its floor and ceiling, a pointer that never grabbed, the keyboard
 * resize) and the whole 'DwarfMessagePanel history tab' block (expanding to the full transcript,
 * giving the height back, a portrait on every message). The panel has no height of its own: the
 * dock sets it, the person cannot resize it and the conversation scrolls inside (decision log,
 * MessagePanel and Add panel anchored), so lib/message/panelHeight went with them. The history the
 * tab expanded is the mine history now, which the header's Mine history tool opens in the dock
 * ('DwarfMessagePanel header tools (#635)', below).
 */

describe('DwarfMessagePanel input', () => {
  it('sends on Enter and writes a newline on Shift+Enter', async () => {
    const wrapper = panel()
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')

    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([[{ text: 'dig deeper', pressEnter: true }]])
  })

  it('clears the box once the message has left', async () => {
    const wrapper = panel()
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect((wrapper.find('.dm-composer textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('refuses to send a blank message', async () => {
    const wrapper = panel()
    await wrapper.find('.dm-composer textarea').setValue('   ')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('sends nothing while a send is still in flight', async () => {
    const wrapper = panel({ sendState: { phase: 'sending' } })
    await wrapper.find('.dm-composer textarea').setValue('dig deeper')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  /*
   * AMENDED for #431 (was: 'caps the message at the shared delivery limit',
   * asserting a `maxlength` of MAX_DWARF_TEXT_CHARS on the box).
   *
   * That attribute WAS the defect: a paste longer than the cap lost its ending
   * without a word, and the runtime then cut the remainder again and reported
   * it delivered. The box now takes whatever the person pastes and the panel
   * says, in the alert ink, that it is too long to send — so the words stay
   * theirs to trim. The five tests below are what replaces this one.
   */
  it('lets the box hold whatever was pasted, rather than cutting it at a limit', () => {
    expect(panel().find('.dm-composer textarea').attributes('maxlength')).toBeUndefined()
  })

  it("says so in the alert ink when the text is past this channel's ceiling", async () => {
    // AMENDED for #433: this dwarf's route is a console, and the sentence it
    // gets names the WIRE ceiling now — the console's own 6,541 went with the
    // command line its script used to be spawned in.
    const wrapper = panel()
    const text = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 1)
    await wrapper.find('.dm-composer textarea').setValue(text)
    expect(wrapper.find('.dm-composer__hint[role="alert"]').text()).toBe(
      messageTooLongReason(text.length, MAX_DWARF_TEXT_CHARS, 'terminal')
    )
  })

  it('keeps the text and sends nothing when Enter is pressed on an over-long message', async () => {
    const wrapper = panel()
    const text = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 1)
    const input = wrapper.find('.dm-composer textarea')
    await input.setValue(text)
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
    expect((input.element as HTMLTextAreaElement).value).toBe(text)
  })

  it('sends again the moment the person has trimmed it back inside the ceiling', async () => {
    const wrapper = panel()
    const input = wrapper.find('.dm-composer textarea')
    await input.setValue('x'.repeat(MAX_DWARF_TEXT_CHARS + 1))
    await input.setValue('x'.repeat(MAX_DWARF_TEXT_CHARS))
    expect(wrapper.find('.dm-composer__hint[role="alert"]').exists()).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  /*
   * AMENDED for #433 (was: 'reads the ceiling off the capability, so a wider
   * channel says a wider number', which stamped a relay's wire ceiling and sent
   * a message the console route above refuses).
   *
   * Every route answers the same number now, so that shape could no longer tell
   * a capability-reading composer from one that had the wire ceiling hardcoded
   * — it would pass either way. The stamped number is made deliberately narrow
   * instead, which is the property the test was always about: main decides how
   * much a route carries, and the panel refuses exactly what main refuses.
   */
  it('reads the ceiling off the capability, whatever number main stamped there', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'claude-relay',
        capabilities: {
          sendText: 'claude-relay',
          cancel: 'claude-relay',
          adjustEffort: null,
          attach: null,
          maxTextChars: 100
        }
      })
    })
    const input = wrapper.find('.dm-composer textarea')
    await input.setValue('x'.repeat(101))
    expect(wrapper.find('.dm-composer__hint[role="alert"]').text()).toBe(
      messageTooLongReason(101, 100, 'claude-relay')
    )
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()

    await input.setValue('x'.repeat(100))
    expect(wrapper.find('.dm-composer__hint[role="alert"]').exists()).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  /* --- The relay's prompt on stdin (#437) — appended ------------------------ */

  /*
   * Issue #437. The routes stopped agreeing on one number: the Codex queue
   * keeps a real command-line bound and everything else answers the wire's
   * sanity ceiling. The composer's sentence has to name the ROUTE's number, so
   * a Codex dwarf is told the queue's and its neighbour is not.
   */
  it('names the Codex queue own number, which is tighter than every other route', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: 'codex-queue' }) })
    const text = 'x'.repeat(MAX_CODEX_QUEUE_TEXT_CHARS + 1)
    await wrapper.find('.dm-composer textarea').setValue(text)
    expect(wrapper.find('.dm-composer__hint[role="alert"]').text()).toBe(
      messageTooLongReason(text.length, MAX_CODEX_QUEUE_TEXT_CHARS, 'codex-queue')
    )
  })

  it('lets a relayed session take 40,000 characters, which no argv could have', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: 'claude-relay' }) })
    const input = wrapper.find('.dm-composer textarea')
    await input.setValue('x'.repeat(40_000))
    expect(wrapper.find('.dm-composer__hint[role="alert"]').exists()).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('refuses the same 40,000 characters on a Codex dwarf, before anything is sent', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: 'codex-queue' }) })
    const input = wrapper.find('.dm-composer textarea')
    await input.setValue('x'.repeat(40_000))
    expect(wrapper.find('.dm-composer__hint[role="alert"]').text()).toContain(
      String(MAX_CODEX_QUEUE_TEXT_CHARS)
    )
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })
  /* --- end of the #437 block ------------------------------------------------ */

  /*
   * REMOVED for #635, stated rather than passing unseen: 'keeps the input selectable, which the
   * design asks for by name'. The class it read belonged to the old textarea; the composer's well
   * is the kit's Input now, a native textarea whose text is selectable as every native field's is,
   * and the redesign names no such rule.
   */

  it('disables the box, with its reason, for a session that cannot be written to', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: undefined }) })
    const input = wrapper.find('.dm-composer textarea')
    expect(input.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-composer .dm-field').attributes('title')).toContain(
      "can't receive messages yet"
    )
  })

  it('disables the box, saying the session has ended, for a dwarf that is leaving', () => {
    // #192: the channel the session HAD is still on the dwarf, frozen by the
    // grace window; the box must read the capability model, not the field.
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', status: 'leaving' })
    })
    const input = wrapper.find('.dm-composer textarea')
    expect(input.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-composer .dm-field').attributes('title')).toContain('ended')
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('ended')
  })

  it('names the channel a message would travel through', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: 'foreman-relay' }) })
    expect(panel().find('.dm-composer .dm-field').attributes('title')).toContain('console')
    expect(wrapper.find('.dm-composer .dm-field').attributes('title')).toContain('foreman')
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
        capabilities: {
          sendText: null,
          cancel: 'launched-process',
          adjustEffort: null,
          attach: null
        }
      })
    })
    expect(wrapper.find('.dm-composer textarea').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-composer__hint').text()).toContain('codex exec')
    // The provenance note keeps its own row: what the panel may claim about a
    // transcript is a different fact from why a control is disabled.
    expect(wrapper.find('.dm-msg__log').attributes('title') !== undefined).toBe(true)
  })

  /*
   * AMENDED for #293 (was: "shows the kick's refusal in the panel when the
   * composer works and it does not", expecting the queue's "between turns"
   * sentence on the refusal row). Neither control refuses this dwarf any more —
   * the composer sends and the kick dismisses — so the row would be the panel
   * apologising for two controls that both work. What the kick does is on the
   * control itself.
   */
  it('draws no refusal for a queue-only thread: the composer sends, the kick dismisses', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        textDelivery: 'codex-queue',
        capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null, attach: null }
      })
    })
    expect(wrapper.find('.dm-composer textarea').attributes('disabled')).toBeUndefined()
    // AMENDED for #635 (was: no `.panel-refusal` row, and the kick's title): the hint is the
    // keyboard's, and what the kick does is what Stop dwarf… says before it stops.
    expect(wrapper.find('.dm-composer__hint').text()).toBe(COMPOSER_HINT_TEXT)
    expect(await stopHint(wrapper)).toContain('off the rock')
  })

  it('draws no refusal row at all when both controls work', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        capabilities: {
          sendText: 'terminal',
          cancel: 'terminal',
          adjustEffort: null,
          attach: 'terminal'
        }
      })
    })
    // AMENDED for #635 (was: no `.panel-refusal` row): the hint is the keyboard's own.
    expect(wrapper.find('.dm-composer__hint').text()).toBe(COMPOSER_HINT_TEXT)
  })

  it('lets a failure reason take the floor rather than doubling up with a refusal', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: undefined }),
      sendState: { phase: 'failed', error: 'The relay never answered.' }
    })
    expect(wrapper.find('.dm-composer__hint[role="alert"]').text()).toBe(
      'The relay never answered.'
    )
    // AMENDED for #635 (was: no `.panel-refusal` row beside the alert): one hint line, the alert.
    expect(wrapper.findAll('.dm-composer__hint')).toHaveLength(1)
  })

  it('shows the send verdict without ever blurring handed over and reacted', () => {
    const handed = panel({
      sendState: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
    expect(handed.find('.dm-composer__hint[role="status"]').text()).toContain('Handed over')
    expect(handed.find('.dm-composer__hint[role="status"]').text()).not.toContain('reacted.')

    const reacted = panel({ sendState: { phase: 'reacted', via: 'terminal' } })
    expect(reacted.find('.dm-composer__hint[role="status"]').text()).toContain(
      'the session reacted'
    )

    const failed = panel({ sendState: { phase: 'failed', error: 'The relay never answered.' } })
    expect(failed.find('.dm-composer__hint[role="alert"]').text()).toBe('The relay never answered.')
  })
})

/** The ⋯ menu's Stop dwarf… row, as the panel hands it to the menu (#635). */
function stopItem(wrapper: ReturnType<typeof panel>): MenuItem {
  return (wrapper.findComponent(MenuButton).props('items') as MenuItem[])[MENU_STOP]!
}

/** The confirmation Stop dwarf… opens (#635). */
function stopDialog(wrapper: ReturnType<typeof panel>) {
  return wrapper.findComponent(ModalDialog)
}

/** Stop dwarf… picked from the ⋯ menu. */
function pickStop(wrapper: ReturnType<typeof panel>): void {
  wrapper.findComponent(MenuButton).vm.$emit('pick', MENU_STOP)
}

/**
 * What stopping THIS session does, as the confirmation says it beside the design's sentence: the
 * kick's own hint from the capability model (#383), read off the panel's own action model.
 */
async function stopHint(wrapper: ReturnType<typeof panel>): Promise<string | undefined> {
  pickStop(wrapper)
  await wrapper.vm.$nextTick()
  const said = wrapper
    .findComponent(DialogCard)
    .findAll('p')
    .map((line) => line.text())
  stopDialog(wrapper).vm.$emit('cancel')
  await wrapper.vm.$nextTick()
  return said[1]
}

describe('DwarfMessagePanel controls', () => {
  const kickable = defaultDwarf({
    textDelivery: 'terminal',

    capabilities: {
      sendText: 'terminal',
      cancel: 'terminal',
      adjustEffort: null,
      attach: 'terminal'
    }
  })

  /*
   * AMENDED for #635 throughout this block (was: the `.control-kick` button beside the composer,
   * its title and its aria-label). The kick is Stop dwarf… in the ⋯ menu, which confirms first
   * (screens/message.md, W4·6); what each case says about when it is live, what it does and when
   * it is locked is unchanged, read off the menu item and the confirmation instead. The
   * confirmation is the design's, which is also what took #293's one click away: the design asks
   * first for anything destructive.
   */
  it('stops on the confirmation, and never before it', async () => {
    const wrapper = panel({ dwarf: kickable })
    pickStop(wrapper)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('kick')).toBeUndefined()
    expect(stopDialog(wrapper).props('open')).toBe(true)

    stopDialog(wrapper).vm.$emit('action', 1)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('kick')).toHaveLength(1)
    expect(stopDialog(wrapper).props('open')).toBe(false)
  })

  it('stops nothing when the confirmation is cancelled', async () => {
    const wrapper = panel({ dwarf: kickable })
    pickStop(wrapper)
    await wrapper.vm.$nextTick()
    stopDialog(wrapper).vm.$emit('action', 0)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('kick')).toBeUndefined()
    expect(stopDialog(wrapper).props('open')).toBe(false)
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
  it('keeps kick live where nothing can be cancelled, and says it dismisses', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        capabilities: { sendText: null, cancel: null, adjustEffort: null, attach: null }
      })
    })
    expect(stopItem(wrapper).disabled).toBe(false)
    expect(await stopHint(wrapper)).toContain('off the rock')
  })

  /* AMENDED for #293, same reason (was: 'disables kick when the dwarf ...'). */
  it('keeps kick live when the dwarf carries no capability matrix at all', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ status: 'waiting', capabilities: undefined }) })
    expect(stopItem(wrapper).disabled).toBe(false)
  })

  /*
   * The other half of #305, step 3, and the only place it is proven to reach
   * the DOM: a dismissal on a dwarf mid-turn is undone by the next poll, so the
   * control is genuinely disabled rather than merely re-worded.
   */
  it('disables kick while a turn nothing can interrupt is open, with the reason', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'working',
        capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null, attach: null }
      })
    })
    expect(stopItem(wrapper).disabled).toBe(true)
    expect(await stopHint(wrapper)).toContain('cannot be stopped from')
  })

  /*
   * A finished worker (#219, #293). Its session ended, so there is nothing to
   * interrupt — and that is exactly why the control is worth having here: it
   * ends the leaving walk instead of leaving the dwarf standing on the rock
   * for the rest of its grace.
   */
  it('offers kick on a session that has ended, to end its walk', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ status: 'leaving' }) })
    expect(stopItem(wrapper).disabled).toBe(false)
    expect(await stopHint(wrapper)).toContain('has ended')
    pickStop(wrapper)
    await wrapper.vm.$nextTick()
    stopDialog(wrapper).vm.$emit('action', 1)
    expect(wrapper.emitted('kick')).toHaveLength(1)
  })

  it('names what kicking THIS channel actually does, rather than one generic promise', async () => {
    const relay = panel({
      dwarf: defaultDwarf({
        capabilities: {
          sendText: 'claude-relay',
          cancel: 'claude-relay',
          adjustEffort: null,
          attach: null
        }
      })
    })
    expect(await stopHint(relay)).toBe('Asks the agent to stop — it decides how.')
  })

  it('locks the kick control while a kick is in flight', async () => {
    const wrapper = panel({ dwarf: kickable, kickState: { phase: 'kicking' } })
    expect(stopItem(wrapper).disabled).toBe(true)
    // Even a confirmation that was already open stops nothing while one is in flight.
    pickStop(wrapper)
    await wrapper.vm.$nextTick()
    stopDialog(wrapper).vm.$emit('action', 1)
    expect(wrapper.emitted('kick')).toBeUndefined()
  })

  it('shows the kick verdict, keeping handed over apart from reacted', () => {
    // AMENDED for #383 (was: via: 'terminal', asserting the status contained
    // 'Kick handed over' — true before #329/#383 made the terminal tier end
    // the session outright, which now shows "Ended the session…" instead
    // (see 'says a kick ENDED the session via the terminal tier' below).
    // This test's point is the generic handed-over wording, not the
    // terminal tier's own, so a channel that still only asks, claude-relay,
    // keeps that point covered.)
    const wrapper = panel({
      dwarf: kickable,
      kickState: { phase: 'delivered', via: 'claude-relay', awaitingReaction: true }
    })
    expect(wrapper.find('.dm-composer__hint[role="status"]').text()).toContain('Kick handed over')
  })

  /*
   * Ending a session and interrupting a turn are different acts, and the person
   * must not be told the wrong one (#217).
   */
  it('says a kick ENDED the session where that is what it did', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        capabilities: {
          sendText: null,
          cancel: 'launched-process',
          adjustEffort: null,
          attach: null
        }
      }),
      kickState: { phase: 'delivered', via: 'launched-process' }
    })
    const line = wrapper.find('.dm-composer__hint[role="status"]').text()
    expect(line).toContain('Ended the session')
    expect(line).not.toContain('handed over')
  })

  /*
   * The terminal tier's own case (#383, #329): it ends the session same as
   * launched-process, but the panel never launched it, so the sentence says
   * the one further fact worth saying instead — the terminal is left at its
   * prompt — rather than repeating a claim that would be false here.
   */
  it('says a kick ENDED the session via the terminal tier, and names its own terminal detail', () => {
    const wrapper = panel({
      dwarf: kickable,
      kickState: { phase: 'delivered', via: 'terminal' }
    })
    const line = wrapper.find('.dm-composer__hint[role="status"]').text()
    expect(line).toContain('Ended the session')
    expect(line).toContain('its terminal is left at its prompt')
    expect(line).not.toContain('handed over')
    expect(line).not.toContain('watching')
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: 'draws Boost where the design puts it and
   * refuses to pretend it works' and 'passes a Codex reasoning_effort value through as it was
   * reported', with the control they read. Boost is never enabled, since no provider supports it,
   * and the redesign puts it behind a switch like the guild areas rather than drawing a dead
   * control (screens/message.md, W4·6). The effort a session reports is in the header's meta chip.
   */

  it('closes on the close control and on Escape', async () => {
    const wrapper = panel()
    await wrapper.find('.dm-msg__close').trigger('click')
    await wrapper.find('.dm-msg').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  /*
   * AMENDED for #635 (was: "focuses the session's console from the dwarf's own name"). The
   * redesign draws the console as a tool of its own, and in the ⋯ menu as Open console; the name
   * is the dwarf's title, which renames it once the dwarf names slice lands.
   */
  it("focuses the session's console from the header's Console tool and from the ⋯ menu", async () => {
    const wrapper = panel()
    await wrapper.find('.dm-msg__console').trigger('click')
    wrapper.findComponent(MenuButton).vm.$emit('pick', MENU_CONSOLE)
    expect(wrapper.emitted('open-console')).toHaveLength(2)
  })

  // APPENDED for #635: the history is the mine's, opened in the dock in place of this panel.
  it('asks for the mine history from the header and from the ⋯ menu', async () => {
    const wrapper = panel()
    await wrapper.findAll('.dm-msg__tools button')[0]!.trigger('click')
    wrapper.findComponent(MenuButton).vm.$emit('pick', MENU_HISTORY)
    expect(wrapper.emitted('history')).toHaveLength(2)
  })
})

/**
 * The question card, re-homed (#128, #159). Its own behaviours are its own
 * tests; what belongs here is that the panel gives it the designed place —
 * above the input — and forwards both of its channels unchanged.
 */
describe('DwarfMessagePanel question', () => {
  // AMENDED for #443 (was: the question's fields flat beside `questionCount: 1`).
  const pendingQuestion = {
    toolUseId: 'toolu_01',
    channel: 'held' as const,
    questions: [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }]
      }
    ]
  }

  function asking(props: Record<string, unknown> = {}) {
    return panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion }),
      ...props
    })
  }

  /*
   * REMOVED for #635, stated rather than passing unseen: 'opens tall enough to hold the whole ask,
   * without squashing the conversation'. The panel's height is the dock's, and the conversation
   * scrolls inside above the card (decision log, MessagePanel and Add panel anchored).
   */

  // AMENDED for #635 (was: `.question-card`): the design's card is `section.dm-qcard`.
  it('shows no question surface for a dwarf with nothing outstanding', () => {
    expect(panel().find('.dm-qcard').exists()).toBe(false)
  })

  it('forwards the jump on a question it cannot answer to the console path (#354)', async () => {
    // Same wire the permission card's jump already travels, so one gesture
    // reaches one handler: the window turns `open-console` into activate().
    //
    // AMENDED for #362 (was: a terminal-channel ask with one question). A
    // one-question ask on that channel is answered by keystroke now and draws
    // no jump, so the unanswerable case this asserts is a call that asked
    // SEVERAL questions. What is asserted — one jump, on the console path, and
    // no answer emitted — is unchanged.
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',

        // AMENDED for #443 (was: `questionCount: 2`): the same call, carried whole.
        pendingQuestion: {
          ...pendingQuestion,
          channel: 'terminal' as const,
          questions: [
            ...pendingQuestion.questions,
            { question: 'Which region?', multiSelect: false, options: [{ label: 'East' }] }
          ]
        }
      })
    })
    // AMENDED for #635 (was: `.question-card .answer-jump`): the walk's Jump to terminal.
    await wrapper.find('.dm-qcard .dm-qcard__jump').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('replaces the composer with the ask, exactly as the design draws it', () => {
    // The two question exports show the option cards and the card's own
    // `Other Thing` box where the ordinary input sits — one input, not two.
    // AMENDED for #635 (was: the card first in the composer, the kick and boost column beside it):
    // the card takes the composer's place at the bottom of the panel (W4·7), and no composer and
    // no control column stands beside it.
    // AMENDED for #635 again (was: `.question-card`): the design's `section.dm-qcard`.
    const wrapper = asking()
    const bottom = [...wrapper.find('.dm-msg__bottom').element.children]
    expect(bottom[0]?.classList.contains('dm-qcard')).toBe(true)
    expect(wrapper.find('.dm-composer').exists()).toBe(false)
  })

  // AMENDED for #635 (was: once Enter confirms it): the card's Submit is its one send.
  it('forwards the chosen option once Submit confirms it', async () => {
    const wrapper = asking()
    await wrapper.findAll('.dm-qopt')[1]!.trigger('click')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    expect(wrapper.emitted('answer')).toEqual([['SQLite']])
  })

  // AMENDED for #635 (was: Enter in the always-open box): "Other thing…", then Send.
  // AMENDED for #635 (PO decision 2026-09-28, held free-text answers; was: 'routes a free-form
  // reply through the ordinary message path, not the ask', expecting `send`): a held question
  // takes the person's own words as its answer, so they leave on the answer path, marked.
  it('routes a free-form reply to a held ask as its answer, in the person’s own words', async () => {
    const wrapper = asking()
    await wrapper.find('.dm-qopt--other').trigger('click')
    await wrapper.find('.dm-qopt-other-field input').setValue('neither, keep the file store')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    expect(wrapper.emitted('answer')).toEqual([[[{ ownWords: 'neither, keep the file store' }]]])
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it("hands main's refusal down to the card, which draws no alert for it", () => {
    const wrapper = asking({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'That session is not one this panel is holding.'
      }
    })
    // AMENDED for #635 (was: `.answer-error`): the card's own alert row.
    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: main's reason in the card's alert row): the card draws no alert; the reason is the ✕ title on the "Answers:" record.
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
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

  // AMENDED for #443 (was: the question's fields flat beside `questionCount: 1`).
  const pendingQuestion = {
    toolUseId: 'toolu_01',
    channel: 'held' as const,
    questions: [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }]
      }
    ]
  }

  function withPermission(props: Record<string, unknown> = {}) {
    return panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingPermission }),
      ...props
    })
  }

  /*
   * REMOVED for #635, stated rather than passing unseen: 'opens tall enough to hold the whole
   * prompt, without squashing the conversation', for the reason the ask's own went.
   */

  it('replaces the composer with the permission card, exactly as an ask would', () => {
    // AMENDED for #635, as the ask's own above.
    // AMENDED for #635 again (was: `.permission-card`): the one card, with its request block.
    const wrapper = withPermission()
    const bottom = [...wrapper.find('.dm-msg__bottom').element.children]
    expect(bottom[0]?.classList.contains('dm-qcard')).toBe(true)
    expect(wrapper.find('.dm-qcard__req').exists()).toBe(true)
    expect(wrapper.find('.dm-composer').exists()).toBe(false)
  })

  // AMENDED for #635 (was: once Enter confirms it): Submit.
  it('forwards the chosen decision once Submit confirms it', async () => {
    const wrapper = withPermission()
    await wrapper.findAll('.dm-qopt')[0]!.trigger('click')
    await wrapper.find('.dm-qcard__submit').trigger('click')
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

        pendingPermission,
        pendingQuestion
      })
    })
    // AMENDED for #635 (was: `.permission-card` and `.question-card`): the request block shows,
    // and the ask's question text does not.
    expect(wrapper.find('.dm-qcard__req').exists()).toBe(true)
    expect(wrapper.find('.dm-qcard__q').exists()).toBe(false)
  })

  // AMENDED for #635 (was: Enter in the always-open box): "Other thing…", then Send.
  it('routes a free-form reply through the ordinary message path, not the decision', async () => {
    const wrapper = withPermission()
    await wrapper.find('.dm-qopt--other').trigger('click')
    await wrapper.find('.dm-qopt-other-field input').setValue('let me check this first')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    expect(wrapper.emitted('send')).toEqual([
      [{ text: 'let me check this first', pressEnter: true }]
    ])
    expect(wrapper.emitted('decide')).toBeUndefined()
  })
})

/**
 * #409: a selection is not finished until the composer has the keyboard — the
 * person still had to find and click the box themselves. Attached to the
 * document for every case here, because `document.activeElement` means
 * nothing against a detached tree.
 *
 * Main's half of the same fix (giving the PANEL WINDOW its OS focus) lives in
 * `window.ts` and cannot be reached from here; what this component owns is
 * which control inside that window gets the keyboard once it has one.
 */
describe('DwarfMessagePanel composer focus (#409)', () => {
  let attached: ReturnType<typeof panel> | undefined

  // AMENDED for #635: opened as the dock opens it, asking for the keyboard (`focusOnOpen`).
  function attachedPanel(props: Record<string, unknown> = {}) {
    attached = mount(DwarfMessagePanel, {
      attachTo: document.body,
      props: {
        dwarf: defaultDwarf({ textDelivery: 'terminal' }),
        focusOnOpen: true,
        ...props
      }
    })
    return attached
  }

  afterEach(() => {
    attached?.unmount()
    attached = undefined
  })

  it('focuses the composer the moment a selection mounts it, enabled', async () => {
    const wrapper = attachedPanel()
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.find('.dm-composer textarea').element)
  })

  // APPENDED for #635: the UI kit draws its states without opening them on anybody's behalf.
  it('takes no keyboard when its host did not open it on a selection', async () => {
    const wrapper = attachedPanel({ focusOnOpen: false })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).not.toBe(wrapper.find('.dm-composer textarea').element)
  })

  it('never focuses a composer the panel is already explaining as dead (#217)', async () => {
    const wrapper = attachedPanel({
      dwarf: defaultDwarf({ textDelivery: undefined })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).not.toBe(wrapper.find('.dm-composer textarea').element)
  })

  it('moves focus to the composer once a pending question clears', async () => {
    // AMENDED for #443 (was: the question's fields flat beside `questionCount: 1`).
    const pendingQuestion = {
      toolUseId: 'toolu_01',
      channel: 'held' as const,
      questions: [
        {
          question: 'Which database should the importer write to?',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }]
        }
      ]
    }
    const wrapper = attachedPanel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion })
    })
    await wrapper.vm.$nextTick()
    // Sanity: the card, not the composer, holds the slot while the ask is open.
    expect(wrapper.find('.dm-composer textarea').exists()).toBe(false)

    await wrapper.setProps({
      dwarf: defaultDwarf({ textDelivery: 'terminal' })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.find('.dm-composer textarea').element)
  })

  /*
   * ADDED for #635 (accessibility.md, Focus): an opened chat takes focus "the composer's field,
   * or the question card's first option while the dwarf waits on you", and when the focused
   * control goes away focus moves to the one that takes its place.
   */
  const asked = {
    toolUseId: 'toolu_01',
    channel: 'held' as const,
    questions: [
      { question: 'Which database?', multiSelect: false, options: [{ label: 'Postgres' }] }
    ]
  }

  it('gives the question card’s first option the keyboard when a selection opens it', async () => {
    const wrapper = attachedPanel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion: asked })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.find('.dm-qopt').element)
  })

  it('takes no keyboard for the card when its host did not open it on a selection', async () => {
    const wrapper = attachedPanel({
      focusOnOpen: false,
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion: asked })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).not.toBe(wrapper.find('.dm-qopt').element)
  })

  it('hands the keyboard from a focused composer to the card that replaces it', async () => {
    const wrapper = attachedPanel()
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.find('.dm-composer textarea').element)
    await wrapper.setProps({
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion: asked })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.find('.dm-qopt').element)
  })
})

/**
 * What each session type may honestly show. The resolution itself is
 * lib/message/conversation's; what is checked here is that the panel prints
 * the claim rather than dropping it, and never invents a bubble.
 */
describe('DwarfMessagePanel honesty', () => {
  it("says a held session's exchange is the one this panel watched happen", () => {
    expect(panel().find('.dm-msg__log').attributes('title')).toContain('holding this session')
  })

  it("says an observed session's messages are its latest activity", () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: {
        readable: true,
        messages: [{ role: 'assistant', text: 'Blasting', timestamp: 'now' }]
      }
    })
    expect(wrapper.find('.dm-msg__log').attributes('title')).toContain('Latest activity')
    expect(wrapper.findAll('.dm-bubble')).toHaveLength(1)
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
    expect(wrapper.findAll('.dm-bubble__text')).toHaveLength(0)
    expect(wrapper.find('.dm-msg__note').text()).toBe(NO_TRANSCRIPT_NOTE)
  })

  it('says it is still reading rather than that there is nothing', () => {
    const wrapper = panel({ dwarf: defaultDwarf(), feed: undefined })
    expect(wrapper.find('.dm-msg__note').text()).toBe(READING_NOTE)
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
/*
 * AMENDED for #635 throughout (was: an agent row drawn for the empty state, the dwarf's portrait
 * beside the note). The redesign draws no portrait beside the conversation's rows, and the
 * dwarf's own face is the header's; the empty state is the note line in the log. What #332 pinned
 * — silence says nothing about a dwarf's rank, whose face comes off `dwarf.role` — holds there.
 */
describe('DwarfMessagePanel empty portrait (#332)', () => {
  it("draws the dwarf's own portrait in the header above the empty-state note", () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: { readable: true, messages: [] }
    })
    expect(wrapper.find('.dm-msg__head .dm-portrait img').attributes('src')).toContain(
      'worker-face'
    )
    expect(wrapper.find('.dm-msg__log .dm-msg__note').text()).toBe(NOTHING_SAID_NOTE)
    expect(wrapper.find('.dm-bubble').exists()).toBe(false)
  })

  it('draws no empty row once the conversation has messages', () => {
    const wrapper = panel({ dwarf: defaultDwarf() })
    expect(wrapper.find('.dm-msg__note').exists()).toBe(false)
    expect(wrapper.findAll('.dm-bubble')).toHaveLength(HELD.length)
  })

  it.each([
    ['worker', 'worker-face'],
    ['worker2', 'worker2-face'],
    ['foreman', 'foreman-face']
  ] as const)("shows %s's own face, never the message's", (role, needle) => {
    const wrapper = panel({
      dwarf: defaultDwarf({ role }),
      feed: { readable: true, messages: [] }
    })
    expect(wrapper.find('.dm-msg__head .dm-portrait img').attributes('src')).toContain(needle)
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
    textDelivery: 'terminal'
  })

  it('says where the dialog is, above the composer', () => {
    const wrapper = panel({ dwarf: asked })
    expect(wrapper.find('.dm-msg__approval').text()).toContain(APPROVAL_AT_TERMINAL_NOTE)
  })

  it('jumps to that terminal through the console channel the panel already has', async () => {
    const wrapper = panel({ dwarf: asked })
    await wrapper.find('.dm-msg__approval .dm-btn').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })

  it('offers no answer of its own: the dialog is not this panel’s to decide', () => {
    const wrapper = panel({ dwarf: asked })
    // AMENDED for #635 (was: `.permission-card`): the design's one card.
    expect(wrapper.find('.dm-qcard').exists()).toBe(false)
    expect(wrapper.find('.dm-composer textarea').exists()).toBe(true)
  })

  it('says nothing for a dwarf that is merely waiting', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ status: 'waiting' }) })
    expect(wrapper.find('.dm-msg__approval').exists()).toBe(false)
  })

  it('stands aside for a prompt this panel can decide itself', () => {
    // A held session's card answers structurally (#246); a line pointing at a
    // terminal would send somebody away from the control that works.
    const wrapper = panel({
      dwarf: defaultDwarf({
        waitingReason: 'approval',

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
    expect(wrapper.find('.dm-msg__approval').exists()).toBe(false)
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

      pendingPermission: observedPermission,
      ...extra
    })
  }

  it('draws the card for a session it only watches, exactly as for one it holds', () => {
    const wrapper = panel({ dwarf: observed() })
    // AMENDED for #635 (was: `.permission-card` and its `.permission-input`): the request block.
    expect(wrapper.find('.dm-qcard').exists()).toBe(true)
    expect(wrapper.find('.dm-qcard__req').text()).toBe('Bash · pnpm test')
  })

  it('shows the card instead of the terminal sentence, never both', () => {
    const wrapper = panel({ dwarf: observed() })
    expect(wrapper.find('.dm-msg__approval').exists()).toBe(false)
  })

  it('keeps the sentence where the hook spoke and the content could not be named', () => {
    // The #251 case, unchanged: a dialog is open and the tail held no single
    // unresolved call to name it by, so the panel says where it is and stops.
    const wrapper = panel({
      dwarf: defaultDwarf({
        waitingReason: 'approval',
        textDelivery: 'terminal'
      })
    })
    expect(wrapper.find('.dm-msg__approval').text()).toContain(APPROVAL_AT_TERMINAL_NOTE)
    // AMENDED for #635 (was: `.permission-card`).
    expect(wrapper.find('.dm-qcard').exists()).toBe(false)
  })

  it('passes a decision made on the card up to whoever owns the channel', async () => {
    const wrapper = panel({ dwarf: observed() })
    // AMENDED for #635 (was: Enter on `.permission-card`): the card's Submit is its one send.
    await wrapper.findAll('.dm-qopt')[1]!.trigger('click')
    await wrapper.find('.dm-qcard__submit').trigger('click')
    expect(wrapper.emitted('decide')).toEqual([['deny']])
  })

  it('forwards the card’s jump, so a refused decision still reaches that console', async () => {
    const wrapper = panel({
      dwarf: observed(),
      answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
    })
    // AMENDED for #635 (was: `.answer-jump`): the walk's Jump to terminal.
    await wrapper.find('.dm-qcard__jump').trigger('click')
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
        capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null, attach: null }
      }),
      kickState: { phase: 'delivered', via: 'dismiss' }
    })
    const line = wrapper.find('.dm-composer__hint[role="status"]').text()
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
    return wrapper.findAll('.dm-bubble').at(-1)!
  }

  it("draws a sent message as the person's own bubble, after everything the transcript carried", () => {
    const wrapper = panel({ echoes: [echo()] })
    const rows = wrapper.findAll('.dm-bubble')
    // HELD is two rows; the echo is the third and last.
    expect(rows).toHaveLength(3)
    // AMENDED for #635 (was: the `.is-user` row and the portrait's "You" alt): the person's own
    // bubble, named "You".
    expect(rows.at(-1)!.classes()).toContain('dm-bubble--user')
    expect(rows.at(-1)!.find('.dm-bubble__text').text()).toBe('dig deeper')
    expect(rows.at(-1)!.attributes('aria-label')).toBe('You')
  })

  it('carries the pending glyph while the message is still in flight', () => {
    const wrapper = panel({ echoes: [echo({ state: { phase: 'sending' } })] })
    const marker = lastMessageRow(wrapper).find('.dm-bubble__mark')
    expect(marker.text()).toBe(sendMarker({ phase: 'sending' })!.glyph)
    // AMENDED for #635 (was: the `is-sending` class): the design's mark name.
    expect(marker.attributes('data-mark')).toBe('pending')
  })

  it("carries one tick when the message reached the session's queue, in the verdict's own words", () => {
    const state: DwarfSendState = { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    const wrapper = panel({ echoes: [echo({ state })] })
    const marker = lastMessageRow(wrapper).find('.dm-bubble__mark')
    expect(marker.text()).toBe('✓')
    expect(marker.attributes('title')).toBe(sendMarker(state)!.title)
    // Handed over, never a claimed reaction — the whole point of #21.
    expect(marker.attributes('title')).not.toContain('reacted')
  })

  it('says so on the tick when the watch closed without seeing a reaction', () => {
    const state: DwarfSendState = { phase: 'delivered', via: 'terminal', awaitingReaction: false }
    const wrapper = panel({ echoes: [echo({ state })] })
    expect(lastMessageRow(wrapper).find('.dm-bubble__mark').attributes('title')).toBe(
      sendMarker(state)!.title
    )
  })

  it('carries two ticks only once the session was seen acting', () => {
    const state: DwarfSendState = { phase: 'reacted', via: 'terminal' }
    const wrapper = panel({ echoes: [echo({ state })] })
    const marker = lastMessageRow(wrapper).find('.dm-bubble__mark')
    expect(marker.text()).toBe('✓✓')
    expect(marker.attributes('title')).toBe(sendMarker(state)!.title)
    // AMENDED for #635 (was: the `is-reacted` class): the design's mark name.
    expect(marker.attributes('data-mark')).toBe('reacted')
  })

  it('carries a ✕ with the reason on hover, and keeps the words readable', () => {
    const state: DwarfSendState = { phase: 'failed', error: 'The relay never started.' }
    const wrapper = panel({ echoes: [echo({ state })] })
    const row = lastMessageRow(wrapper)
    // AMENDED for #635 (was: '✕'): spelled as the design writes it.
    expect(row.find('.dm-bubble__mark').text()).toBe('✕ not delivered')
    expect(row.find('.dm-bubble__mark').attributes('title')).toBe('The relay never started.')
    // The bubble is kept rather than removed: it is the only copy of what the
    // person typed, and it is about to be sent again.
    expect(row.find('.dm-bubble__text').text()).toBe('dig deeper')
  })

  it('falls back to the verdict’s own sentence when the channel gave no reason', () => {
    const state: DwarfSendState = { phase: 'failed' }
    const wrapper = panel({ echoes: [echo({ state })] })
    expect(lastMessageRow(wrapper).find('.dm-bubble__mark').attributes('title')).toBe(
      sendMarker(state)!.title
    )
  })

  // AMENDED for #635 (decision log, Failed delivery; was: 'offers Send again on a failed
  // message, and on no other', with the one Send again button): Retry, then Copy.
  it('offers Retry and Copy on a failed message, and on no other', () => {
    const failed = panel({ echoes: [echo({ state: { phase: 'failed', error: 'nope' } })] })
    expect(failed.findAll('.dm-bubble__actions .dm-btn').map((b) => b.text())).toEqual([
      RETRY_LABEL,
      COPY_LABEL
    ])

    for (const phase of ['sending', 'delivered', 'reacted'] as const) {
      const other = panel({ echoes: [echo({ state: { phase } })] })
      expect(other.find('.dm-bubble__actions .dm-btn').exists()).toBe(false)
    }
  })

  /*
   * #439. A relay courier killed by its own timeout is drawn as 'delivered'
   * with `unconfirmed: true` (see useDwarfMessaging.ts) rather than 'failed',
   * precisely so this gate excludes it: offering `Send again` here would risk
   * handing the same words to the session a second time.
   */
  it('offers no Send again on an unconfirmed relay, and draws the honest tick instead', () => {
    const state: DwarfSendState = {
      phase: 'delivered',
      via: 'claude-relay',
      unconfirmed: true,
      error: 'The relay did not confirm in time; the message may have arrived.'
    }
    const wrapper = panel({ echoes: [echo({ state })] })
    const row = lastMessageRow(wrapper)
    expect(row.find('.dm-bubble__mark').text()).toBe('✓')
    expect(row.find('.dm-bubble__mark').attributes('title')).toBe(sendMarker(state)!.title)
    expect(row.find('.dm-bubble__mark').attributes('title')).toContain('did not confirm in time')
    expect(wrapper.find('.dm-bubble__actions .dm-btn').exists()).toBe(false)
  })

  it("emits the failed message's own id, so a retry cannot land on another bubble", async () => {
    const wrapper = panel({
      echoes: [
        echo({ id: 'e1', text: 'first', state: { phase: 'delivered' } }),
        echo({ id: 'e2', text: 'second', state: { phase: 'failed', error: 'nope' } })
      ]
    })
    await wrapper.find('.dm-bubble__actions .dm-btn').trigger('click')
    // AMENDED for #635 (was: the `send-again` event): the design's Retry, by the same id.
    expect(wrapper.emitted('retry')).toEqual([['e2']])
  })

  /*
   * #635, decision log, Failed delivery — APPENDED. Copy copies the words of the message whose
   * button was pressed, exactly as written; the panel reports them and its host owns the
   * clipboard and the toast.
   */
  it("emits the failed message's own words for Copy", async () => {
    const wrapper = panel({
      echoes: [
        echo({ id: 'e1', text: 'first', state: { phase: 'delivered' } }),
        echo({ id: 'e2', text: 'second\nline', state: { phase: 'failed', error: 'nope' } })
      ]
    })
    await wrapper.findAll('.dm-bubble__actions .dm-btn')[1]!.trigger('click')
    expect(wrapper.emitted('copy')).toEqual([['second\nline']])
  })

  it('keeps one bubble for a failed message while its retry is on its way', () => {
    // The echo is walked back in place by the store; the panel draws what it holds, once.
    const wrapper = panel({ echoes: [echo({ id: 'e2', state: { phase: 'sending' } })] })
    expect(wrapper.findAll('.dm-bubble--user .dm-bubble__mark').map((m) => m.text())).toContain('…')
    expect(wrapper.find('.dm-bubble__actions').exists()).toBe(false)
  })

  /*
   * AMENDED for #635 (MESSAGE-QUESTIONS 4, decision log, Copy alone on a closed session; was:
   * 'offers no retry for a session that can no longer be written to', asserting no button in the
   * group at all). Retry still goes — sending again would promise a delivery the capability model
   * has already refused — but Copy stays alone in the group, because it is the one action that
   * still helps. Both ways a session stops taking text: its route went away, or it ended.
   */
  it.each([
    ['its delivery route went away', { textDelivery: undefined }],
    ['it ended', { status: 'leaving' as const }]
  ])('keeps Copy alone on a failed message once %s', async (_why, overrides) => {
    const wrapper = panel({
      dwarf: defaultDwarf(overrides),
      echoes: [echo({ id: 'e2', text: 'second', state: { phase: 'failed', error: 'nope' } })]
    })
    const group = wrapper.find('.dm-bubble__actions')
    expect(group.attributes('aria-label')).toBe('Not delivered')
    const buttons = group.findAll('.dm-btn')
    expect(buttons.map((b) => b.text())).toEqual([COPY_LABEL])
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('copy')).toEqual([['second']])
    expect(wrapper.emitted('retry')).toBeUndefined()
  })

  /*
   * AMENDED for #635 (was: 'draws no marker at all against a row read off the transcript'). The
   * redesign marks the person's words in the transcript too, by the history's own reading of the
   * record (historyMarks, PANEL-QUESTIONS 16): a prompt the transcript holds was handed to the
   * session, so it is at least ✓, and ✓✓ only once the session was seen acting after it. HELD's
   * prompt is followed by the dwarf's reply, and the reply itself carries no mark.
   */
  it('marks a transcript prompt by the record, and the dwarf’s own words not at all', () => {
    const wrapper = panel()
    const marks = wrapper.findAll('.dm-bubble__mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.attributes('data-mark')).toBe('reacted')
    expect(wrapper.findAll('.dm-bubble')[1]!.find('.dm-bubble__mark').exists()).toBe(false)
  })

  it('marks a prompt nothing has answered yet as handed over, never as reacted', () => {
    const wrapper = panel({ feed: heldFeed([HELD[0]!]) })
    expect(wrapper.find('.dm-bubble__mark').attributes('data-mark')).toBe('delivered')
  })

  it('never folds an echo into a run of tool calls, because it is not the agent working', () => {
    // #294 groups consecutive activity rows and labels an open run
    // "Working...". A message somebody typed must not close that run.
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal' }),
      feed: heldFeed([
        { role: 'assistant', text: 'Ran pnpm test', timestamp: 't0' },
        { role: 'assistant', text: 'Edited src/foo.ts', timestamp: 't1' }
      ]),
      echoes: [echo()]
    })
    expect(wrapper.find('.dm-bubble--user .dm-bubble__text').text()).toBe('dig deeper')
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
      get: () => list.querySelectorAll('.dm-bubble').length * perMessage
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
    const list = wrapper.find('.dm-msg__log').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 5 // 80 - 30 - 5 = 45, well past the tolerance: scrolled up.

    await wrapper.setProps({ echoes: [echo('e1', { phase: 'sending' })] })
    await wrapper.vm.$nextTick()
    // AMENDED for #635: the scroll lands one frame after the row, as the design's panel does it.
    await nextFrame()

    expect(list.scrollTop).toBe(120) // 3 rows * 40, the new bottom.
  })

  it('leaves the list exactly where it was when only a tick changed', async () => {
    const wrapper = panel({ echoes: [echo('e1', { phase: 'sending' })] })
    const list = wrapper.find('.dm-msg__log').element
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
      dwarf: defaultDwarf(),
      feed: heldFeed([{ role, text, timestamp: '2026-09-09T09:00:00.000Z' }])
    })
  }

  it("renders an agent's Markdown as real elements, not as delimiters", () => {
    const wrapper = withReply(REPLY)
    expect(wrapper.find('.dm-bubble__text strong').text()).toBe('Done')
    expect(wrapper.findAll('.dm-bubble__text ul > li')).toHaveLength(2)
    expect(wrapper.find('.dm-bubble__text code').text()).toBe('pnpm test')
    expect(wrapper.find('.dm-bubble__text').text()).not.toContain('**')
  })

  /*
   * Symmetric, by maintainer ruling: the issue left the person's own bubbles
   * open, and half a panel that renders formatting is worse than either whole.
   */
  it("renders the person's own transcript rows the same way", () => {
    expect(
      withReply('**Done**', 'user').find('.dm-bubble--user .dm-bubble__text strong').text()
    ).toBe('Done')
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
    expect(wrapper.findAll('.dm-bubble').at(-1)!.find('.dm-bubble__text strong').text()).toBe('now')
  })

  it('leaves plain text exactly as it was, line breaks included', () => {
    expect(withReply('Found the seam.\nTwo lines.').find('.dm-bubble__text').text()).toBe(
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
      dwarf: defaultDwarf(),
      feed: heldFeed([
        {
          role: 'assistant',
          text: 'Edited src/_internal_/index.ts',
          timestamp: 't0',
          activity: { kind: 'edit', target: 'src/_internal_/index.ts' }
        }
      ])
    })
    await wrapper.find('.dm-activity__toggle').trigger('click')
    const line = wrapper.find('.dm-activity__list li')
    expect(line.text()).toBe('Edited src/_internal_/index.ts')
    expect(line.find('em').exists()).toBe(false)
  })

  /*
   * The panel reports the press and opens nothing, exactly as it does for an
   * activity line's own path (#279): opening happens in MAIN.
   */
  it("reports a pressed link's address and opens nothing itself", async () => {
    const wrapper = withReply('see [the issue](https://example.test/347)')
    await wrapper.find('.dm-bubble__text .markdown-link').trigger('click')
    expect(wrapper.emitted('open-link')).toEqual([['https://example.test/347']])
  })
})

/**
 * Paging back through the conversation (#364).
 *
 * The panel's part of it is two gestures and one sentence: it reports that the
 * reader has reached the top of what it holds, it keeps the viewport still when
 * a page lands above the fold, and it says whatever it was given to say about
 * the reading. WHICH page is asked for and what comes back is
 * MessagePanelWindow's, exactly as the feed itself already is.
 */
describe('DwarfMessagePanel paging (#364)', () => {
  const OBSERVED = [
    { role: 'assistant' as const, text: 'Halfway down the shaft.', timestamp: 't2' },
    { role: 'assistant' as const, text: 'Seam exhausted.', timestamp: 't3' }
  ]

  const OLDER = [
    { role: 'assistant' as const, text: 'Starting the shaft.', timestamp: 't0' },
    { role: 'assistant' as const, text: 'Through the topsoil.', timestamp: 't1' }
  ]

  /**
   * jsdom lays nothing out, so the list's own height has to grow with the rows
   * Vue patches in — the same fake the #195 block uses, and for the same
   * reason: a static value would report the SAME height before and after the
   * patch, which is exactly the difference the prepend is measured by.
   */
  function growingScrollHeight(list: Element, perMessage = 40): void {
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => list.querySelectorAll('.dm-bubble').length * perMessage
    })
  }

  function fixedClientHeight(list: Element, value: number): void {
    Object.defineProperty(list, 'clientHeight', { value, configurable: true })
  }

  async function observedPanel() {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: { readable: true, messages: OBSERVED }
    })
    const list = wrapper.find('.dm-msg__log').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    return { wrapper, list }
  }

  it('reports that the reader reached the top of what it holds', async () => {
    const { wrapper, list } = await observedPanel()

    list.scrollTop = 0
    await wrapper.find('.dm-msg__log').trigger('scroll')

    expect(wrapper.emitted('page-back')).toHaveLength(1)
  })

  it('reports it from within the tolerance too, so a flick that stopped short still asks', async () => {
    const { wrapper, list } = await observedPanel()

    list.scrollTop = TOP_OF_LIST_TOLERANCE_PX
    await wrapper.find('.dm-msg__log').trigger('scroll')

    expect(wrapper.emitted('page-back')).toHaveLength(1)
  })

  it('reports nothing on an ordinary scroll, so reading costs no reads', async () => {
    const { wrapper, list } = await observedPanel()

    list.scrollTop = 40
    await wrapper.find('.dm-msg__log').trigger('scroll')

    expect(wrapper.emitted('page-back')).toBeUndefined()
  })

  it('keeps the row the reader was on exactly where it was when a page lands above it', async () => {
    const { wrapper, list } = await observedPanel()
    list.scrollTop = 5 // 80 - 30 - 5 = 45: scrolled up, well past the tolerance.

    await wrapper.setProps({ feed: { readable: true, messages: [...OLDER, ...OBSERVED] } })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // Two rows, 40 each, landed in front of everything on screen. Leaving
    // scrollTop at 5 would slide the sentence being read 80px down the panel.
    expect(list.scrollTop).toBe(85)
  })

  it('leaves the viewport alone when the page it was given was empty', async () => {
    const { wrapper, list } = await observedPanel()
    list.scrollTop = 5

    await wrapper.setProps({ feed: { readable: true, messages: OBSERVED } })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(5)
  })

  it('says the line it was given in front of the note it already carries', () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: { readable: true, messages: OBSERVED },
      pagingNote: CONVERSATION_START_NOTE
    })

    // The panel's one note row already says what the messages ARE; where the
    // conversation begins is the same kind of statement about the same rows, so
    // it is prefixed the way an ended session's is rather than replacing it.
    expect(wrapper.find('.dm-msg__log').attributes('title')).toBe(
      `${CONVERSATION_START_NOTE} ${OBSERVED_NOTE}`
    )
  })

  it('says only its own note when nothing has been asked for', () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: { readable: true, messages: OBSERVED }
    })
    expect(wrapper.find('.dm-msg__log').attributes('title')).toBe(OBSERVED_NOTE)
  })

  it('carries the whole sentence into the list’s own label, for a reader who cannot see it', () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: { readable: true, messages: OBSERVED },
      pagingNote: READING_OLDER_NOTE
    })
    // AMENDED for #635 (was: the list's own aria-label): the log is named "Conversation with
    // <name>" as the design names it, and the whole sentence is its title — its accessible
    // description — and the note line it draws while paging.
    expect(wrapper.find('.dm-msg__log').attributes('aria-label')).toBe(
      'Conversation with Sample Worker'
    )
    expect(wrapper.find('.dm-msg__log').attributes('title')).toBe(
      `${READING_OLDER_NOTE} ${OBSERVED_NOTE}`
    )
    expect(wrapper.find('.dm-msg__log .dm-msg__note').text()).toBe(
      `${READING_OLDER_NOTE} ${OBSERVED_NOTE}`
    )
  })
})

/*
 * Attachments in the composer (#408), against the design's 2026-09-16
 * amendment: two ways in and one model, chips above the input, the limits
 * stated where they bite, Enter sending text or files or both, and the control
 * disabled with a reason on a channel that cannot carry one.
 *
 * `window.api` is faked per test rather than through a shared harness, because
 * what each of these is about is which of the three calls the panel made.
 */
const CAN_ATTACH = {
  sendText: 'terminal' as const,
  cancel: 'terminal' as const,
  adjustEffort: null,
  attach: 'terminal' as const
}
const CANNOT_ATTACH = {
  sendText: 'claude-relay' as const,
  cancel: 'claude-relay' as const,
  adjustEffort: null,
  attach: null
}

const SHOT: DwarfAttachment = {
  path: 'C:\\work\\red.png',
  name: 'red.png',
  kind: 'image',
  bytes: 900
}
const NOTES: DwarfAttachment = {
  path: 'C:\\work\\notes.txt',
  name: 'notes.txt',
  kind: 'file',
  bytes: 120
}

/** Installs a fake bridge and answers `describe` with the given picks, in order. */
function fakeApi(picks: DwarfAttachmentPick[][] = [], chosen: string[] = []) {
  const describeDwarfAttachments = vi
    .fn()
    .mockImplementation(() => Promise.resolve(picks.shift() ?? []))
  const api = {
    pathForDroppedFile: vi.fn((file: File) => `C:\\work\\${file.name}`),
    chooseDwarfAttachments: vi.fn().mockResolvedValue(chosen),
    describeDwarfAttachments
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

/** A drop event carrying files, as a browser delivers one. */
function dropEvent(names: string[]) {
  return { dataTransfer: { files: names.map((name) => new File(['x'], name)) } }
}

function attachPanel(props: Record<string, unknown> = {}) {
  return panel({
    dwarf: defaultDwarf({ textDelivery: 'terminal', capabilities: CAN_ATTACH }),
    ...props
  })
}

describe('DwarfMessagePanel attachments (#408)', () => {
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it.each(['dragover', 'drop'])(
    'never lets a %s navigate, which would replace the whole window',
    async (type) => {
      // The regression the issue asks for by name, and BOTH events matter: a
      // browser only opens the dropped file if the dragover was not cancelled
      // too. A file dropped on a page that may navigate REPLACES it, and this
      // window has no way back.
      //
      // Dispatched rather than `trigger`ed, because the claim is about the real
      // event: a mock `preventDefault` passed as a property is not the method
      // Vue's `.prevent` calls.
      fakeApi([[{ path: SHOT.path, attachment: SHOT }]])
      const wrapper = attachPanel()
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dropEvent(['red.png']).dataTransfer })

      wrapper.find('.dm-composer').element.dispatchEvent(event)
      await flushPromises()
      expect(event.defaultPrevented).toBe(true)
    }
  )

  it('adds a chip for every dropped file, through main', async () => {
    const api = fakeApi([[{ path: SHOT.path, attachment: SHOT }]])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['red.png']))
    await flushPromises()

    expect(api.describeDwarfAttachments).toHaveBeenCalledWith([SHOT.path])
    expect(wrapper.findAll('.dm-composer__files .dm-composer__file')).toHaveLength(1)
    expect(wrapper.find('.dm-composer__files .dm-composer__file').text()).toContain('red.png')
  })

  it('adds the same way through the picker, which is the point of one model', async () => {
    const api = fakeApi([[{ path: NOTES.path, attachment: NOTES }]], [NOTES.path])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer__attach').trigger('click')
    await flushPromises()

    expect(api.chooseDwarfAttachments).toHaveBeenCalled()
    expect(api.describeDwarfAttachments).toHaveBeenCalledWith([NOTES.path])
    expect(wrapper.findAll('.dm-composer__files .dm-composer__file')).toHaveLength(1)
  })

  /*
   * REMOVED for #635, stated rather than passing unseen: 'draws an image chip from a preview main
   * rendered, never from a path' and 'draws a glyph rather than a preview for a file that is not
   * an image'. The redesign draws an attached file as a pill with the attach icon and its name,
   * for every kind of file alike (components.md, Composer, As built), so no preview is drawn and
   * none is loaded from anywhere; the guarantee that nothing is read off the disk holds by there
   * being no image at all.
   *
   * APPENDED in their place: the pill itself.
   */
  it('draws a dropped file as the design’s pill: the attach icon and its name', async () => {
    fakeApi([[{ path: NOTES.path, attachment: NOTES }]])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['notes.txt']))
    await flushPromises()

    const pill = wrapper.find('.dm-composer__files .dm-composer__file')
    expect(pill.text()).toContain(NOTES.name)
    expect(pill.find('img').exists()).toBe(false)
    expect(pill.find('button').attributes('aria-label')).toBe(`Remove ${NOTES.name}`)
  })

  it('removes a chip when its remove control is pressed, and sends without it', async () => {
    fakeApi([[{ path: SHOT.path, attachment: SHOT }]])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['red.png']))
    await flushPromises()
    await wrapper.find('.dm-composer__file button').trigger('click')

    expect(wrapper.findAll('.dm-composer__files .dm-composer__file')).toHaveLength(0)
    await wrapper.find('.dm-composer textarea').setValue('just words')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([[{ text: 'just words', pressEnter: true }]])
  })

  it('sends the words and the files together', async () => {
    fakeApi([[{ path: SHOT.path, attachment: SHOT }]])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['red.png']))
    await flushPromises()
    await wrapper.find('.dm-composer textarea').setValue('look at this')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')).toEqual([
      [{ text: 'look at this', pressEnter: true, attachments: [SHOT] }]
    ])
  })

  it('sends files with no words at all, which is a whole message', async () => {
    fakeApi([[{ path: SHOT.path, attachment: SHOT }]])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['red.png']))
    await flushPromises()
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')).toEqual([[{ text: '', pressEnter: true, attachments: [SHOT] }]])
  })

  it('still sends nothing when there are neither words nor files', async () => {
    fakeApi()
    const wrapper = attachPanel()
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('clears the chips once the message has left, releasing what they held', async () => {
    // The issue's release rule. Nothing here is an object URL — the preview is
    // a data URL main rendered — so "released" means the component stops
    // holding it, and this is what says it does.
    fakeApi([[{ path: SHOT.path, attachment: SHOT, thumbnail: 'data:image/png;base64,AAA' }]])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['red.png']))
    await flushPromises()
    expect(wrapper.findAll('.dm-composer__files .dm-composer__file')).toHaveLength(1)

    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.findAll('.dm-composer__files .dm-composer__file')).toHaveLength(0)
  })

  it('names the limit that refused a file, in the alert row', async () => {
    fakeApi([[{ path: 'C:\\work\\src', refusal: 'directory' }]])
    const wrapper = attachPanel()

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['src']))
    await flushPromises()

    expect(wrapper.find('.dm-composer__hint[role="alert"]').text()).toBe(
      refusalSentence('directory', 'src')
    )
    expect(wrapper.findAll('.dm-composer__files .dm-composer__file')).toHaveLength(0)
  })

  it('disables the control with its reason on a channel that carries text only', () => {
    fakeApi()
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'claude-relay', capabilities: CANNOT_ATTACH })
    })
    const control = wrapper.find('.dm-composer__attach')
    expect(control.attributes('disabled')).toBeDefined()
    expect(control.attributes('title')).toBe(NO_ATTACH_CHANNEL_HINT)
  })

  it('refuses a drop on that same channel with the same sentence, and asks main nothing', async () => {
    const api = fakeApi()
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'claude-relay', capabilities: CANNOT_ATTACH })
    })

    await wrapper.find('.dm-composer').trigger('drop', dropEvent(['red.png']))
    await flushPromises()

    expect(api.describeDwarfAttachments).not.toHaveBeenCalled()
    expect(wrapper.find('.dm-composer__hint[role="alert"]').text()).toBe(NO_ATTACH_CHANNEL_HINT)
    expect(wrapper.findAll('.dm-composer__files .dm-composer__file')).toHaveLength(0)
  })

  it('marks the composer while a drag is over it, and unmarks it on leave', async () => {
    fakeApi()
    const wrapper = attachPanel()
    await wrapper.find('.dm-composer').trigger('dragover')
    expect(wrapper.find('.dm-composer').classes()).toContain('is-dragging')
    await wrapper.find('.dm-composer').trigger('dragleave')
    expect(wrapper.find('.dm-composer').classes()).not.toContain('is-dragging')
  })

  it('shows what a sent message carried, as chips with no remove control', () => {
    fakeApi()
    const echo: MessageEcho = {
      id: 'echo-1',
      text: 'look at this',
      sentAt: 1,
      state: { phase: 'delivered' }
    }
    const wrapper = attachPanel({ echoes: [echo], echoAttachments: { 'echo-1': [SHOT] } })

    expect(wrapper.findAll('.dm-msg__files .dm-composer__file')).toHaveLength(1)
    expect(wrapper.find('.dm-msg__files .dm-composer__file').text()).toContain('red.png')
    expect(wrapper.find('.dm-msg__files .dm-composer__file button').exists()).toBe(false)
  })

  it('puts the caret back in the composer after a pick, so #409 still holds', async () => {
    // The OS dialog takes the focus away; the person's next act is typing.
    fakeApi([[{ path: SHOT.path, attachment: SHOT }]], [SHOT.path])
    const wrapper = attachPanel()
    const input = wrapper.find('.dm-composer textarea').element as HTMLTextAreaElement
    const focus = vi.fn()
    input.focus = focus

    await wrapper.find('.dm-composer__attach').trigger('click')
    await flushPromises()
    expect(focus).toHaveBeenCalled()
  })
})

/* --- The Codex resume channel (#450) — appended ------------------------------ */

/**
 * The report #450 is: a Codex session launched from this panel took its opening
 * prompt and went mute, composer disabled, with an honest sentence saying so.
 * The sentence was true and the launch shape it described is not the only way
 * in — `codex exec resume <id> -` continues the very same thread — so what the
 * person sees here is the composer, and no refusal row at all.
 */
describe('DwarfMessagePanel on a resumed Codex thread (#450)', () => {
  function resumed() {
    return panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        // Still true of the session's shape (#231), and no longer a refusal.
        oneShot: true,
        textDelivery: 'codex-exec-resume',
        capabilities: {
          sendText: 'codex-exec-resume',
          cancel: null,
          adjustEffort: null,
          attach: null
        }
      })
    })
  }

  it('leaves the composer live, with no refusal row to explain', () => {
    const wrapper = resumed()
    expect(wrapper.find('.dm-composer textarea').attributes('disabled')).toBeUndefined()
    // AMENDED for #635 (was: no `.panel-refusal` row): the hint is the keyboard's own.
    expect(wrapper.find('.dm-composer__hint').text()).toBe(COMPOSER_HINT_TEXT)
  })

  it('names what the message will actually do, on the box itself', () => {
    expect(resumed().find('.dm-composer .dm-field').attributes('title')).toContain('next turn')
  })
})
/* --- end of the #450 block --------------------------------------------------- */

/* --- Turn outcome (#510) — one block, appended ---------------------------- */
describe('DwarfMessagePanel turn outcome (#510)', () => {
  /*
   * AMENDED for #635 (was: 'says nothing when the dwarf carries no last turn'). The redesign draws
   * the outcome line in every state, with its status square (screens/message.md, As built); with
   * no turn to speak of it says the state word the prototype prints, and still invents no turn.
   */
  it('says only the state word when the dwarf carries no last turn', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ lastTurn: undefined }) })
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Working')
    expect(wrapper.find('.dm-msg__outcome').text()).not.toContain('Last turn')
  })

  /*
   * AMENDED for #635 (the outcome line ruling, MESSAGE-QUESTIONS 7; was: "says a concluded turn
   * ended and carries its own words", "Last turn concluded" with the turn's text, on a working
   * dwarf). A finished turn now reads "Turn finished" and how long ago it ended, on a dwarf at rest,
   * and never the turn's own closing words, which the conversation shows.
   *
   * REMOVED for #635, stated rather than passing unseen: "says the wire itself trimmed a concluded
   * turn, only when it did". The line no longer carries the turn's words, so it has nothing to
   * call trimmed; lib/message/panelChrome.test.ts pins that the words stay off the line.
   */
  it('says a concluded turn finished and how long ago, never its own words', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        lastTurn: { kind: 'concluded', text: 'Found the seam.', endedAt: Date.now() - 300_000 }
      })
    })
    const line = wrapper.find('.dm-msg__outcome')
    expect(line.text()).toBe('Turn finished · idle for 5m')
    expect(line.attributes('data-status')).toBe('asleep')
  })

  // AMENDED for #635 (MESSAGE-QUESTIONS 7; was: "naming the provider's own word" in the title, on
  // a working dwarf): the ruling's word on a dwarf at rest, without the provider's code.
  it('says a capped turn stopped at a limit, and shows no text', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        lastTurn: {
          kind: 'capped',
          // A capped turn carries no text on the real wire; set here anyway to
          // prove the panel never draws one for this kind even if it arrived.
          text: 'should never be drawn',
          detail: 'error_max_turns',
          endedAt: 1_700_000_000_000
        }
      })
    })
    const line = wrapper.find('.dm-msg__outcome')
    // AMENDED for #635 (was: 'Last turn stopped at a limit (error_max_turns)'). AMENDED for #635
    // (MESSAGE-QUESTIONS 10; was: /…idle for \d+[smh]$/): a turn that ended years ago reads in days.
    expect(line.text()).toMatch(/^Turn stopped at a limit · idle for \d+[smhd]$/)
    expect(line.text()).not.toContain('should never be drawn')
  })

  // AMENDED for #635 (MESSAGE-QUESTIONS 7; was: "Last turn failed (error_during_execution)" on a
  // working dwarf, and "naming the provider's own word" in the title): the ruling's word alone.
  it('says an errored turn failed, and shows no text', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        lastTurn: {
          kind: 'errored',
          detail: 'error_during_execution',
          endedAt: Date.now() - 300_000
        }
      })
    })
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Turn failed · idle for 5m')
  })

  // AMENDED for #635 (MESSAGE-QUESTIONS 7; was: "Last turn was interrupted (CANCELED)" on a
  // working dwarf, and "naming the provider's own word" in the title): the ruling's word alone.
  it('says an interrupted turn was interrupted, and shows no text', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        lastTurn: { kind: 'interrupted', detail: 'CANCELED', endedAt: Date.now() - 300_000 }
      })
    })
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Turn interrupted · idle for 5m')
  })

  it('never claims a delivery or a reaction — only how the turn itself ended', () => {
    // The invariant AGENTS.md states by name: delivered and reacted are their
    // own facts, drawn by sendStatusLine/kickStatusLine in .panel-status. This
    // row must never borrow their words.
    const wrapper = panel({
      dwarf: defaultDwarf({
        lastTurn: { kind: 'concluded', text: 'Found the seam.', endedAt: 1_700_000_000_000 }
      })
    })
    const line = wrapper.find('.dm-msg__outcome').text()
    expect(line).not.toContain('delivered')
    expect(line).not.toContain('reacted')
    expect(line).not.toContain('Handed over')
  })

  it('keeps the composer live and reachable once the line appears — no jump that hides it', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        lastTurn: { kind: 'concluded', text: 'Found the seam.', endedAt: 1_700_000_000_000 }
      })
    })
    expect(wrapper.find('.dm-composer').exists()).toBe(true)
    expect(wrapper.find('.dm-composer textarea').exists()).toBe(true)
  })
})
/* --- end of the #510 block --------------------------------------------------- */

/**
 * The shared entrance (#566 T4b, "falta la animación de desplegar los
 * mensajes del MessagePanel"): a message row arriving after the reader was
 * already looking at this conversation gets `presence.ts`'s own
 * `fadeVariants`, opacity only — a `y` offset would shift `scrollHeight`
 * mid-animation in a real layout the way it never can here (jsdom performs
 * no layout at all), and the scroll-to-bottom rule above already has to land
 * exactly on the newest row once the entrance settles. An already-open
 * conversation must not animate its own history on mount — the shape a
 * dwarf switch's own `:key` remount (`MessagePanelWindow.vue`) takes, a
 * fresh component instance seeing its history for the first time, so
 * nothing further is needed here to prove that cut beyond an ordinary
 * mount. A page paged in ahead of the reader (#430) must not animate
 * either. `lib/message/entryArrival`'s `tailArrivals` is the one fact this
 * relies on to tell a genuine arrival apart from both.
 */
/*
 * AMENDED for #635 throughout this block (was: every row a `motion.article` under an
 * `AnimatePresence`, entering with presence.ts's fadeVariants). The redesign's bubble enters
 * with its own `.dm-bubble.is-new` pop-in (motion.md, dm-pop-in), a CSS animation of transform
 * and opacity; the rule the block pins is unchanged — a genuine arrival animates, and neither an
 * ordinary mount nor a page paged in ahead of the reader does. REMOVED with the motion
 * components, stated rather than passing unseen: 'wraps the conversation in AnimatePresence,
 * skipping the initial mount stagger' and 'carries the shared fadeVariants on every message row'.
 */
describe('DwarfMessagePanel list motion (#566 T4b)', () => {
  const isNew = (wrapper: ReturnType<typeof panel>) =>
    wrapper.findAll('.dm-bubble').map((row) => row.classes().includes('is-new'))

  it('does not animate any row on an ordinary mount — an already-open conversation', () => {
    // HELD carries two rows.
    expect(isNew(panel())).toEqual([false, false])
  })

  it('animates a message that arrives after mount, and leaves the rows already on screen alone', async () => {
    const wrapper = panel()
    await wrapper.setProps({
      feed: heldFeed([...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }])
    })
    const rows = wrapper.findAll('.dm-bubble')
    expect(rows).toHaveLength(3)
    expect(rows.at(-1)!.text()).toContain('Seam exhausted.')
    expect(isNew(wrapper)).toEqual([false, false, true])
  })

  it('does not animate an older page paged in ahead of the reader (#430)', async () => {
    const OBSERVED = [
      { role: 'assistant' as const, text: 'Halfway down the shaft.', timestamp: 't2' },
      { role: 'assistant' as const, text: 'Seam exhausted.', timestamp: 't3' }
    ]
    const OLDER = [
      { role: 'assistant' as const, text: 'Starting the shaft.', timestamp: 't0' },
      { role: 'assistant' as const, text: 'Through the topsoil.', timestamp: 't1' }
    ]
    const wrapper = panel({ dwarf: defaultDwarf(), feed: { readable: true, messages: OBSERVED } })

    await wrapper.setProps({ feed: { readable: true, messages: [...OLDER, ...OBSERVED] } })

    expect(isNew(wrapper)).toEqual([false, false, false, false])
  })
})

/**
 * The list's entrance is not the only motion a message row carries — an
 * echo reconciling into its transcript row (#309) is a real removal from
 * `entries`: `reconcileEchoes` (`lib/message/echo.ts`) splices the matched
 * echo out upstream, in `useDwarfMessaging`, so by the time the prop reaches
 * this component the echo is simply gone from `echoes` and the transcript's
 * own row has taken its place. The `exit` variant this carries (pinned above)
 * is exercised here structurally — the row disappears — the same way
 * `MinesPanel.test.ts`'s own #566 T3 block proved `TierInfoModal`'s close for
 * a single child rather than the fade itself: jsdom's lack of layout latches
 * `AnimationFeature`'s exit state at mount (`presence.test.ts`'s module
 * header has the full trace), so the real exit call resolves on the spot
 * rather than holding. Real Electron confirmation is T5's job, same as T3's.
 */
describe('DwarfMessagePanel echo exit (#566 T4b)', () => {
  it('removes the echo row once the transcript accounts for it', async () => {
    const wrapper = panel({
      echoes: [{ id: 'e1', text: 'dig deeper', sentAt: 0, state: { phase: 'sending' } }]
    })
    expect(wrapper.findAll('.dm-bubble')).toHaveLength(3) // HELD (2) + the echo.

    await wrapper.setProps({
      feed: heldFeed([
        ...HELD,
        { role: 'user', text: 'dig deeper', timestamp: '2026-09-03T09:00:02.000Z' }
      ]),
      echoes: []
    })

    const rows = wrapper.findAll('.dm-bubble')
    expect(rows).toHaveLength(3)
    expect(rows.at(-1)!.find('.dm-bubble__text').text()).toBe('dig deeper')
    // No echo left to carry its own verdict — this row came off the transcript, and wears the
    // record's mark: handed over, nothing seen acting after it yet. AMENDED for #635 (was: no
    // mark at all, before the transcript's own prompts were marked).
    expect(rows.at(-1)!.find('.dm-bubble__mark').attributes('data-mark')).toBe('delivered')
  })
})

/*
 * AMENDED for #635 (was: 'DwarfMessagePanel press and hover feedback' and 'DwarfMessagePanel
 * withholds the gesture from a disabled control', four cases over the old chrome's
 * `motion.button`s — the name, the history tab, the close, attach, kick and boost). The chrome is
 * the kit's own button now (ActionButton), whose press and hover are its stylesheet's, disabled
 * included (`atoms/button`, ActionButton.test.ts). What stays the panel's is that every tool is a
 * real button named for what it does, and that a control that refuses says why. The history tab,
 * the kick and Boost are gone from the chrome (see the shape block above).
 */
describe('DwarfMessagePanel chrome controls', () => {
  it('draws every tool as a real button, named for what it does', async () => {
    const wrapper = panel()
    for (const tool of wrapper.findAll('.dm-msg__tools button')) {
      expect(tool.attributes('type')).toBe('button')
      expect(tool.attributes('aria-label')).toBe(tool.attributes('title'))
    }
    await wrapper.get('.dm-msg__close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  // A dwarf whose provider declares no `attach` capability, which is every
  // dwarf the fixtures build and most dwarfs in the wild.
  it('disables Attach on a channel that carries no file, and says why on its title', () => {
    const attach = panel().get('.dm-composer__attach')
    expect(attach.attributes('disabled')).toBeDefined()
    // The reason is on the hover line, which is why no CSS `pointer-events: none` may stand in
    // for the disabled state: it would take the title with it.
    expect(attach.attributes('title')).toBeTruthy()
  })
})

/*
 * APPENDED (#635, the MessagePanel slice): one draft per dwarf (decision log, Drafts per dwarf).
 * The panel is mounted per dwarf, so the half-written message is held by its host: the panel
 * opens on the draft it is handed, reports every change to it, and a send empties it.
 */
describe('DwarfMessagePanel keeps its draft with its host', () => {
  it('opens with the draft it is handed in the composer', () => {
    const wrapper = panel({ draft: 'half a thought' })
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('half a thought')
  })

  it('reports each change to the draft', async () => {
    const wrapper = panel()
    await wrapper.find('textarea').setValue('dig')
    expect(wrapper.emitted('draft')?.at(-1)).toEqual(['dig'])
  })
})

// APPENDED for #635, from a live run of the Add panel: the composer's Enter follows the same rule.
describe('DwarfMessagePanel input under an input method', () => {
  it('sends nothing on an Enter the input method is still composing with', async () => {
    const wrapper = panel()
    await wrapper.find('.dm-composer textarea').setValue('掘る')

    await wrapper
      .find('.dm-composer textarea')
      .trigger('keydown', { key: 'Enter', isComposing: true })
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter', keyCode: 229 })
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([[{ text: '掘る', pressEnter: true }]])
  })
})

/*
 * #635, decision log, Copy alone on a closed session — APPENDED. A session that can no longer take
 * text (it ended, or its delivery route went away) has its own disabled composer: the well reads
 * "This session can no longer receive messages.", Attach and Send are disabled with it, and the
 * hint under it stays the keyboard's, as the composer's hint always reads in the design. The
 * no-channel sentence is only ever for a session type with no channel yet, and the closed one
 * never is.
 */
describe('DwarfMessagePanel, a closed session (#635)', () => {
  const failedEcho: MessageEcho = {
    id: 'e2',
    text: 'second',
    sentAt: Date.parse('2026-09-09T10:00:00.000Z'),
    state: { phase: 'failed', error: 'nope' }
  }

  it.each([
    [
      'its delivery route went away',
      { dwarf: defaultDwarf({ textDelivery: undefined }), routeGone: true }
    ],
    [
      'it ended',
      { dwarf: defaultDwarf({ textDelivery: 'terminal', status: 'leaving' }), routeGone: false }
    ]
  ])('draws the closed composer once %s', (_why, props) => {
    const wrapper = panel(props)
    const box = wrapper.find('.dm-composer textarea')
    expect(box.attributes('disabled')).toBeDefined()
    expect(box.attributes('placeholder')).toBe(SESSION_CLOSED_REASON)
    expect(wrapper.find('.dm-composer__attach').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-composer__send').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-composer__hint').text()).toBe(COMPOSER_HINT_TEXT)
    expect(wrapper.html()).not.toContain(NO_CHANNEL_REASON)
  })

  it('says the closed sentence on hover too once the route went away, never the no-channel one', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: undefined }), routeGone: true })
    expect(wrapper.find('.dm-composer .dm-field').attributes('title')).toBe(SESSION_CLOSED_REASON)
  })

  it('keeps the no-channel refusal, and never the closed sentence, for a dwarf that never had one', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: undefined }) })
    const box = wrapper.find('.dm-composer textarea')
    expect(box.attributes('disabled')).toBeDefined()
    expect(box.attributes('placeholder')).toBe('Write to Sample Worker…')
    expect(wrapper.find('.dm-composer__hint').text()).toBe(NO_CHANNEL_REASON)
    expect(wrapper.html()).not.toContain(SESSION_CLOSED_REASON)
  })

  it('keeps Copy alone on a failed message of a session whose route went away', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: undefined }),
      routeGone: true,
      echoes: [failedEcho]
    })
    expect(wrapper.findAll('.dm-bubble__actions .dm-btn').map((b) => b.text())).toEqual([
      COPY_LABEL
    ])
  })
})

/*
 * The outcome line's count and clock, and a run past the person's own message (#635; decision
 * log, Turn outcome line and Activity run closes on the dwarf, MESSAGE-QUESTIONS 3 and 7).
 */
describe('DwarfMessagePanel conversation parts (#635)', () => {
  const RUN = [
    { role: 'user' as const, text: 'Regenerate the skill tables.', timestamp: 't0' },
    {
      role: 'assistant' as const,
      text: 'Read skills/README.md',
      timestamp: 't1',
      activity: { kind: 'read' as const, target: 'skills/README.md' }
    },
    {
      role: 'assistant' as const,
      text: 'Ran skill-sync',
      timestamp: 't2',
      activity: { kind: 'run' as const, target: 'skill-sync' }
    }
  ]

  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts the open run’s steps so far on the outcome line while the dwarf works', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ status: 'working' }), feed: heldFeed(RUN) })
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Working · 2 steps so far')
  })

  it('keeps the run open past the person’s own message the transcript already carries', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ status: 'working' }),
      feed: heldFeed([...RUN, { role: 'user', text: 'Also sort it.', timestamp: 't3' }])
    })
    expect(wrapper.find('.dm-activity__toggle').text()).toBe('Working...')
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Working · 2 steps so far')
  })

  it('keeps it open past a message that failed to hand over', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ status: 'working', textDelivery: 'terminal' }),
      feed: heldFeed(RUN),
      echoes: [{ id: 'e1', text: 'Also sort it.', sentAt: 0, state: { phase: 'failed' } }]
    })
    expect(wrapper.find('.dm-activity__toggle').text()).toBe('Working...')
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Working · 2 steps so far')
  })

  it('closes the run and counts it once the turn is over, with the idle time', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        lastTurn: { kind: 'concluded', endedAt: Date.now() - 41 * 60_000 }
      }),
      feed: heldFeed(RUN)
    })
    expect(wrapper.find('.dm-activity__toggle').text()).toBe('2 steps · activity')
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Turn finished · 2 steps · idle for 41m')
  })

  it('reads the word alone once the dwarf has spoken after its last run', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ status: 'working' }),
      feed: heldFeed([...RUN, { role: 'assistant', text: 'Done.', timestamp: 't3' }])
    })
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Working')
  })

  it('keeps the idle time fresh while the panel stays open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 28, 10, 0, 0))
    const wrapper = panel({
      dwarf: defaultDwarf({
        status: 'waiting',
        lastTurn: { kind: 'concluded', endedAt: Date.now() - 59_000 }
      })
    })
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Turn finished · idle for 59s')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Turn finished · idle for 1m')
    wrapper.unmount()
  })
})

/*
 * A run through an ask, a finished turn's whole count, and what the line leaves out (#635;
 * MESSAGE-QUESTIONS 9, 11 and 12).
 */
describe('DwarfMessagePanel outcome rulings 9 to 12 (#635)', () => {
  const step = (text: string, t: string) => ({
    role: 'assistant' as const,
    text,
    timestamp: t,
    activity: { kind: 'run' as const, target: text }
  })

  // Every panel here is unmounted, so no tooltip or clock outlives its test.
  const mounted: { unmount: () => void }[] = []
  const kept = <W extends { unmount: () => void }>(wrapper: W): W => {
    mounted.push(wrapper)
    return wrapper
  }

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    vi.useRealTimers()
  })

  it('keeps the run open while the dwarf asks for a permission', () => {
    const wrapper = kept(
      panel({
        dwarf: defaultDwarf({ status: 'working', waitingReason: 'approval' }),
        feed: heldFeed([{ role: 'user', text: 'Add it.', timestamp: 't0' }, step('Ran one', 't1')])
      })
    )
    expect(wrapper.find('.dm-activity__toggle').text()).toBe('Working...')
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Waiting on you · permission')
  })

  it('counts every step of a finished turn, across its runs and past the dwarf’s replies', () => {
    const wrapper = kept(
      panel({
        dwarf: defaultDwarf({ status: 'waiting' }),
        feed: heldFeed([
          step('Ran old', 't0'),
          { role: 'user', text: 'Go on.', timestamp: 't1' },
          step('Ran one', 't2'),
          step('Ran two', 't3'),
          { role: 'assistant', text: 'Halfway.', timestamp: 't4' },
          step('Ran three', 't5'),
          { role: 'assistant', text: 'Done.', timestamp: 't6' }
        ])
      })
    )
    expect(wrapper.find('.dm-msg__outcome').text()).toBe('Turn finished · 3 steps')
  })

  function finished(text: string) {
    return kept(
      mount(DwarfMessagePanel, {
        attachTo: document.body,
        props: {
          dwarf: defaultDwarf({
            status: 'waiting',
            lastTurn: { kind: 'concluded', text, endedAt: Date.now() }
          }),
          feed: heldFeed(HELD)
        }
      })
    )
  }

  it('shows the closing words in the line’s tooltip at once on keyboard focus', async () => {
    const wrapper = finished('Found the seam.')
    const line = wrapper.find('.dm-msg__outcome')
    expect(line.attributes('tabindex')).toBe('0')
    await line.trigger('focus')
    await flushPromises()
    expect(document.body.querySelector('.dm-tip')?.textContent?.trim()).toBe('Found the seam.')
    await line.trigger('blur')
    await flushPromises()
    expect(document.body.querySelector('.dm-tip')).toBeNull()
  })

  it('shows it after the tooltip delay on hover, and hides it on leave', async () => {
    vi.useFakeTimers()
    const wrapper = finished('Found the seam.')
    const line = wrapper.find('.dm-msg__outcome')
    await line.trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(TIP_DELAY_MS)
    expect(document.body.querySelector('.dm-tip')).not.toBeNull()
    await line.trigger('pointerleave')
    expect(document.body.querySelector('.dm-tip')).toBeNull()
  })

  it('draws no tooltip, and takes no focus, when there is nothing to add', async () => {
    const wrapper = kept(panel({ dwarf: defaultDwarf({ status: 'waiting' }) }))
    const line = wrapper.find('.dm-msg__outcome')
    expect(line.attributes('tabindex')).toBeUndefined()
    await line.trigger('focus')
    await flushPromises()
    expect(document.body.querySelector('.dm-tip')).toBeNull()
  })
})

/* --- The "Answers:" record (#635, MESSAGE-QUESTIONS 8) — one block, appended ---- */

/*
 * The record of an answer given on the ask's own channel (decision log, Answers bubble is a
 * record): the person's bubble, in the design's Markdown, wearing the answer's own verdict. It
 * carries no Retry and no Copy, even at ✕: the card is how the ask is answered again, and it is
 * back in the composer's place because the ask is still open (organisms/message-panel, Answer
 * refused).
 */
describe('DwarfMessagePanel: the "Answers:" record', () => {
  const RECORD = 'Answers:\n\n- Which database should the importer write to: **SQLite**'
  const pendingQuestion = {
    toolUseId: 'toolu_01',
    channel: 'held' as const,
    questions: [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }]
      }
    ]
  }

  function record(overrides: Partial<MessageEcho> = {}): MessageEcho {
    return {
      id: 'r1',
      text: RECORD,
      sentAt: Date.parse('2026-09-03T09:00:05.000Z'),
      state: { phase: 'delivered', awaitingReaction: true },
      answers: true,
      ...overrides
    }
  }

  function recordBubble(wrapper: ReturnType<typeof panel>) {
    return wrapper.findAll('.dm-bubble').find((bubble) => bubble.text().startsWith('Answers:'))!
  }

  it('draws the record as the person’s bubble: a paragraph and a bulleted list, answer in bold', () => {
    const bubble = recordBubble(panel({ echoes: [record()] }))
    expect(bubble.classes()).toContain('dm-bubble--user')
    const body = bubble.find('.dm-bubble__text')
    expect(body.find('p').text()).toBe('Answers:')
    expect(body.findAll('li').map((li) => li.text())).toEqual([
      'Which database should the importer write to: SQLite'
    ])
    expect(body.find('li strong').text()).toBe('SQLite')
  })

  it('wears the answer’s own marks: …, ✓, then ✓✓', () => {
    const glyph = (state: DwarfSendState) =>
      recordBubble(panel({ echoes: [record({ state })] }))
        .find('.dm-bubble__mark')
        .text()
    expect(glyph({ phase: 'sending' })).toBe('…')
    expect(glyph({ phase: 'delivered', awaitingReaction: false })).toBe('✓')
    expect(glyph({ phase: 'reacted' })).toBe('✓✓')
  })

  it('keeps ✕ not delivered with no Retry and no Copy, and the card is back', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion }),
      echoes: [record({ state: { phase: 'failed', error: 'That ask is no longer open.' } })]
    })
    const bubble = recordBubble(wrapper)
    expect(bubble.find('.dm-bubble__mark').text()).toBe('✕ not delivered')
    expect(bubble.find('.dm-bubble__actions').exists()).toBe(false)
    expect(wrapper.find('.dm-qcard').exists()).toBe(true)
    expect(wrapper.find('.dm-composer').exists()).toBe(false)
  })

  it('offers neither on a session that can no longer take text', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: undefined }),
      routeGone: true,
      echoes: [record({ state: { phase: 'failed' } })]
    })
    expect(recordBubble(wrapper).find('.dm-bubble__actions').exists()).toBe(false)
  })

  it('sits where it was answered, before what the dwarf said after it', () => {
    const wrapper = panel({
      feed: heldFeed([
        ...HELD,
        { role: 'assistant', text: 'Writing to SQLite.', timestamp: '2026-09-03T09:00:09.000Z' }
      ]),
      echoes: [record()]
    })
    expect(wrapper.findAll('.dm-bubble').map((b) => b.find('.dm-bubble__text').text())).toEqual([
      'dig here',
      'Found the seam.',
      expect.stringMatching(/^Answers:/),
      'Writing to SQLite.'
    ])
  })

  it('leaves the run the dwarf asked in open, growing past the answer', () => {
    const step = (text: string, timestamp: string): FeedMessage => ({
      role: 'assistant',
      text,
      timestamp,
      activity: { kind: 'run', target: text }
    })
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', status: 'working' }),
      feed: heldFeed([
        ...HELD,
        step('Ran pnpm test', '2026-09-03T09:00:02.000Z'),
        step('Ran pnpm build', '2026-09-03T09:00:08.000Z')
      ]),
      echoes: [record()]
    })
    const run = wrapper.find('.dm-activity')
    expect(run.text()).toContain('Working...')
    // The run, whole, above the record: it started before the answer and grew after it.
    const log = wrapper.find('.dm-msg__log').element
    const order = [...log.querySelectorAll('.dm-activity, .dm-bubble')].map((el) =>
      el.classList.contains('dm-activity') ? 'run' : (el.textContent ?? '').slice(0, 8)
    )
    expect(order).toEqual(['dig here', 'Found th', 'run', 'Answers:'])
  })
})
/* --- end of the "Answers:" record block ------------------------------------- */

/* --- MESSAGE-QUESTIONS 21 on the "Answers:" record — one block, appended ------------------- */

/*
 * The refusal's reason is the ✕ mark's title on the record, as a failed message carries its own,
 * and the card is drawn with no alert. The card comes back only while the ask is still open: once
 * main's snapshot no longer carries it (the reason was that the ask closed), the composer is back
 * and the ✕ record with its reason is the whole story.
 */
/** The words a bubble's ✕ mark is described by: a refused record's reason (MESSAGE-QUESTIONS 21). */
function describedBy(
  mark: { attributes(name: string): string | undefined },
  root: Element
): string {
  const id = mark.attributes('aria-describedby') ?? ''
  return root.querySelector('#' + id)?.textContent ?? ''
}

describe('DwarfMessagePanel: a refused "Answers:" record (MESSAGE-QUESTIONS 21)', () => {
  const pendingQuestion = {
    toolUseId: 'toolu_01',
    channel: 'held' as const,
    questions: [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }]
      }
    ]
  }

  function refused(error: string): MessageEcho {
    return {
      id: 'r1',
      text: 'Answers:\n\n- Which database should the importer write to: **SQLite**',
      sentAt: Date.parse('2026-09-03T09:00:05.000Z'),
      state: { phase: 'failed', error },
      answers: true,
      ask: 'toolu_01'
    }
  }

  it('describes the ✕ by the reason, and the card that came back draws no alert', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion }),
      echoes: [refused('The console did not take the keys.')],
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'The console did not take the keys.'
      }
    })
    const mark = wrapper.findAll('.dm-bubble').at(-1)!.find('.dm-bubble__mark')
    expect(mark.text()).toBe('✕ not delivered')
    expect(mark.attributes('title')).toBeUndefined()
    expect(describedBy(mark, wrapper.element)).toBe('The console did not take the keys.')
    expect(wrapper.find('.dm-qcard').exists()).toBe(true)
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
  })

  it('brings no card back once the ask has closed: the ✕ record is the whole story', () => {
    const wrapper = panel({
      echoes: [refused('That question is no longer open.')],
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'That question is no longer open.'
      }
    })
    expect(wrapper.find('.dm-qcard').exists()).toBe(false)
    expect(wrapper.find('.dm-composer').exists()).toBe(true)
    const mark = wrapper.findAll('.dm-bubble').at(-1)!.find('.dm-bubble__mark')
    expect(describedBy(mark, wrapper.element)).toBe('That question is no longer open.')
  })
})
/* --- end of the ruling 21 block ------------------------------------------------------------- */

/*
 * No panel outlives its test (#635). A mounted panel keeps its one-second outcome clock running
 * and its tooltips' Teleport anchors in <body>. The clock is a Node timer, which jsdom's teardown
 * does not stop, while that teardown empties <body> under the anchors: the next tick re-renders
 * into a detached tree. CI's macOS runner caught five such unhandled rejections after every test
 * in this file had passed. `enableAutoUnmount` at the top of the file is what keeps it from
 * happening; this is its witness, since a panel left mounted leaves its anchors in <body>.
 */
describe('DwarfMessagePanel test teardown (#635)', () => {
  it('finds nothing an earlier test mounted still in the document', () => {
    expect(document.body.childNodes.length).toBe(0)
  })
})
