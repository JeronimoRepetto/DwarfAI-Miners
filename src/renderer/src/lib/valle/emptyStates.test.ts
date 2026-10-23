import { describe, expect, it } from 'vitest'
import { BORIN, DAIN, EREBOR, MORIA } from '../veta/testing/vetaFixtures'
import {
  DECK_EMPTY_TEXT,
  STACK_EMPTY_TEXT,
  emptyStates,
  stepEmptyState,
  type EmptyInput,
  type EmptySurface
} from './emptyStates'
import { NO_PINS, stepPins, type PinInput, type PinSet } from './pins'

/*
 * 07 machine 38 `ValleEmptyState` (ISSUE-310; US-VALLE-014, US-VALLE-015; UC-063; ADR-024 item 4): what the chat zone
 * and the mosaic show with nothing to show. Pure reads of the pins and the mosaic order; nothing is stored.
 */

function pinned(...inputs: PinInput[]): PinSet {
  let set = NO_PINS
  for (const input of inputs) {
    const step = stepPins(set, input)
    if (!step.ok) throw new Error(JSON.stringify(input))
    set = step.set
  }
  return set
}

describe('machine 38 diagram conformance', () => {
  it('[S38.01, S38.02, S38.03, S38.04, S38.05, S38.06] the stack, deck and mosaic empty states follow the pins and the mosaic order', () => {
    // [*] → stack-empty (S38.01), deck-empty (S38.03), mosaic-empty (S38.05): nothing pinned, no column.
    expect(emptyStates(NO_PINS, [])).toEqual({
      stack: 'stack-empty',
      deck: 'deck-empty',
      mosaic: 'mosaic-empty'
    })
    expect(STACK_EMPTY_TEXT).toBe('Click a dwarf, in any mine, to pin its chat here.')
    expect(DECK_EMPTY_TEXT).toBe('No chats pinned. Click a dwarf in the mine to open one.')

    // S38.02 and S38.04: a dwarf clicked fills the stack and the deck; S38.06: a column added fills the mosaic.
    const one = pinned({ kind: 'click', dwarfId: BORIN, mineId: MORIA })
    expect(emptyStates(one, [MORIA])).toEqual({
      stack: 'stack-populated',
      deck: 'deck-populated',
      mosaic: 'mosaic-populated'
    })
    const clicked: EmptyInput = { kind: 'dwarf-clicked' }
    const added: EmptyInput = { kind: 'column-added' }
    expect(stepEmptyState('stack', true, clicked)).toEqual({ ok: true, id: 'S38.02', empty: false })
    expect(stepEmptyState('deck', true, clicked)).toEqual({ ok: true, id: 'S38.04', empty: false })
    expect(stepEmptyState('mosaic', true, added)).toEqual({ ok: true, id: 'S38.06', empty: false })

    // S38.01 and S38.03: the last pin removed (S29.11) empties both; S38.05: the last column closed (S32.03).
    const two = pinned(
      { kind: 'click', dwarfId: BORIN, mineId: MORIA },
      { kind: 'click', dwarfId: DAIN, mineId: EREBOR }
    )
    const afterFirst = stepPins(two, { kind: 'unpin', key: BORIN })
    if (!afterFirst.ok) throw new Error('refused')
    // One pin left: still populated, and the step is not a listed transition (the pin set only shrank).
    expect(emptyStates(afterFirst.set, [MORIA]).stack).toBe('stack-populated')
    expect(
      stepEmptyState('stack', false, { kind: 'pin-removed', remaining: afterFirst.set.pins.length })
    ).toEqual({ ok: false, reason: 'not-listed' })
    const afterLast = stepPins(afterFirst.set, { kind: 'unpin', key: DAIN })
    if (!afterLast.ok) throw new Error('refused')
    expect(emptyStates(afterLast.set, [])).toEqual({
      stack: 'stack-empty',
      deck: 'deck-empty',
      mosaic: 'mosaic-empty'
    })
    const last: EmptyInput = { kind: 'pin-removed', remaining: afterLast.set.pins.length }
    expect(stepEmptyState('stack', false, last)).toEqual({ ok: true, id: 'S38.01', empty: true })
    expect(stepEmptyState('deck', false, last)).toEqual({ ok: true, id: 'S38.03', empty: true })
    expect(stepEmptyState('mosaic', false, { kind: 'column-closed', remaining: 0 })).toEqual({
      ok: true,
      id: 'S38.05',
      empty: true
    })

    // V-03: pins of other mines are tabs too, so the deck is empty only with no pin at all; an open Add panel is a pin.
    expect(
      emptyStates(pinned({ kind: 'click', dwarfId: DAIN, mineId: EREBOR }), [MORIA]).deck
    ).toBe('deck-populated')
    expect(emptyStates(pinned({ kind: 'add-open', mineId: EREBOR }), []).stack).toBe(
      'stack-populated'
    )
  })

  it('[ADR-024] a transition not listed in 07 machine 38 is rejected', () => {
    const inputs: EmptyInput[] = [
      { kind: 'dwarf-clicked' },
      { kind: 'pin-removed', remaining: 0 },
      { kind: 'pin-removed', remaining: 2 },
      { kind: 'column-added' },
      { kind: 'column-closed', remaining: 0 },
      { kind: 'column-closed', remaining: 3 }
    ]
    const surfaces: EmptySurface[] = ['stack', 'deck', 'mosaic']
    const listed: string[] = []
    for (const surface of surfaces) {
      for (const empty of [true, false]) {
        for (const input of inputs) {
          const step = stepEmptyState(surface, empty, input)
          if (step.ok)
            listed.push(`${surface} ${empty ? 'empty' : 'populated'} ${input.kind} → ${step.id}`)
        }
      }
    }
    // Exactly the six transitions of the table; every other (surface, state, input) triple is refused.
    expect(listed).toEqual([
      'stack empty dwarf-clicked → S38.02',
      'stack populated pin-removed → S38.01',
      'deck empty dwarf-clicked → S38.04',
      'deck populated pin-removed → S38.03',
      'mosaic empty column-added → S38.06',
      'mosaic populated column-closed → S38.05'
    ])
    expect(stepEmptyState('stack', true, { kind: 'column-added' })).toEqual({
      ok: false,
      reason: 'not-listed'
    })
  })
})
