import type { DwarfId, DwarfStatus, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { BORIN, DAIN, EREBOR, FLOI, MORIA, NALI } from '../veta/testing/vetaFixtures'
import { isChatReadOnly } from './pinnedChat'
import {
  NO_PINS,
  addKey,
  arrowTarget,
  pinText,
  restoredPins,
  startUpPins,
  stepPins,
  type DiveOrder,
  type Pin,
  type PinEffect,
  type PinInput,
  type PinSet,
  type PinTextFacts
} from './pins'

/*
 * 07 machine 29 `PinSetState` (ISSUE-302; US-VALLE-007; ADR-024 items 1, 4; INV-117): the pin set, its focus and its
 * order, stepped one input at a time. Each step names the 07 transition taken and the effects the window carries out:
 * the `pins` write (A-N21, chat pins only), the session's Valle fields (A-N18), and where keyboard focus goes.
 */

/** Steps every input in turn; each must be taken. */
function run(
  set: PinSet,
  ...inputs: PinInput[]
): { set: PinSet; ids: string[]; effects: PinEffect[][] } {
  const ids: string[] = []
  const effects: PinEffect[][] = []
  for (const input of inputs) {
    const step = stepPins(set, input)
    if (!step.ok) throw new Error(`refused: ${JSON.stringify(input)}`)
    ids.push(step.id)
    effects.push([...step.effects])
    set = step.set
  }
  return { set, ids, effects }
}

const click = (dwarfId: DwarfId, mineId: MineId): PinInput => ({ kind: 'click', dwarfId, mineId })
const keys = (set: PinSet): string[] => set.pins.map((pin) => pin.key)
const writes = (effects: readonly PinEffect[]) => effects.filter((e) => e.kind === 'write-pins')

/** Three chat pins, BORIN and NALI of Moria, DAIN of Erebor, BORIN in focus. */
const three = (): PinSet =>
  run(NO_PINS, click(BORIN, MORIA), click(DAIN, EREBOR), click(NALI, MORIA), {
    kind: 'select',
    key: BORIN
  }).set

describe('machine 29 diagram conformance', () => {
  it('[US-VALLE-007.AC01, S29.03, S29.04] clicking a dwarf not yet pinned pins its chat and focuses it', () => {
    const first = run(NO_PINS, click(BORIN, MORIA))
    expect(first.ids).toEqual(['S29.03'])
    expect(first.set.pins).toEqual([
      { kind: 'chat', key: BORIN, dwarfId: BORIN, mineId: MORIA, state: 'live' }
    ])
    expect(first.set.focus).toBe(BORIN)
    expect(first.effects[0]).toEqual([
      { kind: 'write-pins', pins: [{ dwarfId: BORIN, mineId: MORIA, order: 0 }] },
      { kind: 'session', patch: { focusedPin: BORIN, talkedTo: { [MORIA]: BORIN } } },
      { kind: 'open-chat', dwarfId: BORIN },
      { kind: 'current-mine', mineId: MORIA }
    ])

    // Not yet pinned: appended last and focused; the previously focused one collapses (it is no longer the focus).
    const second = run(first.set, click(DAIN, EREBOR))
    expect(second.ids).toEqual(['S29.04'])
    expect(keys(second.set)).toEqual([BORIN, DAIN])
    expect(second.set.focus).toBe(DAIN)
    expect(writes(second.effects[0]!)).toEqual([
      {
        kind: 'write-pins',
        pins: [
          { dwarfId: BORIN, mineId: MORIA, order: 0 },
          { dwarfId: DAIN, mineId: EREBOR, order: 1 }
        ]
      }
    ])
  })

  it('[US-VALLE-007.AC02, S29.05] clicking a pinned dwarf moves focus only, with no second pin', () => {
    const set = three()
    const again = run(set, click(DAIN, EREBOR))
    expect(again.ids).toEqual(['S29.05'])
    expect(keys(again.set)).toEqual([BORIN, DAIN, NALI])
    expect(again.set.focus).toBe(DAIN)
    // Focus moved: the session hears it; the stored pins are unchanged, so nothing is written.
    expect(writes(again.effects[0]!)).toEqual([])
    // Only the fields that changed are patched: Erebor's talked-to dwarf was DAIN already.
    expect(again.effects[0]).toContainEqual({ kind: 'session', patch: { focusedPin: DAIN } })
  })

  it('[US-VALLE-007.AC03, S29.10] ×, a middle click or Delete/Backspace unpins while the session keeps running', () => {
    // ×, a middle click and Delete/Backspace all reach the set as one `unpin` input (the gestures are ChatDeck's and
    // PinnedStack's own); the pin goes, the pins are written, and nothing ends, stops or touches the dwarf's session.
    const unpinned = run(three(), { kind: 'unpin', key: DAIN })
    expect(unpinned.ids).toEqual(['S29.10'])
    expect(keys(unpinned.set)).toEqual([BORIN, NALI])
    expect(unpinned.set.focus).toBe(BORIN)
    expect(unpinned.effects[0]).toEqual([
      {
        kind: 'write-pins',
        pins: [
          { dwarfId: BORIN, mineId: MORIA, order: 0 },
          { dwarfId: NALI, mineId: MORIA, order: 1 }
        ]
      },
      { kind: 'keyboard-focus', target: NALI }
    ])
  })

  it('[US-VALLE-007.AC04, S29.10, S29.11] a keyboard unpin moves focus to the next, else the previous, else the deck or stack, never dropped', () => {
    const set = three()
    // The focused pin goes: focus moves to the one that took its place, the next.
    const next = run(set, { kind: 'unpin', key: BORIN })
    expect(next.set.focus).toBe(DAIN)
    expect(next.effects[0]).toContainEqual({ kind: 'keyboard-focus', target: DAIN })
    // The last one in the row goes: focus moves to the one before it.
    const previous = run(next.set, { kind: 'select', key: NALI }, { kind: 'unpin', key: NALI })
    expect(previous.ids).toEqual(['S29.05', 'S29.10'])
    expect(previous.set.focus).toBe(DAIN)
    expect(previous.effects[1]).toContainEqual({ kind: 'keyboard-focus', target: DAIN })
    // The only pin goes: the set is empty and focus moves to the deck or stack itself.
    const last = run(previous.set, { kind: 'unpin', key: DAIN })
    expect(last.ids).toEqual(['S29.11'])
    expect(last.set.pins).toEqual([])
    expect(last.set.focus).toBeNull()
    expect(last.effects[0]).toEqual([
      { kind: 'write-pins', pins: [] },
      { kind: 'session', patch: { focusedPin: null } },
      { kind: 'open-chat', dwarfId: null },
      { kind: 'keyboard-focus', target: 'container' }
    ])
  })

  it('[US-VALLE-007.AC05, S29.07, S29.08, S29.09] dragging a tab reorders the strip on drop; a cancelled drag keeps the order', () => {
    // One tab cannot be dragged (guard: ≥ 2 tabs).
    const one = run(NO_PINS, click(BORIN, MORIA)).set
    expect(stepPins(one, { kind: 'drag', key: BORIN })).toEqual({ ok: false, reason: 'not-listed' })

    const set = three()
    const dragged = run(set, { kind: 'drag', key: NALI })
    expect(dragged.ids).toEqual(['S29.07'])
    expect(dragged.set.dragging).toBe(NALI)
    expect(dragged.effects[0]).toEqual([])
    const dropped = run(dragged.set, { kind: 'drop', order: [NALI, BORIN, DAIN] })
    expect(dropped.ids).toEqual(['S29.08'])
    expect(keys(dropped.set)).toEqual([NALI, BORIN, DAIN])
    expect(dropped.set.dragging).toBeNull()
    expect(dropped.effects[0]).toEqual([
      {
        kind: 'write-pins',
        pins: [
          { dwarfId: NALI, mineId: MORIA, order: 0 },
          { dwarfId: BORIN, mineId: MORIA, order: 1 },
          { dwarfId: DAIN, mineId: EREBOR, order: 2 }
        ]
      }
    ])

    const cancelled = run(dropped.set, { kind: 'drag', key: DAIN }, { kind: 'drag-cancel' })
    expect(cancelled.ids).toEqual(['S29.07', 'S29.09'])
    expect(keys(cancelled.set)).toEqual([NALI, BORIN, DAIN])
    expect(cancelled.set.dragging).toBeNull()
    expect(cancelled.effects[1]).toEqual([])
    // A drop with no drag, or an order that is not the strip's own pins, is refused.
    expect(stepPins(cancelled.set, { kind: 'drop', order: [DAIN, NALI, BORIN] }).ok).toBe(false)
    const again = run(cancelled.set, { kind: 'drag', key: DAIN }).set
    expect(stepPins(again, { kind: 'drop', order: [DAIN, NALI] }).ok).toBe(false)
  })

  it('[US-VALLE-007.AC06, US-VALLE-007.AC13, US-VALLE-007.AC14, S29.15] a needing dwarf’s line reads ! permission or ? asking in brass, its tab only ?, and no status reads done', () => {
    const pin: Pin = { kind: 'chat', key: BORIN, dwarfId: BORIN, mineId: MORIA, state: 'live' }
    const facts = (status: DwarfStatus, ask: 'permission' | 'question' | null): PinTextFacts => ({
      dwarf: () => ({ name: 'borin', status, ask }),
      mineName: () => 'moria'
    })
    const permission = pinText(pin, facts('asking', 'permission'))
    expect(permission).toMatchObject({
      name: 'borin',
      line: '! permission',
      tab: '?',
      needs: true,
      lineLabel: 'borin, needs you. Open this chat',
      tabLabel: 'borin, needs you',
      unpinLabel: 'Unpin borin'
    })
    // The ask takes priority over its ordinary status word.
    expect(pinText(pin, facts('working', 'question'))).toMatchObject({
      line: '? asking',
      tab: '?',
      needs: true
    })
    for (const [status, word] of [
      ['working', 'working'],
      ['asleep', 'asleep'],
      ['idle', 'idle']
    ] as const) {
      expect(pinText(pin, facts(status, null))).toMatchObject({
        line: word,
        tab: '',
        needs: false,
        tabLabel: `borin, ${word}`
      })
    }
    // PO #9: whatever the status, nothing reads "done".
    for (const status of ['working', 'asking', 'idle', 'asleep'] as const) {
      for (const ask of ['permission', 'question', null] as const) {
        const text = pinText(pin, facts(status, ask))
        expect(Object.values(text).join(' ')).not.toMatch(/done/i)
      }
    }
  })

  it('[US-VALLE-007.AC12, US-VALLE-007.AC15, S29.16, S29.17, S29.18] an Add panel is a pin reading New dwarf in its mine, counted in the head, becoming the dwarf’s chat on launch or removed on ×', () => {
    const opened = run(run(NO_PINS, click(BORIN, MORIA)).set, { kind: 'add-open', mineId: EREBOR })
    expect(opened.ids).toEqual(['S29.16'])
    expect(keys(opened.set)).toEqual([BORIN, addKey(EREBOR)])
    expect(opened.set.focus).toBe(addKey(EREBOR))
    // Counted in the head with every other pin.
    expect(opened.set.pins).toHaveLength(2)
    // Session only (PO #67; R5B-27): `pins` is never written for an Add pin.
    expect(opened.effects[0]).toEqual([
      { kind: 'session', patch: { addPins: [{ mineId: EREBOR, order: 1 }], focusedPin: null } },
      { kind: 'open-chat', dwarfId: null },
      { kind: 'current-mine', mineId: EREBOR }
    ])
    const add = opened.set.pins[1]!
    const text = pinText(add, { dwarf: () => null, mineName: () => 'erebor' })
    expect(text).toMatchObject({
      name: 'New dwarf',
      line: 'in erebor',
      needs: false,
      tabLabel: 'New dwarf, in erebor',
      unpinLabel: 'Unpin New dwarf'
    })

    // The launch sent from it lands: the Add pin becomes the new dwarf's chat in the same place.
    const launched = run(opened.set, { kind: 'launched', mineId: EREBOR, dwarfId: DAIN })
    expect(launched.ids).toEqual(['S29.17'])
    expect(launched.set.pins[1]).toEqual({
      kind: 'chat',
      key: DAIN,
      dwarfId: DAIN,
      mineId: EREBOR,
      state: 'live'
    })
    expect(launched.set.focus).toBe(DAIN)
    expect(launched.effects[0]).toContainEqual({
      kind: 'write-pins',
      pins: [
        { dwarfId: BORIN, mineId: MORIA, order: 0 },
        { dwarfId: DAIN, mineId: EREBOR, order: 1 }
      ]
    })
    expect(launched.effects[0]).toContainEqual({
      kind: 'session',
      patch: { addPins: [], focusedPin: DAIN, talkedTo: { [MORIA]: BORIN, [EREBOR]: DAIN } }
    })

    // × on the Add pin: removed, nothing launched, nothing written to `pins`.
    const closed = run(opened.set, { kind: 'unpin', key: addKey(EREBOR) })
    expect(closed.ids).toEqual(['S29.18'])
    expect(keys(closed.set)).toEqual([BORIN])
    expect(writes(closed.effects[0]!)).toEqual([])
    expect(closed.effects[0]).toContainEqual({
      kind: 'session',
      patch: { addPins: [], focusedPin: BORIN }
    })
  })

  it('[S29.01, S29.14, S29.19, S29.20, S29.21, S29.22, S29.23] start-up pins, mine removal, jumps, Reset metrics, a failed write, a restart and a carried chat follow 07 machine 29', () => {
    // S29.01: the waiting dwarfs, oldest question first, then the chat talked to last; the first waiting one focused;
    // those count as talked to, the one talked to last winning its mine.
    const startUp = startUpPins({
      needsYou: [
        { dwarfId: DAIN, mineId: EREBOR, askedAt: 20 },
        { dwarfId: NALI, mineId: MORIA, askedAt: 10 }
      ],
      talkedLast: { dwarfId: BORIN, mineId: MORIA }
    })
    expect(startUp.id).toBe('S29.01')
    expect(keys(startUp.set)).toEqual([NALI, DAIN, BORIN])
    expect(startUp.set.focus).toBe(NALI)
    expect(startUp.effects).toContainEqual({
      kind: 'session',
      patch: { focusedPin: NALI, talkedTo: { [MORIA]: BORIN, [EREBOR]: DAIN } }
    })
    // Nothing to pin: the set starts empty, and the store stays never written.
    const none = startUpPins({ needsYou: [], talkedLast: null })
    expect(none.set).toEqual(NO_PINS)
    expect(none.effects).toEqual([])

    // S29.14: a mine removed closes its pins outright; focus to a neighbour.
    const removed = run(startUp.set, { kind: 'mine-removed', mineId: MORIA })
    expect(removed.ids).toEqual(['S29.14'])
    expect(keys(removed.set)).toEqual([DAIN])
    expect(removed.set.focus).toBe(DAIN)
    const departed = run(removed.set, { kind: 'departed', dwarfId: DAIN, mineRemoved: true })
    expect(departed.ids).toEqual(['S29.14'])
    expect(departed.set.pins).toEqual([])

    // S29.19: a jump pins the dwarf if absent, then focuses it; a pinned one is only focused.
    const jumped = run(
      three(),
      { kind: 'jump', dwarfId: FLOI, mineId: EREBOR },
      { kind: 'jump', dwarfId: DAIN, mineId: EREBOR }
    )
    expect(jumped.ids).toEqual(['S29.19', 'S29.19'])
    expect(keys(jumped.set)).toEqual([BORIN, DAIN, NALI, FLOI])
    expect(jumped.set.focus).toBe(DAIN)
    expect(writes(jumped.effects[1]!)).toEqual([])

    // S29.20: Reset metrics clears every pin; UI main already returned the store to never written.
    const reset = run(jumped.set, { kind: 'reset' })
    expect(reset.ids).toEqual(['S29.20'])
    expect(reset.set).toEqual(NO_PINS)
    expect(reset.effects[0]).toEqual([])

    // S29.21: every write carries the whole set, so a change whose write failed is written again with the next one.
    const twice = run(NO_PINS, click(BORIN, MORIA), click(DAIN, EREBOR))
    expect(writes(twice.effects[1]!)).toEqual([
      {
        kind: 'write-pins',
        pins: [
          { dwarfId: BORIN, mineId: MORIA, order: 0 },
          { dwarfId: DAIN, mineId: EREBOR, order: 1 }
        ]
      }
    ])

    // S29.22: what survives a restart is the chat pins and their order, never the focus; restored, focus is the first
    // pin unless the session still names one.
    const written = writes(twice.effects[1]!)[0]!
    expect(
      written.kind === 'write-pins' &&
        written.pins.every((p) => Object.keys(p).sort().join() === 'dwarfId,mineId,order')
    ).toBe(true)
    const restarted = restoredPins(
      [
        { dwarfId: BORIN, mineId: MORIA, state: 'live' },
        { dwarfId: DAIN, mineId: EREBOR, state: 'gone' }
      ],
      {}
    )
    expect(keys(restarted)).toEqual([BORIN, DAIN])
    expect(restarted.focus).toBe(BORIN)
    expect(restarted.pins[1]).toMatchObject({ state: 'gone' })

    // S29.23: a chat carried in from the Panel or Veta, its dwarf present: pinned last, focused, the next dive's for.
    expect(
      stepPins(restarted, { kind: 'carried', dwarfId: NALI, mineId: MORIA, present: false })
    ).toEqual({
      ok: false,
      reason: 'not-listed'
    })
    const carried = run(restarted, { kind: 'carried', dwarfId: NALI, mineId: MORIA, present: true })
    expect(carried.ids).toEqual(['S29.23'])
    expect(keys(carried.set)).toEqual([BORIN, DAIN, NALI])
    expect(carried.set.focus).toBe(NALI)
    expect(carried.effects[0]).toContainEqual({ kind: 'session', patch: { diveForDwarfId: NALI } })
    expect(carried.effects[0]).toContainEqual({ kind: 'current-mine', mineId: MORIA })
    expect(writes(carried.effects[0]!)).toHaveLength(1)
  })

  it('[S29.13] a pinned dwarf that departs for any cause but its mine’s removal keeps its pin, reads gone and its chat turns read-only', () => {
    const gone = run(three(), { kind: 'departed', dwarfId: DAIN, mineRemoved: false })
    expect(gone.ids).toEqual(['S29.13'])
    expect(keys(gone.set)).toEqual([BORIN, DAIN, NALI])
    const pin = gone.set.pins[1]!
    expect(pin).toMatchObject({ kind: 'chat', state: 'gone' })
    expect(pin.kind === 'chat' && isChatReadOnly(pin.state)).toBe(true)
    expect(pinText(pin, { dwarf: () => null, mineName: () => null })).toMatchObject({
      line: 'gone',
      needs: false
    })
    // The stored pin is unchanged: nothing is written.
    expect(gone.effects[0]).toEqual([])
  })

  it('[S29.06] ← and → move between the tabs, wrapping at both ends, and leave the set as it is', () => {
    const set = three()
    expect(arrowTarget(set, BORIN, 'ArrowRight')).toBe(DAIN)
    expect(arrowTarget(set, NALI, 'ArrowRight')).toBe(BORIN)
    expect(arrowTarget(set, BORIN, 'ArrowLeft')).toBe(NALI)
    expect(set.focus).toBe(BORIN)
  })

  it('[S29.12] a dive rebuilds the tab order with the injected order, pinning what it adds, the first tab selected', () => {
    // The order itself is the dive issue's (later: ISSUE-301); here a table stub stands for it.
    const order: DiveOrder = ({ pins, mineId, forDwarfId }) => {
      expect([mineId, forDwarfId]).toEqual([MORIA, NALI])
      return [
        { kind: 'chat', dwarfId: NALI, mineId: MORIA },
        { kind: 'chat', dwarfId: FLOI, mineId: MORIA },
        ...pins.filter((pin) => pin.kind === 'chat' && pin.dwarfId !== NALI)
      ]
    }
    const dived = run(three(), { kind: 'dive', mineId: MORIA, forDwarfId: NALI, order })
    expect(dived.ids).toEqual(['S29.12'])
    expect(keys(dived.set)).toEqual([NALI, FLOI, BORIN, DAIN])
    expect(dived.set.focus).toBe(NALI)
    expect(writes(dived.effects[0]!)).toHaveLength(1)
  })

  it('[ADR-024] a transition not listed in 07 machine 29 is rejected', () => {
    const set = three()
    const dragging = run(set, { kind: 'drag', key: BORIN }).set
    const refused: [PinSet, PinInput][] = [
      [set, { kind: 'select', key: FLOI }],
      [set, { kind: 'unpin', key: FLOI }],
      [NO_PINS, { kind: 'unpin', key: BORIN }],
      [set, { kind: 'drop', order: keys(set) }],
      [set, { kind: 'drag-cancel' }],
      [set, { kind: 'departed', dwarfId: FLOI, mineRemoved: false }],
      [set, { kind: 'launched', mineId: EREBOR, dwarfId: FLOI }],
      [dragging, { kind: 'select', key: DAIN }],
      [dragging, { kind: 'drag', key: DAIN }]
    ]
    for (const [from, input] of refused) {
      expect(stepPins(from, input), JSON.stringify(input)).toEqual({
        ok: false,
        reason: 'not-listed'
      })
    }
  })
})
