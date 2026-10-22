import type { DwarfId, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  BORIN,
  DAIN,
  DWALIN,
  EREBOR,
  FLOI,
  MORIA,
  NALI,
  ORI,
  THRAIN
} from '../veta/testing/vetaFixtures'
import { diveForDwarfId, diveOrder, type DiveFocus, type DiveOrderFacts } from './diveOrder'
import {
  NO_PINS,
  addKey,
  startUpPins,
  stepPins,
  type DiveOrder,
  type PinInput,
  type PinRef,
  type PinSet
} from './pins'
import { splitPanes, stepSplit, type SplitFacts, type SplitSet } from './split'

/*
 * 07 S29.12, the dive's tab order (ISSUE-301; US-VALLE-002.AC02…AC05, AC09; decision "Dive tab order"), and the
 * `diveForDwarfId` rule of S28.03. TC-301-02: any dive's tab order follows S29.12 exactly and its first tab is selected.
 * Moria's crew, in crew order: BORIN, NALI, FLOI, ORI. Erebor's: DAIN, THRAIN.
 */

const MORIA_CREW = [BORIN, NALI, FLOI, ORI]

const chat = (dwarfId: DwarfId, mineId: MineId): PinRef => ({ kind: 'chat', dwarfId, mineId })
const keyOf = (ref: PinRef): string => (ref.kind === 'chat' ? ref.dwarfId : addKey(ref.mineId))

/** Moria's facts: nobody waiting, nobody talked to, its whole crew, unless told otherwise. */
const moria = (over: Partial<DiveOrderFacts> = {}): DiveOrderFacts => ({
  needing: [],
  talkedTo: null,
  crew: MORIA_CREW,
  ...over
})

/** The order of a dive into Moria over `pins`, as keys. */
function ordered(
  pins: readonly PinRef[],
  forDwarfId: DwarfId | null,
  facts: DiveOrderFacts
): string[] {
  return diveOrder({ pins, mineId: MORIA, forDwarfId }, facts).map(keyOf)
}

/** The dive input `useVallePins` binds: the real order over `facts`. */
const dive = (mineId: MineId, forDwarfId: DwarfId | null, facts: DiveOrderFacts): PinInput => {
  const order: DiveOrder = (input) => diveOrder(input, facts)
  return { kind: 'dive', mineId, forDwarfId, order }
}

function step(set: PinSet, input: PinInput): PinSet {
  const stepped = stepPins(set, input)
  if (!stepped.ok) throw new Error(`refused: ${JSON.stringify(input)}`)
  return stepped.set
}

const click = (dwarfId: DwarfId, mineId: MineId): PinInput => ({ kind: 'click', dwarfId, mineId })

describe('the dive tab order (S29.12)', () => {
  it('[US-VALLE-002.AC02, S29.12] a dive for a dwarf pins that dwarf’s chat first', () => {
    const pins = [chat(DAIN, EREBOR), chat(BORIN, MORIA)]
    const facts = moria({ needing: [{ dwarfId: FLOI, askedAt: 5 }], talkedTo: BORIN })
    expect(ordered(pins, NALI, facts)[0]).toBe(NALI)
    // Applied by the pin set: NALI pinned, first, and selected.
    const set = step(
      step(step(NO_PINS, click(DAIN, EREBOR)), click(BORIN, MORIA)),
      dive(MORIA, NALI, facts)
    )
    expect(set.pins.map((pin) => pin.key)[0]).toBe(NALI)
    expect(set.focus).toBe(NALI)

    // The dwarf a dive is for: the chat in focus, focused from the needs-you queue, handed over from the Panel or
    // Veta, or picked with a named dwarf, and of this mine (S28.03).
    const focus = (from: DiveFocus['from'], mineId: MineId = MORIA): DiveFocus => ({
      dwarfId: NALI,
      mineId,
      from
    })
    expect(diveForDwarfId(focus('queue'), MORIA)).toBe(NALI)
    expect(diveForDwarfId(focus('handover'), MORIA)).toBe(NALI)
    expect(diveForDwarfId(focus('named-pick'), MORIA)).toBe(NALI)
    // Clicked there in Valle, of another mine, or no chat in focus: the dive is for nobody.
    expect(diveForDwarfId(focus('other'), MORIA)).toBeNull()
    expect(diveForDwarfId(focus('queue', EREBOR), MORIA)).toBeNull()
    expect(diveForDwarfId(null, MORIA)).toBeNull()
  })

  it('[US-VALLE-002.AC03] with no such dwarf the order starts with the mine’s needing dwarfs, oldest question first', () => {
    const facts = moria({
      needing: [
        { dwarfId: ORI, askedAt: 9 },
        { dwarfId: FLOI, askedAt: 3 }
      ],
      talkedTo: BORIN
    })
    expect(ordered([chat(DAIN, EREBOR)], null, facts).slice(0, 2)).toEqual([FLOI, ORI])
  })

  it('[US-VALLE-002.AC04] then the rest follow: needing dwarfs, the one last talked to, the crew in crew order, then pins of other mines, the first selected', () => {
    const facts = moria({
      needing: [
        { dwarfId: ORI, askedAt: 9 },
        { dwarfId: FLOI, askedAt: 3 }
      ],
      talkedTo: NALI
    })
    const pins = [chat(DAIN, EREBOR), chat(ORI, MORIA), chat(THRAIN, EREBOR)]
    expect(ordered(pins, null, facts)).toEqual([FLOI, ORI, NALI, BORIN, DAIN, THRAIN])
    // With a dwarf the dive is for, the needing dwarfs not already placed follow it.
    expect(ordered(pins, ORI, facts)).toEqual([ORI, FLOI, NALI, BORIN, DAIN, THRAIN])

    // Moria's own pins that are not its crew (a gone chat, the Add panel) follow the crew, in their order; the other
    // mines' pins keep their relative order. Applied by the pin set, every crew member is pinned, the first selected.
    let set = step(NO_PINS, click(THRAIN, EREBOR))
    set = step(set, { kind: 'add-open', mineId: MORIA })
    set = step(set, click(DWALIN, MORIA))
    set = step(set, { kind: 'departed', dwarfId: DWALIN, mineRemoved: false })
    set = step(set, click(DAIN, EREBOR))
    const dived = stepPins(set, dive(MORIA, null, facts))
    expect(dived.ok && dived.id).toBe('S29.12')
    if (!dived.ok) return
    expect(dived.set.pins.map((pin) => pin.key)).toEqual([
      FLOI,
      ORI,
      NALI,
      BORIN,
      addKey(MORIA),
      DWALIN,
      THRAIN,
      DAIN
    ])
    expect(dived.set.focus).toBe(FLOI)
    // Moria's crew members not pinned before are pinned now, and written with the rest.
    expect(dived.effects).toContainEqual({
      kind: 'write-pins',
      pins: [FLOI, ORI, NALI, BORIN, DWALIN, THRAIN, DAIN].map((dwarfId) => ({
        dwarfId,
        mineId: [THRAIN, DAIN].includes(dwarfId) ? EREBOR : MORIA,
        order: [FLOI, ORI, NALI, BORIN, addKey(MORIA), DWALIN, THRAIN, DAIN].indexOf(dwarfId)
      }))
    })
  })

  it('[US-VALLE-002.AC09] with no chat focused since Valle opened the start-up pin counts as last talked to', () => {
    // S29.01: DAIN waits in Erebor; NALI of Moria was talked to last before Valle opened.
    const opened = startUpPins({
      needsYou: [{ dwarfId: DAIN, mineId: EREBOR, askedAt: 1 }],
      talkedLast: { dwarfId: NALI, mineId: MORIA }
    })
    expect(opened.set.focus).toBe(DAIN)
    // The first dive into Moria reads "talked to" from the set, as `useVallePins` binds it.
    const talkedTo = opened.set.talkedTo[MORIA] ?? null
    expect(talkedTo).toBe(NALI)
    const set = step(opened.set, dive(MORIA, null, moria({ talkedTo })))
    expect(set.pins.map((pin) => pin.key)).toEqual([NALI, BORIN, FLOI, ORI, DAIN])
  })

  it('[US-VALLE-002.AC05, S30.07] with a split on, the chat of the first pane keeps the second pane if still pinned, else the next tab takes it', () => {
    const splitFacts = (set: PinSet): SplitFacts => ({
      pins: set.pins.map((pin) => ({
        key: pin.key,
        dwarfId: pin.kind === 'chat' ? pin.dwarfId : null,
        needs: false
      })),
      focus: set.focus,
      room: 900
    })
    // DAIN of Erebor in the first pane, THRAIN beside it.
    const before = step(step(NO_PINS, click(THRAIN, EREBOR)), click(DAIN, EREBOR))
    const split: SplitSet = { state: 'on', panes: [DAIN, THRAIN], pane: 0 }

    // A dive into Moria for NALI: NALI takes the first pane, DAIN, still pinned, the second.
    const dived = step(before, dive(MORIA, NALI, moria()))
    const kept = stepSplit(split, { kind: 'follow', before: DAIN }, splitFacts(dived))
    expect(kept.ok && splitPanes(kept.set, dived.focus)).toEqual([NALI, DAIN])

    // A dive whose first tab is the chat the first pane showed: the next tab in the new order takes the second pane.
    const own = step(
      before,
      dive(EREBOR, DAIN, { needing: [], talkedTo: null, crew: [DAIN, THRAIN] })
    )
    const next = stepSplit(split, { kind: 'follow', before: DAIN }, splitFacts(own))
    expect(own.pins.map((pin) => pin.key)).toEqual([DAIN, THRAIN])
    expect(next.ok && splitPanes(next.set, own.focus)).toEqual([DAIN, THRAIN])
  })
})
