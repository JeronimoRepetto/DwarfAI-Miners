// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_PINS, pinViews, stepPins, type PinInput, type PinSet } from '../../lib/valle/pins'
import { SPLIT_OFF, splitButton } from '../../lib/valle/split'
import { pinFacts, pinHarness } from '../../lib/valle/testing/pinHarness'
import { BORIN, DAIN, EREBOR, MORIA, NALI } from '../../lib/veta/testing/vetaFixtures'
import ChatDeck from './ChatDeck.vue'

/*
 * The Work front's chat tabs (ISSUE-302; 07 machine 29; DS organisms/chat-deck, molecules/chat-tab; 17 §1.12): a
 * tablist named "Pinned chats", the selected tab's pane below it. Keyboard maps are tables. Mounted over a host that
 * steps machine 29.
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

const facts = pinFacts({
  [BORIN]: { name: 'borin', status: 'working' },
  [DAIN]: { name: 'dain', status: 'asking', ask: 'permission' },
  [NALI]: { name: 'nali', status: 'idle' }
})

/** Tabs BORIN, DAIN, NALI; BORIN selected. */
const three = (): PinSet =>
  setOf(
    { kind: 'click', dwarfId: BORIN, mineId: MORIA },
    { kind: 'click', dwarfId: DAIN, mineId: EREBOR },
    { kind: 'click', dwarfId: NALI, mineId: MORIA },
    { kind: 'select', key: BORIN }
  )

function mountDeck(initial: PinSet = three(), extra?: (set: PinSet) => Record<string, unknown>) {
  const harness = pinHarness(ChatDeck, initial, facts, extra)
  root = mount(harness.Harness, { attachTo: document.body })
  return { root, ...harness }
}

const tab = (wrapper: VueWrapper, key: string) => wrapper.get(`[role="tab"][data-pin="${key}"]`)
const selected = (wrapper: VueWrapper): (string | undefined)[] =>
  wrapper.findAll('[role="tab"][aria-selected="true"]').map((t) => t.attributes('data-pin'))
const focusedTab = (): string | null =>
  (document.activeElement as HTMLElement | null)?.getAttribute('data-pin') ?? null

describe('the chat tabs (ISSUE-302)', () => {
  it('[US-VALLE-007.AC09, S29.05] clicking a tab selects it and its pane replaces the shown chat', async () => {
    const { root } = mountDeck()
    expect(selected(root)).toEqual([BORIN])
    expect(root.findAll('.dm-cdeck__pane').map((p) => p.attributes('data-pane'))).toEqual([BORIN])
    // A needing dwarf's tab carries only "?" (AC13), whatever its ask.
    expect(tab(root, DAIN).get('.dm-ctab__ask').text()).toBe('?')
    expect(tab(root, DAIN).attributes('aria-label')).toBe('dain, needs you')
    expect(tab(root, DAIN).text()).not.toContain('permission')

    await tab(root, DAIN).trigger('click')
    expect(selected(root)).toEqual([DAIN])
    expect(root.findAll('.dm-cdeck__pane').map((p) => p.attributes('data-pane'))).toEqual([DAIN])
  })

  it('[US-VALLE-007.AC10, S29.06] ← and → on a focused tab move focus without changing the selection', async () => {
    const { root } = mountDeck()
    ;(tab(root, BORIN).element as HTMLElement).focus()
    // key pressed → the tab with keyboard focus after it; the selection stays BORIN throughout. Wraps at both ends.
    const table: [string, string][] = [
      ['ArrowRight', DAIN],
      ['ArrowRight', NALI],
      ['ArrowRight', BORIN],
      ['ArrowLeft', NALI],
      ['ArrowLeft', DAIN]
    ]
    for (const [key, focused] of table) {
      await root.get(`[data-pin="${focusedTab()}"]`).trigger('keydown', { key })
      await flushPromises()
      expect(focusedTab(), key).toBe(focused)
      expect(selected(root), key).toEqual([BORIN])
      // Roving focus: only the focused tab is in the tab order.
      expect(
        root.findAll('[role="tab"][tabindex="0"]').map((t) => t.attributes('data-pin'))
      ).toEqual([focused])
    }
  })

  it('[US-VALLE-007.AC11] Enter or Space on a focused tab selects it', async () => {
    const table: [string, string][] = [
      ['Enter', DAIN],
      [' ', NALI]
    ]
    for (const [key, target] of table) {
      const { root } = mountDeck()
      await tab(root, target).trigger('keydown', { key })
      expect(selected(root), key).toEqual([target])
      expect(root.findAll('.dm-cdeck__pane').map((p) => p.attributes('data-pane'))).toEqual([
        target
      ])
      root.unmount()
    }
  })

  it('[US-VALLE-007.AC03, US-VALLE-007.AC04, S29.10, S29.11] Delete or Backspace on a focused tab, × or a middle click unpin it; keyboard focus moves to what took its place, never dropped', async () => {
    const { root, sent } = mountDeck()
    const table: [string, () => Promise<void>, string | null][] = [
      ['Delete', () => tab(root, BORIN).trigger('keydown', { key: 'Delete' }), DAIN],
      ['middle click', () => tab(root, NALI).trigger('auxclick', { button: 1 }), DAIN],
      ['×', () => tab(root, DAIN).get('.dm-ctab__x').trigger('click'), null]
    ]
    for (const [how, act, focused] of table) {
      await act()
      await flushPromises()
      if (focused === null) {
        expect((document.activeElement as HTMLElement).classList.contains('dm-cdeck'), how).toBe(
          true
        )
      } else expect(focusedTab(), how).toBe(focused)
    }
    // Backspace unpins as Delete does.
    const again = mountDeck().root
    await tab(again, NALI).trigger('keydown', { key: 'Backspace' })
    expect(again.findAll('[role="tab"]').map((t) => t.attributes('data-pin'))).toEqual([
      BORIN,
      DAIN
    ])
    expect(sent.filter((input) => input.kind === 'unpin').map((i) => i.kind)).toHaveLength(3)
  })

  it('[US-VALLE-007.AC05, S29.07, S29.08, S29.09] dragging a tab over another reorders the strip on drop; a drag ended without a drop keeps the order', async () => {
    const { root, set } = mountDeck()
    const order = () => root.findAll('[role="tab"]').map((t) => t.attributes('data-pin'))
    await tab(root, NALI).trigger('dragstart')
    await tab(root, BORIN).trigger('dragover')
    expect(order()).toEqual([NALI, BORIN, DAIN])
    await tab(root, BORIN).trigger('drop')
    await tab(root, NALI).trigger('dragend')
    expect(set.value.pins.map((pin) => pin.key)).toEqual([NALI, BORIN, DAIN])

    await tab(root, DAIN).trigger('dragstart')
    await tab(root, NALI).trigger('dragover')
    await tab(root, DAIN).trigger('dragend')
    expect(order()).toEqual([NALI, BORIN, DAIN])
    expect(set.value.pins.map((pin) => pin.key)).toEqual([NALI, BORIN, DAIN])
    expect(set.value.dragging).toBeNull()
  })
})

describe('the split (ISSUE-303)', () => {
  /** The deck alone, BORIN and DAIN side by side, focus in `focus`'s pane. */
  function mountSplit(
    focus: string,
    button = { disabled: false, pressed: true, title: 'Split · two chats side by side' }
  ) {
    const wrapper = mount(ChatDeck, {
      props: {
        pins: pinViews(three(), facts),
        focus,
        focusRequest: null,
        split: { panes: [BORIN, DAIN], button }
      },
      attachTo: document.body
    })
    root = wrapper
    return wrapper
  }
  const brass = (wrapper: VueWrapper) => ({
    tabs: wrapper.findAll('.dm-ctab.is-focus-pane').map((t) => t.attributes('data-pin')),
    panes: wrapper.findAll('.dm-cdeck__pane.is-focus').map((p) => p.attributes('data-pane'))
  })

  it('[US-VALLE-008.AC07, S30.09] with both panes shown both tabs read as selected and only the focused pane and its tab carry the brass mark', async () => {
    const deck = mountSplit(DAIN)
    expect(deck.get('.dm-cdeck__panes').attributes('data-split')).toBe('true')
    expect(deck.findAll('.dm-cdeck__pane').map((p) => p.attributes('data-pane'))).toEqual([
      BORIN,
      DAIN
    ])
    expect(selected(deck)).toEqual([BORIN, DAIN])
    expect(brass(deck)).toEqual({ tabs: [DAIN], panes: [DAIN] })

    // A click in the other pane asks for its chat; a click in the focused pane asks nothing.
    await deck.get(`.dm-cdeck__pane[data-pane="${BORIN}"]`).trigger('pointerdown')
    await deck.get(`.dm-cdeck__pane[data-pane="${DAIN}"]`).trigger('pointerdown')
    expect(deck.emitted('select')).toEqual([[BORIN]])
    await deck.setProps({ focus: BORIN })
    expect(selected(deck)).toEqual([BORIN, DAIN])
    expect(brass(deck)).toEqual({ tabs: [BORIN], panes: [BORIN] })

    // ⫽: a toggle reporting aria-pressed, titled per machine 30; a press asks for the split.
    const press = deck.get('button.dm-cdeck__split')
    expect(press.text()).toBe('⫽')
    expect(press.attributes('title')).toBe('Split · two chats side by side')
    expect(press.attributes('aria-pressed')).toBe('true')
    await press.trigger('click')
    expect(deck.emitted('split')).toHaveLength(1)
  })

  it('[US-VALLE-008.AC04, US-VALLE-008.AC06] one pane shows its tab with the brass edge and no pane outline; a disabled ⫽ carries its title', () => {
    const deck = mount(ChatDeck, {
      props: {
        pins: pinViews(three(), facts),
        focus: BORIN,
        focusRequest: null,
        split: {
          panes: [BORIN],
          button: { disabled: true, pressed: true, title: 'Split · needs a wider window' }
        }
      },
      attachTo: document.body
    })
    root = deck
    expect(deck.get('.dm-cdeck__panes').attributes('data-split')).toBe('false')
    expect(selected(deck)).toEqual([BORIN])
    expect(brass(deck)).toEqual({ tabs: [BORIN], panes: [] })
    const press = deck.get('button.dm-cdeck__split')
    expect(press.attributes('disabled')).toBeDefined()
    expect(press.attributes('title')).toBe('Split · needs a wider window')
  })
})

const EMPTY = 'No chats pinned. Click a dwarf in the mine to open one.'

/** The split as the Work front gives the deck: machine 30's button over the pins, with room to spare. */
const withSplit = (set: PinSet): Record<string, unknown> => ({
  split: {
    panes: set.focus === null ? [] : [set.focus],
    button: splitButton(SPLIT_OFF, {
      pins: set.pins.map((pin) => ({
        key: pin.key,
        dwarfId: pin.kind === 'chat' ? pin.dwarfId : null,
        needs: false
      })),
      focus: set.focus,
      room: 10_000
    })
  }
})

describe('the chat deck empty state (ISSUE-310; 07 machine 38; US-VALLE-015)', () => {
  it('[US-VALLE-015.AC01, S38.03] the Work front with nothing pinned shows No chats pinned. Click a dwarf in the mine to open one.', () => {
    const { root } = mountDeck(NO_PINS)
    expect(root.findAll('.dm-cdeck__empty').map((l) => l.text())).toEqual([EMPTY])
    // In place of any tabs or panes.
    expect(root.findAll('[role="tab"]')).toHaveLength(0)
    expect(root.findAll('.dm-cdeck__pane')).toHaveLength(0)
  })

  it('[US-VALLE-015.AC02, S38.04] clicking a dwarf in the mine pins it as the first tab and replaces the empty state', async () => {
    const { root, send } = mountDeck(NO_PINS)
    expect(root.findAll('.dm-cdeck__empty')).toHaveLength(1)
    send({ kind: 'click', dwarfId: BORIN, mineId: MORIA })
    await flushPromises()
    expect(root.findAll('.dm-cdeck__empty')).toHaveLength(0)
    expect(root.findAll('[role="tab"]').map((t) => t.attributes('data-pin'))).toEqual([BORIN])
    expect(selected(root)).toEqual([BORIN])
    expect(root.findAll('.dm-cdeck__pane').map((p) => p.attributes('data-pane'))).toEqual([BORIN])
    expect(root.text()).not.toContain(EMPTY)
  })

  it('[US-VALLE-015.AC03, S38.03] unpinning the only chat returns the deck to the empty state', async () => {
    const { root } = mountDeck(setOf({ kind: 'click', dwarfId: BORIN, mineId: MORIA }))
    expect(root.findAll('.dm-cdeck__empty')).toHaveLength(0)
    await tab(root, BORIN).get('.dm-ctab__x').trigger('click')
    await flushPromises()
    expect(root.findAll('.dm-cdeck__empty').map((l) => l.text())).toEqual([EMPTY])
    expect(root.findAll('[role="tab"]')).toHaveLength(0)
    expect(root.findAll('.dm-cdeck__pane')).toHaveLength(0)
  })

  it('[US-VALLE-015.AC04, S30.03] with the deck empty ⫽ stays disabled', async () => {
    const { root, send } = mountDeck(NO_PINS, withSplit)
    const button = (): HTMLButtonElement =>
      root.get('.dm-cdeck__split').element as HTMLButtonElement
    expect(button().disabled).toBe(true)
    expect(button().getAttribute('title')).toBe('Split · two chats side by side')
    // Exactly as with fewer than two chats pinned: one chat does not enable it either.
    send({ kind: 'click', dwarfId: BORIN, mineId: MORIA })
    await flushPromises()
    expect(button().disabled).toBe(true)
    // The deck reads the pins itself: a button that claims to be enabled over an empty deck still shows disabled.
    const faulty = mountDeck(NO_PINS, () => ({
      split: {
        panes: [],
        button: { disabled: false, pressed: false, title: 'Split · two chats side by side' }
      }
    })).root
    expect((faulty.get('.dm-cdeck__split').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('[S38.03] pins of other mines keep the deck populated', () => {
    // The Work front shows MORIA; the only pin is a dwarf of EREBOR: it is a tab too, so the deck is not empty (V-03).
    const { root } = mountDeck(setOf({ kind: 'click', dwarfId: DAIN, mineId: EREBOR }))
    expect(root.findAll('.dm-cdeck__empty')).toHaveLength(0)
    expect(root.findAll('[role="tab"]').map((t) => t.attributes('data-pin'))).toEqual([DAIN])
  })
})
