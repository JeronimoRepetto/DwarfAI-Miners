// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_PINS, stepPins, type PinInput, type PinSet } from '../../lib/valle/pins'
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

function mountDeck(initial: PinSet = three()) {
  const harness = pinHarness(ChatDeck, initial, facts)
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
