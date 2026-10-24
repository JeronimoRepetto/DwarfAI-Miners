// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_PINS, addKey, stepPins, type PinInput, type PinSet } from '../../lib/valle/pins'
import { pinFacts, pinHarness } from '../../lib/valle/testing/pinHarness'
import { BORIN, DAIN, EREBOR, MORIA, NALI } from '../../lib/veta/testing/vetaFixtures'
import PinnedStack from './PinnedStack.vue'

const EMPTY = 'Click a dwarf, in any mine, to pin its chat here.'

/*
 * The Control room's pinned chat stack (ISSUE-302; 07 machine 29; DS organisms/chat-stack; 17 §1.12): one line per pin,
 * the one in focus expanded, the head "Pinned chats" with its count. Mounted over a host that steps machine 29.
 */
let root: VueWrapper | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.innerHTML = ''
})

function setOf(...inputs: PinInput[]): PinSet {
  let set = NO_PINS
  for (const input of inputs) {
    const step = stepPins(set, input)
    if (!step.ok) throw new Error(JSON.stringify(input))
    set = step.set
  }
  return set
}

const facts = pinFacts(
  {
    [BORIN]: { name: 'borin', status: 'working' },
    [DAIN]: { name: 'dain', status: 'asking', ask: 'permission' },
    [NALI]: { name: 'nali', status: 'asleep' }
  },
  { [MORIA]: 'moria', [EREBOR]: 'erebor' }
)

const three = (): PinSet =>
  setOf(
    { kind: 'click', dwarfId: BORIN, mineId: MORIA },
    { kind: 'click', dwarfId: DAIN, mineId: EREBOR },
    { kind: 'click', dwarfId: NALI, mineId: MORIA },
    { kind: 'select', key: BORIN }
  )

function mountStack(initial: PinSet) {
  const harness = pinHarness(PinnedStack, initial, facts)
  root = mount(harness.Harness, { attachTo: document.body })
  return { root, ...harness }
}

const expanded = (wrapper: VueWrapper): (string | undefined)[] =>
  wrapper.findAll('[data-expanded="true"]').map((line) => line.attributes('data-pin'))

describe('the pinned chat stack (ISSUE-302)', () => {
  it('[US-VALLE-007.AC08] clicking a stack line out of focus expands it and collapses the previous one; only one is expanded', async () => {
    const { root } = mountStack(three())
    expect(expanded(root)).toEqual([BORIN])
    // The others are one line each, with their state: a needing one in brass.
    const dain = root.get(`[data-pin="${DAIN}"]`)
    expect(dain.attributes('role')).toBe('button')
    expect(dain.attributes('aria-label')).toBe('dain, needs you. Open this chat')
    expect(dain.attributes('data-needs')).toBe('true')
    expect(dain.get('.dm-cstack__state').text()).toBe('! permission')

    await dain.trigger('click')
    expect(expanded(root)).toEqual([DAIN])
    expect(root.get(`[data-pin="${BORIN}"]`).attributes('role')).toBe('button')
    expect(root.get(`[data-pin="${BORIN}"] .dm-cstack__state`).text()).toBe('working')

    // Enter or Space on a focused line opens it too (DS organisms/chat-stack, Accessibility).
    for (const key of ['Enter', ' ']) {
      const line = root.get(`[data-pin="${key === 'Enter' ? NALI : BORIN}"]`)
      await line.trigger('keydown', { key })
      expect(expanded(root), key).toEqual([key === 'Enter' ? NALI : BORIN])
    }
  })

  it('[US-VALLE-007.AC12] the stack head reads Pinned chats with a count of every pin, and is empty with none', async () => {
    const withAdd = stepPins(three(), { kind: 'add-open', mineId: EREBOR })
    if (!withAdd.ok) throw new Error('refused')
    const { root } = mountStack(withAdd.set)
    expect(root.get('section.dm-cstack').attributes('aria-label')).toBe('Pinned chats')
    expect(root.get('.dm-cstack__title').text()).toBe('Pinned chats')
    // Three chats and the open Add panel.
    expect(root.get('.dm-cstack__count').text()).toBe('4')
    // Open, the Add pin has no line of its own (VQA-11): its name is the open chat's; its state shows on its line.
    const add = root.get(`[data-pin="${addKey(EREBOR)}"]`)
    expect(add.attributes('data-pin-state')).toBe('add')
    expect(add.attributes('aria-label')).toContain('New dwarf')
    await root.get(`.dm-cstack__row[data-pin="${BORIN}"]`).trigger('click')
    expect(root.get(`.dm-cstack__row[data-pin="${addKey(EREBOR)}"]`).text()).toContain('in erebor')
    root.unmount()

    const empty = mountStack(NO_PINS).root
    expect(empty.get('.dm-cstack__title').text()).toBe('Pinned chats')
    expect(empty.get('.dm-cstack__count').text()).toBe('')
    expect(empty.findAll('[data-pin]')).toHaveLength(0)
  })

  it('[US-VALLE-007.AC03, US-VALLE-007.AC04, S29.10, S29.11] Delete on a focused line, × or a middle click unpin it; keyboard focus moves to what took its place, never dropped', async () => {
    const { root, sent } = mountStack(three())
    const rows: [string, () => Promise<void>, string | null][] = [
      // Delete on the focused line: focus to the next one.
      [
        'Delete',
        async () => {
          const line = root.get(`[data-pin="${DAIN}"]`)
          ;(line.element as HTMLElement).focus()
          await line.trigger('keydown', { key: 'Delete' })
        },
        NALI
      ],
      // × on the last line: focus to the one before it, the expanded chat.
      ['×', () => root.get(`[data-pin="${NALI}"] .dm-cstack__x`).trigger('click'), BORIN],
      // A middle click on the only pin left, the expanded chat, which has no line of its own (VQA-11): focus to the
      // stack itself.
      [
        'middle click',
        () => root.get(`[data-pin="${BORIN}"]`).trigger('auxclick', { button: 1 }),
        null
      ]
    ]
    for (const [how, act, focused] of rows) {
      await act()
      await flushPromises()
      const active = document.activeElement as HTMLElement | null
      if (focused === null) expect(active?.classList.contains('dm-cstack'), how).toBe(true)
      else expect(active?.closest('[data-pin]')?.getAttribute('data-pin'), how).toBe(focused)
    }
    expect(sent.filter((input) => input.kind === 'unpin')).toEqual([
      { kind: 'unpin', key: DAIN },
      { kind: 'unpin', key: NALI },
      { kind: 'unpin', key: BORIN }
    ])
    expect(root.findAll('[data-pin]')).toHaveLength(0)
  })
})

describe('the pinned chat stack empty state (ISSUE-310; 07 machine 38; US-VALLE-014)', () => {
  it('[US-VALLE-014.AC01, S38.01] the Control room with nothing pinned shows Click a dwarf, in any mine, to pin its chat here.', () => {
    const { root } = mountStack(NO_PINS)
    const line = root.findAll('.dm-cstack__empty')
    expect(line.map((l) => l.text())).toEqual([EMPTY])
    // In place of the lines, with the head count empty.
    expect(root.findAll('[data-pin]')).toHaveLength(0)
    expect(root.get('.dm-cstack__count').text()).toBe('')
    expect(root.get('section.dm-cstack').attributes('aria-label')).toBe('Pinned chats')
  })

  it('[US-VALLE-014.AC02, S38.02] clicking a dwarf in the mosaic pins and opens its chat and the stack shows that one line', async () => {
    const { root, send } = mountStack(NO_PINS)
    expect(root.findAll('.dm-cstack__empty')).toHaveLength(1)
    send({ kind: 'click', dwarfId: BORIN, mineId: MORIA })
    await flushPromises()
    expect(root.findAll('.dm-cstack__empty')).toHaveLength(0)
    expect(root.findAll('[data-pin]').map((l) => l.attributes('data-pin'))).toEqual([BORIN])
    expect(expanded(root)).toEqual([BORIN])
    // The head count from 0.
    expect(root.get('.dm-cstack__count').text()).toBe('1')
    expect(root.text()).not.toContain(EMPTY)
  })

  it('[US-VALLE-014.AC03, S38.01] unpinning the only chat returns the stack to the empty state', async () => {
    const { root } = mountStack(setOf({ kind: 'click', dwarfId: BORIN, mineId: MORIA }))
    expect(root.findAll('.dm-cstack__empty')).toHaveLength(0)
    // The only pin is the open chat, with no line of its own (VQA-11): a middle click unpins it.
    await root.get(`[data-pin="${BORIN}"]`).trigger('auxclick', { button: 1 })
    await flushPromises()
    expect(root.findAll('.dm-cstack__empty').map((l) => l.text())).toEqual([EMPTY])
    expect(root.findAll('[data-pin]')).toHaveLength(0)
    expect(root.get('.dm-cstack__count').text()).toBe('')
  })
})

// APPENDED for the Valle visual parity (EPIC-20): an Add pin's line leads with the "+" box where a portrait would be
// (`DS/prototype/organisms/chat-stack/chat-stack.js`: `span.dm-ctab__add` holding the add icon), open or collapsed.
describe("an Add pin's line in the stack (EPIC-20 visual parity)", () => {
  it('[US-VALLE-007.AC12] an Add pin leads its collapsed line with the "+" box, where a chat has its portrait; open, it has no line', async () => {
    const opened = stepPins(three(), { kind: 'add-open', mineId: EREBOR })
    if (!opened.ok) throw new Error('refused')
    const { root } = mountStack(opened.set)
    // Open, the Add pin is its panel alone, with no line above it (VQA-11; `DS` chat-stack.js render).
    const open = root.get(`.dm-cstack__open[data-pin="${addKey(EREBOR)}"]`)
    expect(open.find('.dm-cstack__row').exists()).toBe(false)
    expect(open.find('.dm-ctab__add').exists()).toBe(false)
    // Collapsed once another pin takes the focus.
    await root.get(`.dm-cstack__row[data-pin="${BORIN}"]`).trigger('click')
    await flushPromises()
    const line = root.get(`.dm-cstack__row[data-pin="${addKey(EREBOR)}"]`)
    expect(line.attributes('data-expanded')).toBe('false')
    expect(line.element.firstElementChild?.classList.contains('dm-ctab__add')).toBe(true)
  })
})

// APPENDED for the Valle QA (VQA-01, VQA-11; EPIC-20), REWORKED for the owner check of 2026-10-24. The design draws the
// stack with three pins and is silent on more (`DS` organisms/chat-stack). #1514 gave the lines above and below the open
// chat a scroll region each; the owner rejected the three scrollbars that made, and asked for one list that scrolls
// whole, carrying the open chat with it, a visible outline round the open chat, and an opening that is not abrupt. So the
// two regions are gone and the expectations that pinned them are replaced by the owner's model. jsdom lays nothing out,
// so the layout is read from the rules the stack declares (the house idiom, valleChatHosting.test.ts) and the geometry
// the motion reads is a stub; the laid-out page is the L9 case `e2e/valle/stack-overflow.e2e.ts`.
const stackCss = readFileSync(join(import.meta.dirname, 'PinnedStack.vue'), 'utf8')

/** The declarations of the stack's rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const at = stackCss.indexOf('\n' + selector + ' {')
  expect(at, `no rule ${selector}`).toBeGreaterThan(-1)
  const body = stackCss.slice(stackCss.indexOf('{', at) + 1, stackCss.indexOf('}', at))
  return Object.fromEntries(
    body
      .split(';')
      .map((line) => line.trim())
      .filter((line) => line.includes(':'))
      .map((line) => [
        line.slice(0, line.indexOf(':')).trim(),
        line.slice(line.indexOf(':') + 1).trim()
      ])
  )
}

/** Every selector of the stack's style that lets its box scroll. */
function scrollers(): string[] {
  const style = stackCss.slice(stackCss.indexOf('<style'))
  return [...style.matchAll(/\n([^\n{}]+) \{([^}]*)\}/g)]
    .filter(([, , body]) => /overflow(-y)?:\s*(auto|scroll)/.test(body!))
    .map(([, selector]) => selector!.trim())
}

/** The list's children in order: a line by its pin, the open chat as `open:<pin>`. */
const parts = (wrapper: VueWrapper): string[] =>
  [...wrapper.get('.dm-cstack__list').element.children].map((part) =>
    part.classList.contains('dm-cstack__open')
      ? 'open:' + part.getAttribute('data-pin')
      : (part.getAttribute('data-pin') ?? part.className)
  )

describe('the pinned chat stack with many pins (Valle QA VQA-01, VQA-11)', () => {
  it('[US-VALLE-007.AC08] the pin in focus has no line of its own: its chat opens in its place, as in the prototype', async () => {
    const { root } = mountStack(three())
    // `DS/prototype/organisms/chat-stack/chat-stack.js` render: the focused item's line is removed, its chat appended.
    const open = root.get(`.dm-cstack__open[data-pin="${BORIN}"]`)
    expect(open.findAll('.dm-cstack__row')).toHaveLength(0)
    expect(root.findAll('.dm-cstack__row').map((line) => line.attributes('data-pin'))).toEqual([
      DAIN,
      NALI
    ])
    // The focus moves: the line it left comes back, the one it reached goes.
    await root.get(`.dm-cstack__row[data-pin="${DAIN}"]`).trigger('click')
    expect(root.findAll('.dm-cstack__row').map((line) => line.attributes('data-pin'))).toEqual([
      BORIN,
      NALI
    ])
    expect(
      root.get(`.dm-cstack__open[data-pin="${DAIN}"]`).findAll('.dm-cstack__row')
    ).toHaveLength(0)
  })

  it('[US-VALLE-007.AC08] one list holds the lines and the open chat in pin order and scrolls as one; no line region scrolls on its own', async () => {
    const { root } = mountStack(three())
    expect(parts(root)).toEqual([`open:${BORIN}`, DAIN, NALI])
    await root.get(`.dm-cstack__row[data-pin="${DAIN}"]`).trigger('click')
    expect(parts(root)).toEqual([BORIN, `open:${DAIN}`, NALI])
    await root.get(`.dm-cstack__row[data-pin="${NALI}"]`).trigger('click')
    expect(parts(root)).toEqual([BORIN, DAIN, `open:${NALI}`])
    // The list is the stack's one scroll (the open chat's log scrolls inside the chat, the MessagePanel's own).
    expect(scrollers()).toEqual(['.dm-cstack__list'])
    expect(rule('.dm-cstack__list')).toMatchObject({ 'min-height': '0', 'overflow-y': 'auto' })
  })

  it('[US-VALLE-007.AC08] the open chat keeps a fixed room in the list: it fills what the lines leave, never under 240 px or the list less two lines', () => {
    // Few lines: it grows into what they leave, as in the prototype. Many: it never shrinks (the list scrolls instead),
    // holding the list's height less two lines (a line is 44 px, a 2 px margin above and below, and a 4 px gap), so a
    // neighbour line shows on each side when it is in view, and at least the design's 240 px, never more than the list.
    expect(rule('.dm-cstack__open')).toMatchObject({
      flex: '1 0 auto',
      'min-height': 'min(100%, max(240px, 100% - 2 * (44px + 2 * var(--px, 2px) + 4px)))'
    })
    expect(rule('.dm-cstack__row')).toMatchObject({ flex: 'none', height: '44px' })
    // Its floor is its fixed parts and that room, never its conversation: the log scrolls inside the room left to it
    // (`DS/docs/screens/message.md`, height set by the layout, scrolls inside).
    expect(rule('.dm-cstack__open > :deep(.dm-msg .dm-msg__log)')).toMatchObject({
      contain: 'size'
    })
  })

  it('[US-VALLE-007.AC08] the open chat wears an outline from its head to its composer: the brass edge the deck gives the pane in focus', () => {
    // `DS/prototype/organisms/chat-deck/chat-deck.css` `.dm-cdeck__pane.is-focus::after`: an overlay over the whole
    // chat, painted, never hit.
    expect(rule('.dm-cstack__open')).toMatchObject({ position: 'relative' })
    expect(rule('.dm-cstack__open::after')).toEqual({
      content: "''",
      position: 'absolute',
      inset: '0',
      'pointer-events': 'none',
      'box-shadow': 'inset 0 0 0 2px var(--brass)'
    })
  })
})

// APPENDED for the owner check of 2026-10-24: opening a chat plays, and brings it into view. jsdom lays nothing out and
// has no Web Animations, so the boxes are a stub laid out from the list's order (a line 52 px, the open chat 160 px, the
// list `listHeight` tall and scrolled by its own `scrollTop`) and `animate` is a recording fake.
describe('opening a chat in the pinned stack (owner check 2026-10-24)', () => {
  interface Played {
    pin: string | null
    frames: Keyframe[]
    timing: KeyframeAnimationOptions
  }
  let played: Played[] = []
  let listHeight = 1000
  let reduced = false
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const realRect = HTMLElement.prototype.getBoundingClientRect
  const realMatchMedia = window.matchMedia

  const box = (top: number, height: number): DOMRect =>
    ({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: top
    }) as DOMRect

  beforeEach(() => {
    played = []
    listHeight = 1000
    reduced = false
    proto.animate = function (
      this: HTMLElement,
      frames: Keyframe[],
      timing: KeyframeAnimationOptions
    ) {
      played.push({ pin: this.getAttribute('data-pin'), frames, timing })
      return { cancel() {}, finished: Promise.resolve() }
    }
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.classList.contains('dm-cstack__list')) return box(0, listHeight)
      const list = this.parentElement
      if (list === null || !list.classList.contains('dm-cstack__list')) return box(0, 0)
      let top = -list.scrollTop
      for (const part of list.children) {
        const height = part.classList.contains('dm-cstack__open') ? 160 : 52
        if (part === this) return box(top, height)
        top += height
      }
      return box(0, 0)
    }
    window.matchMedia = ((query: string) => ({
      matches: reduced && query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {}
    })) as unknown as typeof window.matchMedia
  })
  afterEach(() => {
    delete proto.animate
    HTMLElement.prototype.getBoundingClientRect = realRect
    window.matchMedia = realMatchMedia
  })

  /** A list whose `scrollTop` holds what is set, as a laid-out one does. */
  function scrollable(wrapper: VueWrapper): HTMLElement {
    const list = wrapper.get('.dm-cstack__list').element as HTMLElement
    let top = 0
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value
      }
    })
    return list
  }

  it('[US-VALLE-007.AC08] opening a chat unrolls it from its head over --dur-panel while the lines it moved slide to their place; under reduced motion it opens at once, nothing played', async () => {
    const { root } = mountStack(three())
    scrollable(root)
    // BORIN open, DAIN, NALI → BORIN, DAIN, NALI open: DAIN rises from under BORIN's chat, 108 px; BORIN stays put.
    await root.get(`.dm-cstack__row[data-pin="${NALI}"]`).trigger('click')
    await flushPromises()
    const timing = { duration: 180, easing: 'cubic-bezier(0.2, 0.7, 0.1, 1)' }
    expect(played).toEqual([
      { pin: DAIN, frames: [{ transform: 'translateY(108px)' }, { transform: 'none' }], timing },
      {
        pin: NALI,
        frames: [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }],
        timing
      }
    ])
    // Reduced motion: the next chat opens in one frame.
    reduced = true
    played = []
    await root.get(`.dm-cstack__row[data-pin="${DAIN}"]`).trigger('click')
    await flushPromises()
    expect(root.get('.dm-cstack__open').attributes('data-pin')).toBe(DAIN)
    expect(played).toEqual([])
  })

  it('[US-VALLE-007.AC08] opening a chat scrolls the list to bring it into view, head first, its composer shown when it fits', async () => {
    for (const motion of [false, true]) {
      reduced = motion
      listHeight = 200
      const { root } = mountStack(three())
      const list = scrollable(root)
      // NALI opens at 104 px, 160 px tall, under a 200 px list: its foot lines up with the list's, 64 px down.
      await root.get(`.dm-cstack__row[data-pin="${NALI}"]`).trigger('click')
      await flushPromises()
      expect(list.scrollTop, `reduced ${motion}`).toBe(64)
      // Back to BORIN, now above the view: its head lines up with the list's top.
      await root.get(`.dm-cstack__row[data-pin="${BORIN}"]`).trigger('click')
      await flushPromises()
      expect(list.scrollTop, `reduced ${motion}`).toBe(0)
      root.unmount()
    }
  })
})
