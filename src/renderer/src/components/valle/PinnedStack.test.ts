// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
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
    const add = root.get(`[data-pin="${addKey(EREBOR)}"]`)
    expect(add.attributes('data-pin-state')).toBe('add')
    expect(add.text()).toContain('New dwarf')
    expect(add.text()).toContain('in erebor')
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
      // A middle click on the last line: focus to the one before it, the expanded chat.
      [
        'middle click',
        () => root.get(`[data-pin="${NALI}"]`).trigger('auxclick', { button: 1 }),
        BORIN
      ],
      // × on the only pin left: focus to the stack itself.
      ['×', () => root.get(`[data-pin="${BORIN}"] .dm-cstack__x`).trigger('click'), null]
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
    await root.get(`[data-pin="${BORIN}"] .dm-cstack__x`).trigger('click')
    await flushPromises()
    expect(root.findAll('.dm-cstack__empty').map((l) => l.text())).toEqual([EMPTY])
    expect(root.findAll('[data-pin]')).toHaveLength(0)
    expect(root.get('.dm-cstack__count').text()).toBe('')
  })
})
