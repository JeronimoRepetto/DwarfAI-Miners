import type { DepartureCause, DwarfId, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { createVetaLife } from './lifeState'
import {
  SETTLED,
  VETA_MOTION,
  VETA_WATCHDOG_MARGIN_MS,
  chamberOpenFrames,
  enterFrames,
  fadeOutFrames,
  opensChamber,
  outwardOf,
  partFrames,
  phaseMs,
  stageChambers,
  stepChoreography,
  walkInFrames,
  walkOutFrames,
  watchdogMs,
  type ChoreographyContext,
  type ChoreographyEvent,
  type ChoreographyStep,
  type MotionFrames,
  type VetaChoreography
} from './choreography'
import {
  BORIN,
  DAIN,
  EREBOR,
  FLOI,
  KHAZAD,
  MORIA,
  NALI,
  dwarfWire,
  frame,
  mineWire
} from './testing/vetaFixtures'

/*
 * ISSUE-292 (TC-292-01, TC-292-02, TC-292-03): 07 machine 26, Veta's arrival and departure choreography, pure, and
 * the motion table it plays (`DS/docs/motion.md`, "Veta, no sessions → working" and "Veta, a dwarf arrives or
 * leaves"): the lamp M = 270 ms; parts from 16 px on the anchor side, 50 ms apart, 180 ms each; a new chamber from 8 px,
 * 180 ms; the dwarf's button 14 px over 360 ms, 70 ms apart; the emptied chamber fades 180 ms, then FLIP 180 ms. Every
 * entry eases out, every exit eases in, and each motion's watchdog fires at its duration + 40 ms. Each step is named by
 * its 07 id; a step 07 does not list is rejected and the machine is held.
 */

const SHOWN: ChoreographyContext = { shown: true }
const HIDDEN: ChoreographyContext = { shown: false }

function run(
  events: readonly ChoreographyEvent[],
  context: ChoreographyContext = SHOWN,
  from: VetaChoreography = SETTLED
): { machine: VetaChoreography; steps: ChoreographyStep[] } {
  let machine = from
  const steps: ChoreographyStep[] = []
  for (const event of events) {
    const next = stepChoreography(machine, event, context)
    machine = next.machine
    steps.push(next.step)
  }
  return { machine, steps }
}

const ids = (steps: readonly ChoreographyStep[]): Array<string | null> =>
  steps.map((step) => (step.ok ? step.id : null))
const states = (steps: readonly ChoreographyStep[]): string[] =>
  steps.map((step) => (step.ok ? step.to : `refused:${step.from}`))
const kinds = (step: ChoreographyStep | undefined): string[] =>
  step?.ok === true ? step.effects.map((effect) => effect.kind) : []

const arrived = (
  where: 'closed' | 'drawn' | 'new-chamber' | 'folded',
  dwarfIds: readonly DwarfId[] = [BORIN],
  mineId: MineId = MORIA
): ChoreographyEvent => ({ type: 'arrived', mineId, dwarfIds, where })

const departed = (
  options: { emptied?: boolean; last?: boolean; drawn?: boolean; cause?: DepartureCause } = {},
  dwarfId: DwarfId = BORIN
): ChoreographyEvent => ({
  type: 'departed',
  mineId: MORIA,
  dwarfId,
  cause: options.cause ?? 'stopped',
  drawn: options.drawn ?? true,
  emptied: options.emptied ?? false,
  last: options.last ?? false
})

const DONE: ChoreographyEvent = { type: 'done' }

/** Only `transform` and `opacity` are ever written (`DS/docs/motion.md`, Rules). */
function onlyTransformAndOpacity(frames: MotionFrames): boolean {
  return frames.every((f) =>
    Object.keys(f).every((key) => ['transform', 'opacity', 'offset'].includes(key))
  )
}

describe('machine 26 diagram conformance', () => {
  it('[US-VETA-007.AC01, S26.01, S26.02, S26.03] the first dwarf in No sessions lights the lamp, builds the island at its final size with parts fading in from the anchor side, then walks in', () => {
    const { machine, steps } = run([arrived('closed'), DONE, DONE, DONE])
    expect(ids(steps)).toEqual(['S26.01', 'S26.02', 'S26.03', 'S26.06'])
    expect(states(steps)).toEqual(['lighting', 'building', 'walking-in', 'settled'])
    expect(machine.state).toBe('settled')
    // The window is resized to the final island first, then the lamp lights; the parts build; only then the walk.
    expect(kinds(steps[0])).toEqual(['grow', 'light'])
    expect(kinds(steps[1])).toEqual(['build'])
    expect(kinds(steps[2])).toEqual(['walk-in'])

    // The lamp M = 1.5 × --dur-panel; the parts 180 ms each, 50 ms apart; the dwarfs 360 ms, 70 ms apart.
    expect(VETA_MOTION.lampMs).toBe(270)
    expect(VETA_MOTION.part).toEqual({ fromPx: 16, staggerMs: 50, ms: 180 })
    expect(VETA_MOTION.walkIn).toEqual({ fromPx: 14, ms: 360, staggerMs: 70 })
    expect(phaseMs('lighting', { parts: 0, walkers: 0 }, false)).toBe(270)
    // expand, one chamber, the grip: the last part lands at 2 × 50 + 180 ms.
    expect(phaseMs('building', { parts: 3, walkers: 1 }, false)).toBe(280)
    expect(phaseMs('walking-in', { parts: 3, walkers: 2 }, false)).toBe(430)

    // Anchored at the right end, the anchor side is to the right: each part comes 16 px from there.
    const right = outwardOf(false, true)
    expect(partFrames(right)).toEqual([
      { opacity: 0, transform: 'translate(16px, 0px)' },
      { opacity: 1, transform: 'none' }
    ])
    // Anchored at the top of a side edge, the island grows down: parts come from 16 px above.
    expect(partFrames(outwardOf(true, false))).toEqual([
      { opacity: 0, transform: 'translate(0px, -16px)' },
      { opacity: 1, transform: 'none' }
    ])
    expect(onlyTransformAndOpacity(partFrames(right))).toBe(true)
    expect(VETA_MOTION.easeOut).toBe('cubic-bezier(0.2, 0.7, 0.1, 1)')
  })

  it('[US-VETA-007.AC02, US-VETA-007.AC04, S26.04] a dwarf joining a drawn chamber walks in alone and the anchor corner never moves', () => {
    const { steps } = run([arrived('drawn', [DAIN]), DONE])
    expect(ids(steps)).toEqual(['S26.04', 'S26.06'])
    // The window grows first (to the final island, anchor fixed); then only that dwarf's button walks in.
    expect(steps[0]).toEqual({
      ok: true,
      id: 'S26.04',
      from: 'settled',
      to: 'walking-in',
      effects: [{ kind: 'grow' }, { kind: 'walk-in', mineId: MORIA, dwarfIds: [DAIN] }]
    })
    // It walks in from the chamber's far end: 14 px away from the anchor (left of a right-anchored strip).
    const right = outwardOf(false, true)
    expect(walkInFrames(right)).toEqual([
      { opacity: 0, transform: 'translate(-14px, 0px)' },
      { opacity: 1, transform: 'none' }
    ])
    expect(walkInFrames(outwardOf(false, false))).toEqual([
      { opacity: 0, transform: 'translate(14px, 0px)' },
      { opacity: 1, transform: 'none' }
    ])
    expect(onlyTransformAndOpacity(walkInFrames(right))).toBe(true)

    // The staged strip holds the arrival back until the window has grown: nothing in the chamber moves meanwhile.
    const facts = [
      {
        mine: mineWire(MORIA),
        dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, MORIA)],
        attention: false
      }
    ]
    expect(stageChambers(facts, { hidden: new Set([DAIN]), leaving: [] })).toEqual([
      { mine: mineWire(MORIA), dwarfs: [dwarfWire(BORIN, MORIA)], attention: false }
    ])
    expect(stageChambers(facts, { hidden: new Set(), leaving: [] })).toEqual(facts)
  })

  it('[US-VETA-007.AC03, S26.05, S26.18] a mine with no chamber opens one at its far end, or folds into +N when four are drawn or there is no room', () => {
    const opened = run([arrived('new-chamber', [NALI], KHAZAD), DONE, DONE])
    expect(ids(opened.steps)).toEqual(['S26.05', 'S26.05', 'S26.06'])
    expect(states(opened.steps)).toEqual(['opening-chamber', 'walking-in', 'settled'])
    expect(kinds(opened.steps[0])).toEqual(['grow', 'open-chamber'])
    expect(kinds(opened.steps[1])).toEqual(['walk-in'])
    // The new chamber fades in from 8 px on the anchor side, over --dur-panel.
    expect(VETA_MOTION.chamberOpen).toEqual({ fromPx: 8, ms: 180 })
    expect(chamberOpenFrames(outwardOf(false, true))).toEqual([
      { opacity: 0, transform: 'translate(8px, 0px)' },
      { opacity: 1, transform: 'none' }
    ])

    // Folded: the count updates and no walk is drawn.
    const folded = run([arrived('folded', [NALI], KHAZAD)])
    expect(folded.steps).toEqual([
      {
        ok: true,
        id: 'S26.18',
        from: 'settled',
        to: 'settled',
        effects: [{ kind: 'grow' }, { kind: 'fold', mineId: KHAZAD }]
      }
    ])

    // Room for one more: fewer than four drawn and the island still fits the edge (40k + 18 px a chamber).
    const room = { drawnCrews: [1, 1], folded: false, available: 1200, vertical: false }
    expect(opensChamber(room, 1)).toBe(true)
    expect(opensChamber({ ...room, drawnCrews: [1, 1, 1, 1] }, 1)).toBe(false)
    // 4 + 72 + 2 × 58 = 192 px today; one more chamber of one makes 250 px.
    expect(opensChamber({ ...room, available: 250 }, 1)).toBe(true)
    expect(opensChamber({ ...room, available: 249 }, 1)).toBe(false)

    // The new chamber opens last in the mine order, at the far end, even for a mine the Host listed first.
    const life = createVetaLife()
    life.applySnapshot({
      minesEverKnown: true,
      mines: [mineWire(KHAZAD), mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
    })
    life.show()
    expect(life.chambers.map((c) => c.mine.id)).toEqual([MORIA, EREBOR])
    life.applyFrame(frame(11, 'dwarf.arrived', { dwarf: dwarfWire(NALI, KHAZAD), announce: true }))
    expect(life.chambers.map((c) => c.mine.id)).toEqual([MORIA, EREBOR, KHAZAD])
  })

  it('[US-VETA-007.AC06, S26.06] a walking-in dwarf plays its idle sheet and starts its status sheet on arrival, start-working first when it works', () => {
    const { steps } = run([arrived('drawn', [DAIN, FLOI]), DONE])
    // The walk-in is the idle sheet's (the walk effect names the walkers); the arrival starts their status sheets.
    expect(kinds(steps[0])).toEqual(['grow', 'walk-in'])
    expect(steps[1]).toEqual({
      ok: true,
      id: 'S26.06',
      from: 'walking-in',
      to: 'settled',
      effects: [{ kind: 'status-sheet', dwarfIds: [DAIN, FLOI] }]
    })
  })

  it('[US-VETA-008.AC01, S26.07] a departing dwarf walks out away from the anchor while fading, whatever the cause', () => {
    for (const cause of ['stopped', 'closed-elsewhere', 'mine-removed'] as const) {
      const { steps } = run([departed({ cause })])
      expect(steps[0]).toEqual({
        ok: true,
        id: 'S26.07',
        from: 'settled',
        to: 'walking-out',
        effects: [
          { kind: 'chat', dwarfId: BORIN, cause },
          { kind: 'walk-out', mineId: MORIA, dwarfId: BORIN }
        ]
      })
    }
    // 14 px away from the anchor, fading out, eased in, over 360 ms.
    expect(VETA_MOTION.walkOut).toEqual({ toPx: 14, ms: 360 })
    expect(walkOutFrames(outwardOf(false, true))).toEqual([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translate(-14px, 0px)' }
    ])
    expect(walkOutFrames(outwardOf(true, true))).toEqual([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translate(0px, -14px)' }
    ])
    expect(VETA_MOTION.easeIn).toBe('cubic-bezier(0.5, 0, 0.9, 0.3)')
    expect(phaseMs('walking-out', { parts: 0, walkers: 1 }, false)).toBe(360)
    // A dwarf folded into "+N" is not drawn: no walk.
    expect(ids(run([departed({ drawn: false })]).steps)).toEqual([null])
  })

  it('[US-VETA-008.AC02, S26.08, S26.11] the last dwarf of a chamber leaving closes the chamber and what lay beyond slides back', () => {
    const { steps } = run([departed({ emptied: true }), DONE, DONE])
    expect(ids(steps)).toEqual(['S26.07', 'S26.08', 'S26.11'])
    expect(states(steps)).toEqual(['walking-out', 'closing-chamber', 'settled'])
    expect(steps[1]).toMatchObject({
      effects: [{ kind: 'close-chamber', mineId: MORIA, slideBack: true }]
    })
    // The window shrinks after the motion, never during it.
    expect(kinds(steps[2])).toEqual(['shrink'])
    expect(VETA_MOTION.chamberClose).toEqual({ ms: 180 })
    expect(fadeOutFrames()).toEqual([{ opacity: 1 }, { opacity: 0 }])
    // The fade, then the FLIP of what lay beyond.
    expect(phaseMs('closing-chamber', { parts: 0, walkers: 0 }, false)).toBe(360)

    // A chamber that keeps dwarfs only narrows: what lies beyond slides back, then the window shrinks (S26.09).
    const narrowed = run([departed(), DONE])
    expect(ids(narrowed.steps)).toEqual(['S26.07', 'S26.09'])
    expect(kinds(narrowed.steps[1])).toEqual(['slide-back', 'shrink'])

    // The departed dwarf stays drawn where it stood until its walk-out has ended.
    const facts = [{ mine: mineWire(MORIA), dwarfs: [dwarfWire(DAIN, MORIA)], attention: false }]
    const leaving = [{ dwarf: dwarfWire(BORIN, MORIA), mine: mineWire(MORIA), chamberAt: 0, at: 0 }]
    expect(stageChambers(facts, { hidden: new Set(), leaving })).toEqual([
      {
        mine: mineWire(MORIA),
        dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, MORIA)],
        attention: false
      }
    ])
    // The chamber it emptied is drawn again, at its place in the order, until it has closed.
    const emptied = [
      { mine: mineWire(EREBOR), dwarfs: [dwarfWire(DAIN, EREBOR)], attention: false }
    ]
    expect(stageChambers(emptied, { hidden: new Set(), leaving }).map((c) => c.mine.id)).toEqual([
      MORIA,
      EREBOR
    ])
  })

  it('[US-VETA-008.AC03, S26.10, S20.10] the last dwarf anywhere leaving contracts the strip to No sessions', () => {
    const { machine, steps } = run([departed({ emptied: true, last: true }), DONE, DONE, DONE])
    expect(ids(steps)).toEqual(['S26.07', 'S26.08', 'S26.10', 'S26.11'])
    expect(states(steps)).toEqual(['walking-out', 'closing-chamber', 'contracting', 'settled'])
    // Nothing lies beyond the last chamber that could slide back: the strip contracts to the closed entrance.
    expect(steps[1]).toMatchObject({
      effects: [{ kind: 'close-chamber', mineId: MORIA, slideBack: false }]
    })
    expect(kinds(steps[2])).toEqual(['contract'])
    expect(kinds(steps[3])).toEqual(['shrink'])
    expect(machine).toEqual(SETTLED)
    // The entrance comes back where it stands (the prototype's `showEntrance`, `DM.motion.enter(entrance, 'none')`).
    expect(VETA_MOTION.contract).toEqual({ ms: 140 })
    expect(enterFrames()).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(phaseMs('closing-chamber', { parts: 0, walkers: 0, last: true }, false)).toBe(180)
  })

  it('[US-VETA-008.AC04, S26.17] a silent dwarf whose process runs never walks out', () => {
    const { machine, steps } = run([{ type: 'silence', dwarfId: BORIN }])
    expect(steps).toEqual([{ ok: true, id: 'S26.17', from: 'settled', to: 'settled', effects: [] }])
    expect(machine).toEqual(SETTLED)
  })

  it('[S26.12, S26.13, S26.14, S26.16] reduced motion and the watchdog apply end states at once; a departure during a walk-in resolves it then walks out; no choreography while Veta is not shown', () => {
    // Reduced motion: from any animated state straight to settled, the end state applied, the window shrunk after.
    for (const into of [
      [arrived('closed')],
      [arrived('closed'), DONE],
      [arrived('new-chamber')],
      [arrived('drawn')],
      [departed()],
      [departed({ emptied: true })],
      [departed({ emptied: true, last: true }), DONE, DONE]
    ]) {
      const { machine, steps } = run([...into, { type: 'reduced' }])
      expect(steps.at(-1)).toMatchObject({ ok: true, id: 'S26.12', to: 'settled' })
      expect(kinds(steps.at(-1))).toEqual(['end-state', 'shrink'])
      expect(machine).toEqual(SETTLED)
    }
    // Under reduced motion every duration reads 0 ms.
    for (const state of [
      'lighting',
      'building',
      'opening-chamber',
      'walking-in',
      'walking-out',
      'closing-chamber',
      'contracting'
    ] as const) {
      expect(phaseMs(state, { parts: 4, walkers: 3 }, true)).toBe(0)
    }

    // The watchdog, or the window going hidden: the end state at once.
    for (const type of ['watchdog', 'hidden'] as const) {
      const { steps } = run([arrived('drawn'), { type }])
      expect(steps.at(-1)).toMatchObject({
        ok: true,
        id: 'S26.13',
        from: 'walking-in',
        to: 'settled'
      })
      expect(kinds(steps.at(-1))).toEqual(['end-state', 'shrink'])
    }
    expect(VETA_WATCHDOG_MARGIN_MS).toBe(40)
    expect(watchdogMs('walking-in', { parts: 0, walkers: 1 }, false)).toBe(400)
    expect(watchdogMs('lighting', { parts: 0, walkers: 0 }, false)).toBe(310)
    // Nothing is animating in settled: neither ends anything.
    expect(ids(run([{ type: 'watchdog' }]).steps)).toEqual([null])

    // A departure of a dwarf still walking in: the walk-in resolves at once, then the walk-out plays.
    const cut = run([arrived('drawn', [DAIN]), departed({}, DAIN)])
    expect(cut.steps[1]).toEqual({
      ok: true,
      id: 'S26.14',
      from: 'walking-in',
      to: 'walking-out',
      effects: [
        { kind: 'resolve-walk-in', dwarfIds: [DAIN] },
        { kind: 'chat', dwarfId: DAIN, cause: 'stopped' },
        { kind: 'walk-out', mineId: MORIA, dwarfId: DAIN }
      ]
    })
    // Another dwarf's departure during the walk-in is not S26.14: it waits for the walk to settle.
    expect(ids(run([arrived('drawn', [DAIN]), departed({}, NALI)]).steps)).toEqual(['S26.04', null])

    // Veta not the shown mode: no choreography, the settled layout is committed for the next show.
    expect(run([arrived('closed')], HIDDEN).steps).toEqual([
      { ok: true, id: 'S26.16', from: 'settled', to: 'settled', effects: [{ kind: 'commit' }] }
    ])
    expect(run([departed({ emptied: true, last: true })], HIDDEN).steps).toEqual([
      {
        ok: true,
        id: 'S26.16',
        from: 'settled',
        to: 'settled',
        effects: [{ kind: 'chat', dwarfId: BORIN, cause: 'stopped' }, { kind: 'commit' }]
      }
    ])
  })

  it('[ADR-025] a transition not listed in 07 machine 26 is rejected', () => {
    // `done` in settled, an arrival during a walk-out, a second lamp while lighting: none is a 07 transition.
    const refused = [
      run([DONE]),
      run([departed(), arrived('drawn', [DAIN])]),
      run([arrived('closed'), arrived('closed', [DAIN])]),
      run([arrived('new-chamber'), departed({}, DAIN)])
    ]
    for (const { steps } of refused) {
      const last = steps.at(-1)!
      expect(last.ok).toBe(false)
    }
    // A refused step holds the machine where it was.
    const held = run([arrived('closed'), arrived('closed', [DAIN])])
    expect(held.machine.state).toBe('lighting')
    expect(held.machine.dwarfIds).toEqual([BORIN])
  })
})
