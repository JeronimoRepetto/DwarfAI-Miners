import { describe, expect, it } from 'vitest'
import {
  createVetaLife,
  deriveLifeState,
  entranceIntent,
  stepLifeState,
  type VetaLife
} from './lifeState'
import {
  BORIN,
  DAIN,
  EREBOR,
  frame,
  MORIA,
  NALI,
  dwarfWire,
  mineWire,
  type VetaSnapshotData
} from './testing/vetaFixtures'

/*
 * ISSUE-287 (TC-287-01): Veta's life state, 07 machine 20, walked against its diagram. The state is derived from the
 * Host facts alone (the `mines` and `dwarfs` read models and `meta.minesEverKnown`); every transition it takes is one
 * 07 lists, named by its id, and no input of the person sets it.
 */

function lifeFrom(data: VetaSnapshotData, shown = true): VetaLife {
  const life = createVetaLife()
  if (shown) life.show()
  life.applySnapshot(data)
  return life
}

describe('machine 20 diagram conformance', () => {
  it('[US-VETA-001.AC01, S20.04, S20.08] any working or asking dwarf renders sessions working with the needing chamber lit and marked ?', () => {
    const life = lifeFrom({
      minesEverKnown: true,
      mines: [mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [
        dwarfWire(BORIN, MORIA, { status: 'working' }),
        dwarfWire(DAIN, EREBOR, { status: 'asking', needsYou: true })
      ]
    })
    expect(life.state).toBe('sessions-working')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.04', to: 'sessions-working' })
    expect(life.chambers.map((c) => [c.mine.id, c.attention])).toEqual([
      [MORIA, false],
      [EREBOR, true]
    ])
    // The needing dwarf raises "?": its own status, never one the renderer derives.
    expect(life.chambers[1]?.dwarfs.map((d) => d.status)).toEqual(['asking'])

    // S20.08: from all idle, a dwarf asking lights its chamber; no chamber moves.
    const idle = lifeFrom({
      minesEverKnown: true,
      mines: [mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
    })
    expect(idle.state).toBe('all-idle')
    idle.applyFrame(
      frame(2, 'dwarf.changed', {
        dwarf: dwarfWire(DAIN, EREBOR, { status: 'asking', needsYou: true })
      })
    )
    expect(idle.state).toBe('sessions-working')
    expect(idle.last).toMatchObject({ ok: true, id: 'S20.08', from: 'all-idle' })
    expect(idle.chambers.map((c) => [c.mine.id, c.attention])).toEqual([
      [MORIA, false],
      [EREBOR, true]
    ])
  })

  it('[US-VETA-001.AC02, S20.03, S20.09] dwarfs present with none working or asking render all idle with every chamber', () => {
    const life = lifeFrom({
      minesEverKnown: true,
      mines: [mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [
        dwarfWire(BORIN, MORIA, { status: 'idle' }),
        dwarfWire(DAIN, EREBOR, { status: 'asleep' })
      ]
    })
    expect(life.state).toBe('all-idle')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.03' })
    expect(life.chambers.map((c) => [c.mine.id, c.attention])).toEqual([
      [MORIA, false],
      [EREBOR, false]
    ])

    // S20.09: the last active dwarf rests, and the lamps go out.
    life.applyFrame(
      frame(2, 'dwarf.changed', { dwarf: dwarfWire(BORIN, MORIA, { status: 'working' }) })
    )
    expect(life.state).toBe('sessions-working')
    life.applyFrame(
      frame(3, 'dwarf.changed', { dwarf: dwarfWire(BORIN, MORIA, { status: 'idle' }) })
    )
    expect(life.state).toBe('all-idle')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.09', from: 'sessions-working' })
    expect(life.chambers).toHaveLength(2)
  })

  it('[US-VETA-001.AC03, S20.02, S20.10] no present dwarf in a known mine renders the closed entrance', () => {
    const life = lifeFrom({
      minesEverKnown: true,
      mines: [mineWire(MORIA)],
      dwarfs: [dwarfWire(BORIN, MORIA, { presence: 'walking-out' })]
    })
    expect(life.state).toBe('no-sessions')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.02' })
    expect(life.chambers).toEqual([])
    expect(entranceIntent('no-sessions')).toBe('open-panel')

    // A dwarf resuming after a Host restart, and one listed unrecovered, are present (ADR-032 D7, S2.10).
    expect(
      lifeFrom({
        minesEverKnown: true,
        mines: [mineWire(MORIA)],
        dwarfs: [dwarfWire(BORIN, MORIA, { presence: 'resuming' })]
      }).state
    ).toBe('all-idle')
    expect(
      lifeFrom({
        minesEverKnown: true,
        mines: [mineWire(MORIA)],
        dwarfs: [dwarfWire(BORIN, MORIA, { presence: 'present', processState: 'unrecovered' })]
      }).state
    ).toBe('all-idle')

    // S20.10: the last present dwarf departs.
    const working = lifeFrom({
      minesEverKnown: true,
      mines: [mineWire(MORIA)],
      dwarfs: [dwarfWire(BORIN, MORIA, { status: 'working' })]
    })
    working.applyFrame(
      frame(2, 'dwarf.departed', { dwarfId: BORIN, mineId: MORIA, cause: 'stopped' })
    )
    expect(working.state).toBe('no-sessions')
    expect(working.last).toMatchObject({ ok: true, id: 'S20.10', from: 'sessions-working' })
    expect(working.chambers).toEqual([])
  })

  it('[US-VETA-001.AC04, S20.01, S20.13] no mine ever known renders the entrance with + whose activation asks for the empty mine picker, never the Panel', () => {
    const life = lifeFrom({ minesEverKnown: false, mines: [], dwarfs: [] })
    expect(life.state).toBe('first-run')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.01' })
    expect(life.chambers).toEqual([])
    expect(entranceIntent('first-run')).toBe('open-picker')
    // S20.13: activating the "+" leaves the state as it is.
    expect(stepLifeState('first-run', 'first-run', 'frame')).toMatchObject({
      ok: true,
      id: 'S20.14'
    })
    // Only the closed entrance has an intent: the chambers' states have none.
    expect(entranceIntent('all-idle')).toBeNull()
    expect(entranceIntent('sessions-working')).toBeNull()
  })

  it('[US-VETA-001.AC05, S20.05, S20.06, S20.07, S20.14] the state follows only Host facts; no input sets it', () => {
    const life = lifeFrom({ minesEverKnown: false, mines: [], dwarfs: [] })
    expect(life.state).toBe('first-run')

    // S20.05: the first mine is added; the "+" leaves for good.
    life.applyFrame(frame(2, 'mine.changed', { mine: mineWire(MORIA) }))
    expect(life.state).toBe('no-sessions')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.05', from: 'first-run' })

    // S20.07: an observed dwarf arrives idle.
    life.applyFrame(frame(3, 'dwarf.arrived', { dwarf: dwarfWire(BORIN, MORIA), announce: false }))
    expect(life.state).toBe('all-idle')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.07', from: 'no-sessions' })

    // S20.14: idle to asleep crosses no state.
    life.applyFrame(
      frame(4, 'dwarf.changed', { dwarf: dwarfWire(BORIN, MORIA, { status: 'asleep' }) })
    )
    expect(life.state).toBe('all-idle')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.14' })

    // S20.06: from no sessions, a dwarf arrives working.
    life.applyFrame(frame(5, 'dwarf.departed', { dwarfId: BORIN, mineId: MORIA, cause: 'ended' }))
    expect(life.state).toBe('no-sessions')
    life.applyFrame(
      frame(6, 'dwarf.arrived', {
        dwarf: dwarfWire(DAIN, MORIA, { status: 'working' }),
        announce: true
      })
    )
    expect(life.state).toBe('sessions-working')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.06', from: 'no-sessions' })

    // The person's own acts (showing, hiding the window) never set it, and the same facts give the same state.
    life.hide()
    life.show()
    expect(life.state).toBe('sessions-working')
    expect(
      deriveLifeState({
        minesEverKnown: true,
        mines: [mineWire(MORIA)],
        dwarfs: [dwarfWire(DAIN, MORIA, { status: 'working' })]
      })
    ).toBe('sessions-working')
    // The tracker takes facts only: a snapshot, a frame, a show or a hide.
    expect(Object.keys(life).sort()).toEqual(
      ['applyFrame', 'applySnapshot', 'chambers', 'hide', 'last', 'show', 'shown', 'state'].sort()
    )
  })

  it('[S20.11] a reset that deleted every mine returns to first-run without choreography', () => {
    const life = lifeFrom({
      minesEverKnown: true,
      mines: [mineWire(MORIA)],
      dwarfs: [dwarfWire(BORIN, MORIA, { status: 'working' })]
    })
    expect(life.state).toBe('sessions-working')
    // The re-snapshot after Reset metrics (`resync-required {metrics-reset}`): no mine record is left.
    life.applySnapshot({ minesEverKnown: false, mines: [], dwarfs: [] })
    expect(life.state).toBe('first-run')
    expect(life.last).toEqual({
      ok: true,
      id: 'S20.11',
      from: 'sessions-working',
      to: 'first-run',
      animate: false
    })
  })

  it('[S20.05] removing the last mine keeps minesEverKnown and leads to no-sessions, never first-run', () => {
    const life = lifeFrom({ minesEverKnown: false, mines: [], dwarfs: [] })
    expect(life.state).toBe('first-run')
    life.applyFrame(frame(2, 'mine.changed', { mine: mineWire(MORIA) }))
    expect(life.state).toBe('no-sessions')
    life.applyFrame(frame(3, 'mine.removed', { mineId: MORIA, removedAt: 3 }))
    expect(life.state).toBe('no-sessions')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.14', from: 'no-sessions' })

    // The same when the Host's meta has not caught up yet: a mine the Host holds is a mine ever known.
    const observed = lifeFrom({ minesEverKnown: false, mines: [mineWire(MORIA)], dwarfs: [] })
    expect(observed.state).toBe('no-sessions')
    observed.applyFrame(frame(2, 'mine.removed', { mineId: MORIA, removedAt: 2 }))
    expect(observed.state).toBe('no-sessions')
  })

  it('[S20.17] facts while Veta is not shown are tracked and the next show renders the settled state', () => {
    const life = lifeFrom({ minesEverKnown: true, mines: [mineWire(MORIA)], dwarfs: [] })
    expect(life.state).toBe('no-sessions')
    life.hide()
    expect(life.shown).toBe(false)
    life.applyFrame(
      frame(2, 'dwarf.arrived', {
        dwarf: dwarfWire(BORIN, MORIA, { status: 'working' }),
        announce: true
      })
    )
    life.applyFrame(frame(3, 'dwarf.arrived', { dwarf: dwarfWire(NALI, MORIA), announce: false }))
    // Tracked, with no choreography while hidden.
    expect(life.state).toBe('sessions-working')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.14', animate: false })
    life.applyFrame(frame(4, 'dwarf.departed', { dwarfId: BORIN, mineId: MORIA, cause: 'ended' }))
    expect(life.state).toBe('all-idle')
    expect(life.last).toMatchObject({ ok: true, id: 'S20.09', animate: false })

    // The next show renders the settled state (S20.01–S20.04), still with no choreography.
    life.show()
    expect(life.shown).toBe(true)
    expect(life.state).toBe('all-idle')
    expect(life.last).toEqual({
      ok: true,
      id: 'S20.03',
      from: null,
      to: 'all-idle',
      animate: false
    })
    expect(life.chambers.map((c) => c.dwarfs.map((d) => d.id))).toEqual([[NALI]])
  })

  it('[ADR-025] a transition not listed in 07 machine 20 is rejected', () => {
    // Frames never lead back to first-run: only the re-snapshot after Reset metrics does (S20.11).
    expect(stepLifeState('no-sessions', 'first-run', 'frame')).toEqual({
      ok: false,
      from: 'no-sessions',
      to: 'first-run',
      cause: 'frame'
    })
    expect(stepLifeState('sessions-working', 'first-run', 'frame').ok).toBe(false)
    expect(stepLifeState('all-idle', 'first-run', 'frame').ok).toBe(false)
    expect(stepLifeState('no-sessions', 'first-run', 'snapshot')).toMatchObject({
      ok: true,
      id: 'S20.11'
    })
    // Every listed frame transition is accepted under its own id.
    expect(stepLifeState('first-run', 'no-sessions', 'frame')).toMatchObject({ id: 'S20.05' })
    expect(stepLifeState('first-run', 'sessions-working', 'frame')).toMatchObject({
      id: 'S20.06'
    })
    expect(stepLifeState('first-run', 'all-idle', 'frame')).toMatchObject({ id: 'S20.07' })
    expect(stepLifeState('all-idle', 'no-sessions', 'frame')).toMatchObject({ id: 'S20.10' })

    // A rejected step leaves the state as it was.
    const life = lifeFrom({ minesEverKnown: true, mines: [mineWire(MORIA)], dwarfs: [] })
    expect(life.state).toBe('no-sessions')
  })
})
