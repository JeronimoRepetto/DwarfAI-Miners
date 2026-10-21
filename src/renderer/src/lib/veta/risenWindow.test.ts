import type { DepartureCause } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  FOLDED,
  RISEN,
  risenGeometry,
  risenHeight,
  stepRisen,
  type RisenContext,
  type RisenEvent,
  type RisenStep,
  type RisenWindow
} from './risenWindow'
import { BORIN, DAIN, EREBOR, MORIA, NALI } from './testing/vetaFixtures'

/*
 * ISSUE-290 (TC-290-01…TC-290-04): 07 machine 24, the risen window above the Veta strip, pure. Each step is named by its
 * 07 id and lists the effects the Veta renderer carries out in order; a step 07 does not list is rejected and the
 * machine is held. The geometry is the design's (DS/docs/screens/veta.md, Layout and "Numbers written in the scripts").
 */

const FREE: RisenContext = { dragging: false }

/** Runs events from a machine, collecting each step. */
function run(
  events: readonly RisenEvent[],
  from: RisenWindow = FOLDED,
  context: RisenContext = FREE
): { machine: RisenWindow; steps: RisenStep[] } {
  let machine = from
  const steps: RisenStep[] = []
  for (const event of events) {
    const next = stepRisen(machine, event, context)
    machine = next.machine
    steps.push(next.step)
  }
  return { machine, steps }
}

const ids = (steps: readonly RisenStep[]): Array<string | null> =>
  steps.map((step) => (step.ok ? step.id : null))

const kinds = (step: RisenStep | undefined): string[] =>
  step !== undefined && step.ok ? step.effects.map((effect) => effect.kind) : []

const hit = (dwarfId = BORIN, mineId = MORIA): RisenEvent => ({
  type: 'dwarf-hit',
  dwarfId,
  mineId
})

/** A chat risen on Borin in Moria. */
const RISEN_BORIN: RisenWindow = run([hit(), { type: 'motion-done' }]).machine

describe('machine 24 diagram conformance', () => {
  it('[US-VETA-005.AC02, S24.01, S24.02] a click, Enter or Space on a dwarf rises its chat anchored to that dwarf and focuses the composer, or the question card while it asks', () => {
    const rising = run([hit()])
    expect(ids(rising.steps)).toEqual(['S24.01'])
    expect(rising.machine).toEqual({
      state: 'rising',
      content: { kind: 'chat', dwarfId: BORIN, mineId: MORIA }
    })
    // The window grows first, then the session store learns the open chat and the draft comes back, then it rises.
    expect(rising.steps[0]).toMatchObject({
      ok: true,
      from: 'folded',
      to: 'rising',
      effects: [
        { kind: 'layout-rise', dwarfId: BORIN },
        { kind: 'open-chat', dwarfId: BORIN, mineId: MORIA },
        { kind: 'motion', motion: 'rise' }
      ]
    })

    const risen = run([{ type: 'motion-done' }], rising.machine)
    expect(ids(risen.steps)).toEqual(['S24.02'])
    expect(risen.machine.state).toBe('risen-chat')
    // The composer takes the keyboard, or the question card's first option while the dwarf asks (the panel's own).
    expect(risen.steps[0]).toMatchObject({ effects: [{ kind: 'focus', target: 'chat' }] })

    // Guard: no rise from a press that became a drag.
    expect(ids(run([hit()], FOLDED, { dragging: true }).steps)).toEqual([null])
  })

  it('[US-VETA-005.AC03, S24.08, S24.09] an outside click or Esc folds the chat and keeps its draft', () => {
    for (const event of [{ type: 'outside' }, { type: 'esc', renaming: false }] as const) {
      const folding = run([event], RISEN_BORIN)
      expect(ids(folding.steps)).toEqual(['S24.08'])
      expect(folding.machine.state).toBe('folding')
      // The draft and the chat view state go to the session store before the fold plays.
      expect(folding.steps[0]).toMatchObject({
        effects: [
          { kind: 'keep', dwarfId: BORIN },
          { kind: 'motion', motion: 'fold' }
        ]
      })
      const folded = run([{ type: 'motion-done' }], folding.machine)
      expect(ids(folded.steps)).toEqual(['S24.09'])
      expect(folded.machine).toEqual(FOLDED)
      // The window shrinks only after the fold, then the store forgets the risen chat.
      expect(kinds(folded.steps[0])).toEqual(['layout-fold', 'closed'])
    }
    // A press on the open dwarf itself is a press outside the window: the strip is outside it.
    expect(ids(run([hit()], RISEN_BORIN).steps)).toEqual(['S24.08'])
  })

  it('[S24.08] with the rename field active the first Esc cancels the rename and the second folds', () => {
    const { machine, steps } = run(
      [
        { type: 'esc', renaming: true },
        { type: 'esc', renaming: false }
      ],
      RISEN_BORIN
    )
    // The first Esc is the rename field's own: no fold.
    expect(ids(steps)).toEqual([null, 'S24.08'])
    expect(machine.state).toBe('folding')
  })

  it("[US-VETA-005.AC05, S24.10, INV-113] the dwarf's process closing makes the chat read-only and drops its draft", () => {
    const causes: DepartureCause[] = [
      'stopped',
      'closed-elsewhere',
      'crashed',
      'recovery-failed',
      'recovery-dismissed'
    ]
    for (const cause of causes) {
      const gone = run([{ type: 'departed', dwarfId: BORIN, cause }], RISEN_BORIN)
      expect(ids(gone.steps)).toEqual(['S24.10'])
      expect(gone.machine).toEqual({
        state: 'read-only',
        content: { kind: 'chat', dwarfId: BORIN, mineId: MORIA }
      })
      expect(gone.steps[0]).toMatchObject({ effects: [{ kind: 'drop-draft', dwarfId: BORIN }] })
      // Folding a read-only chat keeps nothing: its draft is gone for good.
      const folding = run([{ type: 'outside' }], gone.machine)
      expect(ids(folding.steps)).toEqual(['S24.08'])
      expect(kinds(folding.steps[0])).toEqual(['motion'])
    }
    // Another dwarf departing changes nothing here.
    expect(
      ids(run([{ type: 'departed', dwarfId: DAIN, cause: 'stopped' }], RISEN_BORIN).steps)
    ).toEqual([null])
  })

  it("[US-VETA-005.AC06, S24.11] the dwarf's mine being removed closes the chat outright", () => {
    const closing = run([{ type: 'departed', dwarfId: BORIN, cause: 'mine-removed' }], RISEN_BORIN)
    expect(ids(closing.steps)).toEqual(['S24.11'])
    expect(closing.machine.state).toBe('folding')
    // Nothing kept: no draft, no view, and no read-only chat.
    expect(kinds(closing.steps[0])).toEqual(['drop-draft', 'motion'])
    expect(run([{ type: 'motion-done' }], closing.machine).machine).toEqual(FOLDED)
    // From read-only too.
    const readOnly = run(
      [{ type: 'departed', dwarfId: BORIN, cause: 'stopped' }],
      RISEN_BORIN
    ).machine
    expect(
      ids(run([{ type: 'departed', dwarfId: BORIN, cause: 'mine-removed' }], readOnly).steps)
    ).toEqual(['S24.11'])
  })

  it("[S24.03, S24.04, S24.06, S24.07] the Add panel rises aimed at a mine, turns into the new dwarf's chat on launch, and shows a failure inside itself", () => {
    const rising = run([{ type: 'add', mineId: EREBOR }])
    expect(ids(rising.steps)).toEqual(['S24.03'])
    expect(rising.machine).toEqual({ state: 'rising', content: { kind: 'add', mineId: EREBOR } })
    expect(rising.steps[0]).toMatchObject({
      effects: [
        { kind: 'layout-add', mineId: EREBOR },
        { kind: 'open-add', mineId: EREBOR },
        { kind: 'motion', motion: 'rise' }
      ]
    })
    const risen = run([{ type: 'motion-done' }], rising.machine)
    expect(ids(risen.steps)).toEqual(['S24.04'])
    expect(risen.machine.state).toBe('risen-add')
    expect(risen.steps[0]).toMatchObject({ effects: [{ kind: 'focus', target: 'add' }] })

    // A launch that failed keeps the panel, which shows the failure itself.
    const failed = run([{ type: 'launch-failed' }], risen.machine)
    expect(ids(failed.steps)).toEqual(['S24.07'])
    expect(failed.machine.state).toBe('risen-add')
    expect(kinds(failed.steps[0])).toEqual([])

    // The launch sent from it succeeds: the panel becomes the new dwarf's chat in the same place.
    const launched = run([{ type: 'launched', dwarfId: NALI }], failed.machine)
    expect(ids(launched.steps)).toEqual(['S24.06'])
    expect(launched.machine).toEqual({
      state: 'risen-chat',
      content: { kind: 'chat', dwarfId: NALI, mineId: EREBOR }
    })
    expect(launched.steps[0]).toMatchObject({
      effects: [{ kind: 'open-chat', dwarfId: NALI, mineId: EREBOR }]
    })

    // The Add panel's mine removed: it closes outright.
    expect(ids(run([{ type: 'mine-removed', mineId: EREBOR }], risen.machine).steps)).toEqual([
      'S24.11'
    ])
    expect(ids(run([{ type: 'mine-removed', mineId: MORIA }], risen.machine).steps)).toEqual([null])
  })

  it("[S24.05] another dwarf's click flushes the old draft and view, re-anchors at opacity 0 and fades in", () => {
    const replacing = run([hit(DAIN, MORIA)], RISEN_BORIN)
    expect(ids(replacing.steps)).toEqual(['S24.05'])
    expect(replacing.machine).toEqual({
      state: 'replacing',
      content: { kind: 'chat', dwarfId: DAIN, mineId: MORIA }
    })
    expect(replacing.steps[0]).toMatchObject({
      effects: [
        { kind: 'keep', dwarfId: BORIN },
        { kind: 'motion', motion: 'veil' },
        { kind: 'layout-rise', dwarfId: DAIN },
        { kind: 'open-chat', dwarfId: DAIN, mineId: MORIA },
        { kind: 'motion', motion: 'replace' }
      ]
    })
    const replaced = run([{ type: 'motion-done' }], replacing.machine)
    expect(ids(replaced.steps)).toEqual(['S24.05'])
    expect(replaced.machine.state).toBe('risen-chat')
    // From the Add panel, and from a read-only chat, as well; a read-only chat keeps nothing.
    const add = run([{ type: 'add', mineId: EREBOR }, { type: 'motion-done' }]).machine
    expect(ids(run([hit(DAIN)], add).steps)).toEqual(['S24.05'])
    const readOnly = run(
      [{ type: 'departed', dwarfId: BORIN, cause: 'crashed' }],
      RISEN_BORIN
    ).machine
    const fromReadOnly = run([hit(DAIN)], readOnly)
    expect(ids(fromReadOnly.steps)).toEqual(['S24.05'])
    expect(kinds(fromReadOnly.steps[0])).toEqual(['motion', 'layout-rise', 'open-chat', 'motion'])
  })

  it('[S24.14, S24.15, S24.16, S24.17, S24.21] drag, display loss or hiding fold at once; a reveal rises the chat or brings only the mine; a refused rise shows nothing; a crash loses drafts', () => {
    // S24.14: at once, no motion; the draft kept; after a drag UI main already forgot the room.
    const dragged = run([{ type: 'interrupt', why: 'drag' }], RISEN_BORIN)
    expect(ids(dragged.steps)).toEqual(['S24.14'])
    expect(dragged.machine).toEqual(FOLDED)
    expect(kinds(dragged.steps[0])).toEqual(['keep', 'closed'])
    for (const why of ['display', 'hidden'] as const) {
      const gone = run([{ type: 'interrupt', why }], RISEN_BORIN)
      expect(ids(gone.steps)).toEqual(['S24.14'])
      expect(kinds(gone.steps[0])).toEqual(['keep', 'layout-fold', 'closed'])
    }
    // Mid-rise and read-only too; a read-only chat keeps nothing.
    expect(ids(run([{ type: 'interrupt', why: 'hidden' }], run([hit()]).machine).steps)).toEqual([
      'S24.14'
    ])
    const readOnly = run(
      [{ type: 'departed', dwarfId: BORIN, cause: 'stopped' }],
      RISEN_BORIN
    ).machine
    expect(kinds(run([{ type: 'interrupt', why: 'hidden' }], readOnly).steps[0])).toEqual([
      'layout-fold',
      'closed'
    ])

    // S24.15: a reveal for a present dwarf rises its chat as a click does.
    const revealed = run([{ type: 'reveal', mineId: MORIA, dwarfId: BORIN, present: true }])
    expect(ids(revealed.steps)).toEqual(['S24.15'])
    expect(kinds(revealed.steps[0])).toEqual(['layout-rise', 'open-chat', 'motion'])
    // S24.16: the dwarf left, or none was named: only its mine is brought into view.
    for (const event of [
      { type: 'reveal', mineId: MORIA, dwarfId: BORIN, present: false },
      { type: 'reveal', mineId: MORIA, dwarfId: null, present: false }
    ] as const) {
      const mineOnly = run([event])
      expect(ids(mineOnly.steps)).toEqual(['S24.16'])
      expect(mineOnly.machine).toEqual(FOLDED)
      expect(mineOnly.steps[0]).toMatchObject({ effects: [{ kind: 'bring-mine', mineId: MORIA }] })
    }

    // S24.17: the window could not grow: nothing shows, and the refusal is logged.
    const refused = run([hit(), { type: 'refused' }])
    expect(ids(refused.steps)).toEqual(['S24.01', 'S24.17'])
    expect(refused.machine).toEqual(FOLDED)
    expect(kinds(refused.steps[1])).toEqual(['log-refused'])

    // S24.21: the UI process gone, the next start is folded with nothing kept.
    for (const from of [RISEN_BORIN, readOnly, run([hit()]).machine]) {
      const lost = run([{ type: 'lost' }], from)
      expect(ids(lost.steps)).toEqual(['S24.21'])
      expect(lost.machine).toEqual(FOLDED)
      expect(kinds(lost.steps[0])).toEqual([])
    }
  })

  it('[ADR-025] a transition not listed in 07 machine 24 is rejected', () => {
    const rejected: Array<[RisenWindow, RisenEvent]> = [
      [FOLDED, { type: 'outside' }],
      [FOLDED, { type: 'esc', renaming: false }],
      [FOLDED, { type: 'motion-done' }],
      [FOLDED, { type: 'launched', dwarfId: NALI }],
      [FOLDED, { type: 'refused' }],
      [RISEN_BORIN, { type: 'add', mineId: EREBOR }],
      [RISEN_BORIN, { type: 'launched', dwarfId: NALI }],
      [RISEN_BORIN, { type: 'reveal', mineId: MORIA, dwarfId: DAIN, present: true }],
      [run([hit()]).machine, { type: 'outside' }],
      [run([hit()]).machine, hit(DAIN)]
    ]
    for (const [from, event] of rejected) {
      const { machine, steps } = run([event], from)
      expect(steps[0], `${from.state} ${event.type}`).toEqual({
        ok: false,
        from: from.state,
        event: event.type
      })
      expect(machine).toBe(from)
    }
    // Hover and a near miss open nothing: no transition, no effect (S24.19, S24.20).
    expect(run([{ type: 'hover', dwarfId: BORIN }]).steps[0]).toMatchObject({
      id: 'S24.19',
      effects: []
    })
    expect(run([{ type: 'near-miss' }]).steps[0]).toMatchObject({ id: 'S24.20', effects: [] })
  })

  it('[BR-21] the geometry is 444 px wide, 360 to 600 px tall from the room, 14 px from the strip, at least 12 px inside the stage and centred on the dwarf, on every edge', () => {
    expect(RISEN).toMatchObject({ width: 444, gap: 14, inset: 12, pointerEnd: 18 })
    // Height: the room beside the strip less 40 px, held between 360 and 600 px.
    expect(risenHeight('bottom', { width: 2560, height: 1392 }, 52)).toBe(600)
    expect(risenHeight('top', { width: 1280, height: 500 }, 52)).toBe(408)
    expect(risenHeight('bottom', { width: 1280, height: 300 }, 52)).toBe(360)
    // On a side edge the room is the stage's height.
    expect(risenHeight('left', { width: 1280, height: 500 }, 52)).toBe(460)

    // Bottom edge, anchored at the end: an island 1000 px long ending 16 px before the stage's right side.
    const stage = { width: 2560, height: 1392 }
    const bottom = { edge: 'bottom', end: 'end' } as const
    const island = { length: 1000, thickness: 52, before: 2560 - 16 - 1000, after: 16 }
    // A dwarf 500 px along: the chat is centred on it (its start 500 - 222 = 278), 278 px short of the anchored end.
    const middle = risenGeometry(bottom, stage, island, 500)
    expect(middle).toMatchObject({ width: 444, height: 600, pointer: 222, fromAnchor: 278 })
    // The room UI main grows the window by: from the anchored end to the chat's far side, and the gap and the chat.
    expect(middle.room).toEqual({ width: 1000 - 278, height: 14 + 600 })
    // A dwarf near the anchored end: never past it (the window grows away from the anchor corner, V4), the pointer
    // following the dwarf, at least 18 px from the window's end.
    const nearEnd = risenGeometry(bottom, stage, island, 980)
    expect(nearEnd).toMatchObject({ fromAnchor: 0, pointer: 980 - 556 })
    expect(risenGeometry(bottom, stage, island, 999).pointer).toBe(444 - 18)
    // Near the stage's left side: at least 12 px inside it, the pointer at least 18 px from the window's start.
    const left = risenGeometry(
      { edge: 'bottom', end: 'start' },
      stage,
      { length: 300, thickness: 52, before: 4, after: 2560 - 4 - 300 },
      20
    )
    expect(left).toMatchObject({ fromAnchor: 8, pointer: 18 })
    expect(left.room).toEqual({ width: 8 + 444, height: 614 })

    // Top edge: the same along the edge, the room below the strip.
    expect(risenGeometry({ edge: 'top', end: 'end' }, stage, island, 500).room).toEqual(middle.room)
    // Side edges: centred vertically on the dwarf (here held at the anchored end), 444 px across the edge.
    const side = { width: 1920, height: 1032 }
    const shaft = { length: 300, thickness: 52, before: 1032 - 16 - 300, after: 16 }
    const right = risenGeometry({ edge: 'right', end: 'end' }, side, shaft, 150)
    expect(right).toMatchObject({ width: 444, height: 600, pointer: 450, fromAnchor: 0 })
    expect(right.room).toEqual({ width: 14 + 444, height: 600 })
    expect(risenGeometry({ edge: 'left', end: 'end' }, side, shaft, 150).room).toEqual(right.room)
  })
})

// APPENDED for ISSUE-293: the hand-offs out of and into the risen window (07 S24.12, S24.18; UC-051).
describe('machine 24 hand-offs (ISSUE-293)', () => {
  it("[S24.12, S24.18] Open in the Panel asks for the Panel on the chat's mine and dwarf, and a chat carried into Veta rises as a click does", () => {
    const handoff = run([{ type: 'open-in-panel' }], RISEN_BORIN)
    expect(ids(handoff.steps)).toEqual(['S24.12'])
    expect(handoff.steps[0]).toMatchObject({
      effects: [{ kind: 'move-to-panel', mineId: MORIA, dwarfId: BORIN }]
    })
    // The chat stays where it is until the window hides: the run carries it, the hide folds it (S24.14).
    expect(handoff.machine).toEqual(RISEN_BORIN)

    const arrived = run([{ type: 'arrive', mineId: MORIA, dwarfId: BORIN, present: true }])
    expect(ids(arrived.steps)).toEqual(['S24.18'])
    expect(kinds(arrived.steps[0])).toEqual(['layout-rise', 'open-chat', 'motion'])
    expect(arrived.machine).toEqual({
      state: 'rising',
      content: { kind: 'chat', dwarfId: BORIN, mineId: MORIA }
    })

    // Neither applies elsewhere: no hand-off from a chat that is not live, and nothing rises over an open window or
    // for a dwarf no longer in its mine.
    const readOnly = run(
      [{ type: 'departed', dwarfId: BORIN, cause: 'stopped' }],
      RISEN_BORIN
    ).machine
    const rejected: Array<[RisenWindow, RisenEvent]> = [
      [FOLDED, { type: 'open-in-panel' }],
      [readOnly, { type: 'open-in-panel' }],
      [RISEN_BORIN, { type: 'arrive', mineId: MORIA, dwarfId: DAIN, present: true }],
      [FOLDED, { type: 'arrive', mineId: MORIA, dwarfId: BORIN, present: false }]
    ]
    for (const [from, event] of rejected) {
      expect(run([event], from).steps[0], `${from.state} ${event.type}`).toEqual({
        ok: false,
        from: from.state,
        event: event.type
      })
    }
  })
})
