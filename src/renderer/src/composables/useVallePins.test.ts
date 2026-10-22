import type { DwarfWire, MineWire, UiPreferencesMap, UiSessionPatch } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { addKey } from '../lib/valle/pins'
import type { ValleFact } from '../lib/valle/valleReadModel'
import {
  BORIN,
  DAIN,
  EREBOR,
  FLOI,
  MORIA,
  NALI,
  dwarfWire,
  mineWire
} from '../lib/veta/testing/vetaFixtures'
import { useVallePins, type VallePinsBridge, type VallePinsWrite } from './useVallePins'
import { VALLE_STORE_DEFAULTS, type ValleStores } from './useValleStores'

/*
 * Valle's pinned chats wired to UI main (ISSUE-302; 07 machine 29; 14 A-N18, A-N21; ADR-024 items 1, 4): the set opens
 * once the Host's facts are read, every change writes the chat pins whole through A-N21 and the session's Valle fields
 * through A-N18, and the Host's departures reach the pins. The bridge and the read model are hand-written fakes.
 */

function fakeBridge(failFirstWrite = false) {
  const writes: VallePinsWrite['value'][] = []
  const patches: UiSessionPatch[] = []
  let fail = failFirstWrite
  const bridge: VallePinsBridge = {
    setUiPreference: (write) => {
      if (fail) {
        fail = false
        return Promise.reject(new Error('the store could not write'))
      }
      writes.push(write.value)
      return Promise.resolve(write)
    },
    patchUiSession: (patch) => {
      patches.push(patch)
    }
  }
  return { bridge, writes, patches }
}

function fakeModel(dwarfs: DwarfWire[], mines: MineWire[] = [mineWire(MORIA), mineWire(EREBOR)]) {
  const listeners = new Set<(facts: readonly ValleFact[]) => void>()
  return {
    dwarfs: shallowRef<readonly DwarfWire[]>(dwarfs),
    mines: shallowRef<readonly MineWire[]>(mines),
    askOf: () => null,
    onFacts(listener: (facts: readonly ValleFact[]) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    hear(facts: ValleFact[]) {
      for (const listener of [...listeners]) listener(facts)
    }
  }
}

function setUp(
  over: Partial<ValleStores>,
  dwarfs: DwarfWire[],
  opts: { failFirstWrite?: boolean; talkedLast?: string } = {}
) {
  const fake = fakeBridge(opts.failFirstWrite)
  const model = fakeModel(dwarfs)
  const stores = shallowRef<ValleStores>({ ...VALLE_STORE_DEFAULTS, ...over })
  const factsRead = shallowRef(false)
  const scope = effectScope()
  const pins = scope.run(() =>
    useVallePins({
      bridge: fake.bridge,
      stores,
      model,
      factsRead,
      talkedLast: () => (opts.talkedLast ?? null) as never
    })
  )!
  return { ...fake, model, stores, factsRead, pins, scope }
}

const keys = (pins: ReturnType<typeof setUp>['pins']): string[] =>
  pins.set.value.pins.map((pin) => pin.key)

describe('the Valle pins wired to UI main (ISSUE-302)', () => {
  // TC-302-02: a first visit with no stored pins.
  it('[S29.01] a first visit with no stored pins pins the waiting dwarfs, oldest first, then the chat talked to last, the first waiting one focused', async () => {
    const t = setUp(
      { pins: null },
      [
        dwarfWire(BORIN, MORIA),
        dwarfWire(DAIN, EREBOR, { status: 'asking', needsYou: true, askedAt: 20 }),
        dwarfWire(NALI, MORIA, { status: 'asking', needsYou: true, askedAt: 10 })
      ],
      { talkedLast: BORIN }
    )
    expect(t.pins.set.value.pins).toEqual([])
    t.factsRead.value = true
    await nextTick()
    expect(keys(t.pins)).toEqual([NALI, DAIN, BORIN])
    expect(t.pins.set.value.focus).toBe(NALI)
    expect(t.writes).toEqual([
      [
        { dwarfId: NALI, mineId: MORIA, order: 0 },
        { dwarfId: DAIN, mineId: EREBOR, order: 1 },
        { dwarfId: BORIN, mineId: MORIA, order: 2 }
      ]
    ])
    expect(t.patches).toContainEqual({ kind: 'open-chat', host: 'valle', dwarfId: NALI })
    expect(t.pins.views.value.map((view) => view.text.line)).toEqual([
      '? asking',
      '? asking',
      'idle'
    ])
    t.scope.stop()
  })

  it('[S29.02] a stored pin set opens restored, and the restore writes nothing', async () => {
    const stored: UiPreferencesMap['pins'] = [
      { dwarfId: DAIN, mineId: EREBOR, order: 1 },
      { dwarfId: BORIN, mineId: MORIA, order: 0 }
    ]
    const t = setUp({ pins: stored }, [dwarfWire(BORIN, MORIA)])
    t.factsRead.value = true
    await nextTick()
    expect(t.pins.set.value.pins.map((pin) => [pin.key, pin.kind === 'chat' && pin.state])).toEqual(
      [
        [BORIN, 'live'],
        [DAIN, 'gone']
      ]
    )
    expect(t.writes).toEqual([])
    t.scope.stop()
  })

  // TC-302-01: the set moves as machines 18 and 29 say, `pins` persisted at once (chat pins only), focus never dropped.
  it('[S29.08, S29.10, S29.21] every change writes the chat pins through A-N21 and the session fields through A-N18; a failed write is kept in memory and written again with the next change', async () => {
    const t = setUp({ pins: [] }, [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)], {
      failFirstWrite: true
    })
    t.factsRead.value = true
    await nextTick()
    // The first write fails: the set keeps the pin in memory.
    expect(t.pins.send({ kind: 'click', dwarfId: BORIN, mineId: MORIA })).toBe(true)
    await nextTick()
    expect(keys(t.pins)).toEqual([BORIN])
    expect(t.writes).toEqual([])
    // The next change writes the whole set again, the earlier pin included.
    expect(t.pins.send({ kind: 'click', dwarfId: DAIN, mineId: EREBOR })).toBe(true)
    expect(t.writes).toEqual([
      [
        { dwarfId: BORIN, mineId: MORIA, order: 0 },
        { dwarfId: DAIN, mineId: EREBOR, order: 1 }
      ]
    ])
    expect(t.patches).toContainEqual({
      kind: 'valle',
      patch: { focusedPin: DAIN, talkedTo: { [MORIA]: BORIN, [EREBOR]: DAIN } }
    })
    expect(t.patches).toContainEqual({ kind: 'current-mine', host: 'valle', mineId: EREBOR })
    // An unpin writes the pins and moves keyboard focus; it ends nothing.
    expect(t.pins.send({ kind: 'unpin', key: DAIN })).toBe(true)
    expect(t.writes.at(-1)).toEqual([{ dwarfId: BORIN, mineId: MORIA, order: 0 }])
    expect(t.pins.focusRequest.value).toMatchObject({ target: BORIN })
    t.scope.stop()
  })

  it('[US-VALLE-007.AC12, S29.16] an Add pin lives in the session’s valle.addPins only, never in pins', async () => {
    const t = setUp({ pins: [] }, [dwarfWire(BORIN, MORIA)])
    t.factsRead.value = true
    await nextTick()
    expect(t.pins.send({ kind: 'add-open', mineId: EREBOR })).toBe(true)
    expect(keys(t.pins)).toEqual([addKey(EREBOR)])
    expect(t.writes).toEqual([])
    expect(t.patches).toContainEqual({
      kind: 'valle',
      patch: { addPins: [{ mineId: EREBOR, order: 0 }], focusedPin: null }
    })
    expect(t.pins.views.value[0]?.text).toMatchObject({ name: 'New dwarf', line: 'in erebor' })
    t.scope.stop()
  })

  it('[S29.13, S29.14, S29.20] a departure leaves its pin gone, a mine’s removal closes its pins, a fact heard during a drag lands after the drop, and Reset metrics clears the set', async () => {
    const t = setUp(
      {
        pins: [
          { dwarfId: BORIN, mineId: MORIA, order: 0 },
          { dwarfId: DAIN, mineId: EREBOR, order: 1 },
          { dwarfId: NALI, mineId: MORIA, order: 2 }
        ]
      },
      [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR), dwarfWire(NALI, MORIA)]
    )
    t.factsRead.value = true
    await nextTick()
    t.model.hear([{ kind: 'departed', dwarfId: DAIN, mineId: EREBOR, mineRemoved: false }])
    expect(t.pins.views.value.map((view) => [view.key, view.state, view.readOnly])).toEqual([
      [BORIN, 'live', false],
      [DAIN, 'gone', true],
      [NALI, 'live', false]
    ])
    // The gone pin keeps the name this window knew.
    t.model.dwarfs.value = [dwarfWire(BORIN, MORIA), dwarfWire(NALI, MORIA)]
    await nextTick()
    expect(t.pins.views.value[1]?.text.name).toBe('dain')

    // Heard during a drag: applied once the drag ends.
    expect(t.pins.send({ kind: 'drag', key: BORIN })).toBe(true)
    t.model.hear([{ kind: 'mine-removed', mineId: MORIA }])
    expect(keys(t.pins)).toEqual([BORIN, DAIN, NALI])
    expect(t.pins.send({ kind: 'drag-cancel' })).toBe(true)
    expect(keys(t.pins)).toEqual([DAIN])

    // A pinned dwarf that left while the Host was away is gone after the re-snapshot.
    expect(t.pins.send({ kind: 'click', dwarfId: FLOI, mineId: EREBOR })).toBe(true)
    t.model.dwarfs.value = []
    t.model.hear([{ kind: 'snapshot' }])
    expect(t.pins.views.value.map((view) => view.state)).toEqual(['gone', 'gone'])

    // Reset metrics: UI main rewrote the stores; the window reads them again and the set clears.
    t.stores.value = { ...VALLE_STORE_DEFAULTS }
    await nextTick()
    expect(t.pins.set.value.pins).toEqual([])
    t.scope.stop()
  })
})

// APPENDED for ISSUE-301: the dive's real tab order bound to the pin set (07 S29.12; review R8B-16), and how the chat in
// focus was focused, which the dive reads for the dwarf it is for (07 S28.03).
describe('the dive tab order bound to the Valle pins (ISSUE-301)', () => {
  it("[S29.12, US-VALLE-002.AC04, US-VALLE-002.AC09] a dive input carries the real tab order: the Host's waiting dwarfs and crew, and the set's talked-to marks", async () => {
    const t = setUp(
      { pins: null },
      [
        dwarfWire(BORIN, MORIA),
        dwarfWire(DAIN, EREBOR, { status: 'asking', needsYou: true, askedAt: 5 }),
        dwarfWire(NALI, MORIA),
        dwarfWire(FLOI, MORIA, { status: 'asking', needsYou: true, askedAt: 9 })
      ],
      { talkedLast: NALI }
    )
    t.factsRead.value = true
    await nextTick()
    // S29.01: DAIN and FLOI waiting, then NALI talked to last, who counts as Moria's last talked to.
    expect(keys(t.pins)).toEqual([DAIN, FLOI, NALI])
    expect(t.pins.send(t.pins.diveInput(MORIA, null))).toBe(true)
    // Moria's waiting FLOI, then NALI talked to, then the rest of the crew in the Host's order, then Erebor's pin.
    expect(keys(t.pins)).toEqual([FLOI, NALI, BORIN, DAIN])
    expect(t.pins.set.value.focus).toBe(FLOI)
    // A dive for BORIN puts him first.
    expect(t.pins.send(t.pins.diveInput(MORIA, BORIN))).toBe(true)
    expect(keys(t.pins)).toEqual([BORIN, FLOI, NALI, DAIN])
    t.scope.stop()
  })

  it('[S28.03, S29.19, S29.23] the chat in focus reports how it was focused, for the dwarf a dive is for', async () => {
    const t = setUp({ pins: [] }, [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)])
    t.factsRead.value = true
    await nextTick()
    expect(t.pins.focused.value).toBeNull()
    t.pins.send({ kind: 'jump', dwarfId: DAIN, mineId: EREBOR })
    expect(t.pins.focused.value).toEqual({ dwarfId: DAIN, mineId: EREBOR, from: 'queue' })
    t.pins.send({ kind: 'carried', dwarfId: BORIN, mineId: MORIA, present: true })
    expect(t.pins.focused.value).toEqual({ dwarfId: BORIN, mineId: MORIA, from: 'handover' })
    t.pins.send({ kind: 'select', key: DAIN })
    expect(t.pins.focused.value).toEqual({ dwarfId: DAIN, mineId: EREBOR, from: 'other' })
    t.scope.stop()
  })
})
