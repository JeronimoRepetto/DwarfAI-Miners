// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { h, type Component } from 'vue'
import { NO_PINS, pinViews, stepPins, type PinInput, type PinSet } from '../../lib/valle/pins'
import { pinFacts } from '../../lib/valle/testing/pinHarness'
import { splitterRange, type SplitterGeometry } from '../../lib/valle/splitter'
import { BORIN, DAIN, EREBOR, MORIA } from '../../lib/veta/testing/vetaFixtures'
import { OTHER_CHOICE } from '../../lib/launch/launchState'
import { providerChips } from '../../lib/launch/providerChips'
import { defaultDwarf } from '../../testing/factories'
import AddPanel from '../launch/AddPanel.vue'
import DwarfMessagePanel from '../message/DwarfMessagePanel.vue'
import ChatDeck from './ChatDeck.vue'
import PinnedStack from './PinnedStack.vue'

/*
 * The MessagePanel and the Add panel hosted in Valle's chat zone and in a split pane (ISSUE-305; 07 S33.11;
 * US-VALLE-005.AC08; US-MSG-015.AC02, AC06; `DS/docs/decisions.md` "MessagePanel width"; `DS/docs/screens/valle.md`
 * Layout): each fills its host and shrinks with it down to its own min-content width, and Valle's minimums never move
 * for it. jsdom lays nothing out, so each case mounts the real panel in the host's `chat` slot (the element the host's
 * rule must reach) and reads the rules each side declares, the house idiom for a stylesheet (DwarfMessagePanel.test.ts).
 * The host widths are the ones the splitter's own ranges give. The MessagePanel's 317 px min-content is its own
 * (EPIC-16, `DS/docs/screens/message.md`): "it fits Valle's narrowest pane (317px)".
 */

/** The MessagePanel's min-content width (decision log, MessagePanel width). */
const MIN_CONTENT = 317
/** The gap between the two chats of a split (`DS` organisms/chat-deck `.dm-cdeck__panes`). */
const PANE_GAP = 6

let root: VueWrapper | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.innerHTML = ''
})

const source = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8')

/** The declarations of the first rule of `file` whose selector list is exactly `selectors`. */
function declarations(file: string, selectors: string): Record<string, string> {
  const css = source(file)
  const at = css.indexOf('\n' + selectors + ' {')
  expect(at, `${file}: no rule ${selectors.replace(/\n/g, ' ')}`).toBeGreaterThan(-1)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
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

/** The host rule each Valle chat host gives the panel it holds. */
const HOSTS = {
  pane: {
    file: 'ChatDeck.vue',
    selectors: '.dm-cdeck__pane > :deep(.dm-msg),\n.dm-cdeck__pane > :deep(.dm-add)',
    parent: '.dm-cdeck__pane'
  },
  zone: {
    file: 'PinnedStack.vue',
    selectors: '.dm-cstack__open > :deep(.dm-msg),\n.dm-cstack__open > :deep(.dm-add)',
    parent: '.dm-cstack__open'
  }
} as const

const facts = pinFacts({
  [BORIN]: { name: 'borin', status: 'working' },
  [DAIN]: { name: 'dain', status: 'idle' }
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

const TWO = setOf(
  { kind: 'click', dwarfId: BORIN, mineId: MORIA },
  { kind: 'click', dwarfId: DAIN, mineId: EREBOR },
  { kind: 'select', key: BORIN }
)

const PANELS: Record<'MessagePanel' | 'Add panel', () => ReturnType<typeof h>> = {
  MessagePanel: () => h(DwarfMessagePanel as Component, { dwarf: defaultDwarf() }),
  'Add panel': () =>
    h(AddPanel as Component, {
      mineName: 'anvil',
      chips: providerChips(
        [{ provider: 'claude', installed: true, launchable: true }],
        OTHER_CHOICE
      ),
      phase: 'other-command-required',
      enabled: false,
      command: '',
      prompt: '',
      refusal: null,
      error: null,
      modelPicker: { visible: false, models: [], disabled: true, note: null },
      effortPicker: { visible: false, efforts: [] },
      permissionsVisible: false,
      jev: {
        availability: 'hidden',
        enabled: false,
        autoAccept: false,
        routing: { phase: 'idle' },
        previousChoice: null,
        launchedOnFallback: false
      }
    })
}

/** The panel mounted in the `chat` slot of a split pane or of the Control room's chat zone. */
function hosted(host: keyof typeof HOSTS, panel: keyof typeof PANELS): Element {
  const pins = pinViews(TWO, facts)
  const chat = PANELS[panel]
  root =
    host === 'pane'
      ? mount(ChatDeck, {
          attachTo: document.body,
          props: {
            pins,
            focus: BORIN,
            focusRequest: null,
            split: {
              panes: [BORIN, DAIN],
              button: { disabled: false, pressed: true, title: 'Split · two chats side by side' }
            }
          },
          slots: { chat }
        })
      : mount(PinnedStack, {
          attachTo: document.body,
          props: { pins, focus: BORIN, focusRequest: null },
          slots: { chat }
        })
  const element = root.element.querySelector(panel === 'MessagePanel' ? '.dm-msg' : '.dm-add')
  expect(element, `${panel} in the ${host}`).not.toBeNull()
  return element!
}

const geometry = (overrides: Partial<SplitterGeometry>): SplitterGeometry => ({
  body: 1428,
  foldedList: false,
  portraits: 4,
  split: false,
  ...overrides
})

describe('the MessagePanel hosted in a Valle zone or pane (ISSUE-305)', () => {
  it('[US-VALLE-005.AC08, S33.11] in the chat zone or a split pane the MessagePanel and Add panel fill their host and shrink to min-content, portrait, header tools, Attach and Send keeping their size', () => {
    const cases: readonly [keyof typeof HOSTS, keyof typeof PANELS][] = [
      ['pane', 'MessagePanel'],
      ['pane', 'Add panel'],
      ['zone', 'MessagePanel'],
      ['zone', 'Add panel']
    ]
    for (const [host, panel] of cases) {
      const element = hosted(host, panel)
      // The host's rule reaches the panel: it is the host's direct child.
      expect(element.parentElement?.matches(HOSTS[host].parent), `${panel} in the ${host}`).toBe(
        true
      )
      root!.unmount()
      root = undefined
    }
    for (const host of Object.values(HOSTS)) {
      // It fills its host, whatever the 440 px it has docked beside the Panel's shell, down to its own min-content.
      expect(declarations(host.file, host.selectors)).toMatchObject({
        width: '100%',
        'min-width': 'min-content'
      })
      // Only the panel's root is sized: no Valle rule sizes anything inside it, so the portrait, the header tools,
      // Attach and Send keep the sizes the panel gives them while the name, the chips and the writing well give way. The
      // one rule inside, in the stack, sizes nothing: it keeps the log's length out of the open chat's floor (Valle QA
      // VQA-01, `contain: size`), so the log still scrolls inside the room the layout gives it.
      const deep = source(host.file).match(/:deep\([^)]*\)/g) ?? []
      expect(new Set(deep), host.file).toEqual(
        new Set([
          ':deep(.dm-msg)',
          ':deep(.dm-add)',
          ...(host === HOSTS.zone ? [':deep(.dm-msg .dm-msg__log)'] : [])
        ])
      )
    }
    // The panels never grow past their host either.
    expect(declarations('../message/DwarfMessagePanel.vue', '.dm-msg')['max-width']).toBe('100%')
    expect(declarations('../launch/AddPanel.vue', '.dm-add')['max-width']).toBe('100%')
  })

  it('[US-MSG-015.AC02] in a zone or pane narrower than 440 px the MessagePanel shrinks to fit, never below 317 px', () => {
    // host → the MessagePanel's width there: the host's own, never under the panel's min-content.
    const zone = (overrides: Partial<SplitterGeometry>, preset: 'control' | 'front' = 'front') =>
      splitterRange(preset, geometry(overrides)).min
    const pane = (overrides: Partial<SplitterGeometry>) =>
      (splitterRange('front', geometry({ ...overrides, split: true })).min - PANE_GAP) / 2
    const rows: readonly [label: string, host: number][] = [
      ['the Control room chat zone at its minimum', zone({}, 'control')],
      ['the Work front chat zone at its minimum', zone({})],
      ['a split pane at the split minimum', pane({})],
      ['a Work front chat zone under 440 px', 420]
    ]
    for (const [label, host] of rows) {
      expect(host, label).toBeLessThan(440)
      // Valle never gives a host narrower than the MessagePanel's floor, so it fits it exactly.
      expect(Math.max(host, MIN_CONTENT), label).toBe(host)
    }
    expect(pane({}), 'the narrowest pane').toBe(MIN_CONTENT)
    const element = hosted('pane', 'MessagePanel')
    expect(element.parentElement?.matches('.dm-cdeck__pane')).toBe(true)
    expect(declarations(HOSTS.pane.file, HOSTS.pane.selectors)).toMatchObject({
      width: '100%',
      'min-width': 'min-content'
    })
  })

  it("[US-MSG-015.AC06] Valle's chat-zone and split-pane minimums are unchanged by the MessagePanel's width", () => {
    hosted('pane', 'MessagePanel')
    // The minimums are machine 33's alone: nothing a hosted panel measures goes into them.
    expect(splitterRange('control', geometry({})).min).toBe(340)
    expect(splitterRange('front', geometry({})).min).toBe(340)
    expect(splitterRange('front', geometry({ split: true })).min).toBe(640)
    // The panel's floor sits on the panel, never on its host: the pane and the panes' tracks keep shrinking to 0, the
    // chat zone's column is the splitter's width, so a wider panel overflows its host rather than widening it.
    expect(declarations(HOSTS.pane.file, HOSTS.pane.selectors)['min-width']).toBe('min-content')
    expect(declarations('ChatDeck.vue', '.dm-cdeck__pane')['min-width']).toBe('0')
    expect(declarations('ChatDeck.vue', ".dm-cdeck__panes[data-split='true']")).toMatchObject({
      'grid-template-columns': 'minmax(0, 1fr) minmax(0, 1fr)'
    })
    expect(declarations('ValleApp.vue', '.dm-valle__body')['grid-template-columns']).toBe(
      '56px minmax(0, 1fr) 12px var(--chat-w)'
    )
    expect(declarations('ValleApp.vue', '.dm-valle__chats')['min-width']).toBe('0')
  })
})
