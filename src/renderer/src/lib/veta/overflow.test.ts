import { describe, expect, it } from 'vitest'
import {
  UNMEASURED,
  VETA_MAX_CHAMBERS,
  VETA_REMEASURE_DEBOUNCE_MS,
  createRemeasure,
  drawnRun,
  islandOf,
  stepOverflow,
  type OverflowEvent,
  type OverflowLayout,
  type OverflowStep,
  type RemeasureTimers,
  type VetaOverflow
} from './overflow'

/*
 * ISSUE-291 (TC-291-01, TC-291-02): 07 machine 25, Veta's overflow "+N" and the wheel, pure. How many chambers fit
 * the edge is the arithmetic of `DS/docs/components.md` (Veta strip, How many chambers fit): 4 px of island padding,
 * expand and grip 36 px each, "+N" 44 px once anything folds (36 px down a side edge), and each chamber at its 1:1
 * length, 40k + 18 px in a row and 42k + 18 px in a shaft. Each step is named by its 07 id; a step 07 does not list is
 * rejected and the machine is held.
 */

/** The design's worked example: 6 mines at work, crews 4, 3, 1, 1, 1, 1, on a bottom edge. */
const SAMPLE_CREWS = [4, 3, 1, 1, 1, 1] as const
const row = (available: number, crews: readonly number[] = SAMPLE_CREWS): OverflowLayout => ({
  crews,
  available,
  vertical: false
})

function run(
  events: readonly OverflowEvent[],
  layout: OverflowLayout,
  from: VetaOverflow = UNMEASURED
): { machine: VetaOverflow; steps: OverflowStep[] } {
  let machine = from
  const steps: OverflowStep[] = []
  for (const event of events) {
    const next = stepOverflow(machine, event, layout)
    machine = next.machine
    steps.push(next.step)
  }
  return { machine, steps }
}

const ids = (steps: readonly OverflowStep[]): Array<string | null> =>
  steps.map((step) => (step.ok ? step.id : null))

/** The mine indices drawn and folded. */
function split(machine: VetaOverflow, total: number): { drawn: number[]; folded: number[] } {
  const { first, count } = drawnRun(machine, total)
  const all = [...Array(total).keys()]
  return {
    drawn: all.filter((i) => i >= first && i < first + count),
    folded: all.filter((i) => i < first || i >= first + count)
  }
}

describe('machine 25 diagram conformance', () => {
  it('[US-VETA-006.AC01, S25.02] more mines than fit draw as many chambers as fit, at most four, and fold the rest into +N', () => {
    // A long edge: four chambers, never five, and the other two fold into "+2" (the 552 px island).
    const wide = run([{ type: 'measure' }], row(1600))
    expect(ids(wide.steps)).toEqual(['S25.02'])
    expect(wide.machine.state).toBe('overflowing')
    expect(split(wide.machine, 6)).toEqual({ drawn: [0, 1, 2, 3], folded: [4, 5] })
    expect(islandOf(row(1600), drawnRun(wide.machine, 6))).toBe(552)
    // Even an endless edge draws at most four.
    expect(split(run([{ type: 'measure' }], row(100_000)).machine, 6).drawn).toHaveLength(
      VETA_MAX_CHAMBERS
    )
    // As many as fit: 494 px holds three (and "+3"), 460 px two (and "+4").
    expect(split(run([{ type: 'measure' }], row(494)).machine, 6)).toEqual({
      drawn: [0, 1, 2],
      folded: [3, 4, 5]
    })
    expect(split(run([{ type: 'measure' }], row(460)).machine, 6)).toEqual({
      drawn: [0, 1],
      folded: [2, 3, 4, 5]
    })
  })

  it('[US-VETA-006.AC05, S25.02] at the narrowest length at least one chamber is drawn while any mine works', () => {
    // 360 px holds only the 298 px island of one chamber and "+5"; a length shorter than any island still draws one.
    for (const available of [360, 298, 120, 1]) {
      const narrow = run([{ type: 'measure' }], row(available))
      expect(ids(narrow.steps)).toEqual(['S25.02'])
      expect(split(narrow.machine, 6)).toEqual({ drawn: [0], folded: [1, 2, 3, 4, 5] })
    }
    // One mine at work on a short edge: its chamber is drawn, and nothing folds.
    const alone = run([{ type: 'measure' }], row(1, [3]))
    expect(alone.machine.state).toBe('fits')
    expect(split(alone.machine, 1)).toEqual({ drawn: [0], folded: [] })
  })

  it('[US-VETA-006.AC07, S25.01] when every mine fits no +N appears', () => {
    const layout = row(1600, [1, 2, 1])
    const fits = run([{ type: 'measure' }], layout)
    expect(ids(fits.steps)).toEqual(['S25.01'])
    expect(fits.machine.state).toBe('fits')
    expect(split(fits.machine, 3)).toEqual({ drawn: [0, 1, 2], folded: [] })
    // No "+N" in the island's length: padding, expand, grip and the three chambers only.
    expect(islandOf(layout, drawnRun(fits.machine, 3))).toBe(4 + 36 + 36 + 58 + 98 + 58)
  })

  it('[US-VETA-006.AC04, S25.03, NFR-PERF-07] a resize, an edge change or a session-count change re-measures, debounced, and never scales a sprite', () => {
    const wide = run([{ type: 'measure' }], row(1600)).machine
    // The stage shrinks to 460 px: two chambers and "+4", each still at its 1:1 length (436 px, not squeezed to 460).
    const resized = run([{ type: 'measure' }], row(460), wide)
    expect(ids(resized.steps)).toEqual(['S25.03'])
    expect(split(resized.machine, 6).drawn).toEqual([0, 1])
    expect(islandOf(row(460), drawnRun(resized.machine, 6))).toBe(436)
    // Back to a long edge: it overflows again with four, and grows the window first.
    const grown = run([{ type: 'measure' }], row(1600), resized.machine)
    expect(ids(grown.steps)).toEqual(['S25.03'])
    expect(grown.steps[0]).toMatchObject({ effects: [{ kind: 'grow', length: 552 }] })
    // An edge change: down a 520 px side edge the chambers are shafts (42k + 18) and "+N" is 36 px.
    const side: OverflowLayout = { crews: SAMPLE_CREWS, available: 520, vertical: true }
    const turned = run([{ type: 'measure' }], side, wide)
    expect(split(turned.machine, 6).drawn).toEqual([0, 1, 2])
    expect(islandOf(side, drawnRun(turned.machine, 6))).toBe(4 + 36 + 36 + 36 + 186 + 144 + 60)
    // A session count change: the second mine's crew left, and everything fits now.
    const fewer = run([{ type: 'measure' }], row(1600, [4, 1, 1]), wide)
    expect(ids(fewer.steps)).toEqual(['S25.03'])
    expect(fewer.machine.state).toBe('fits')
    // Debounced: a run of triggers measures once, the last, after the quiet time.
    const pending: Array<{ run: () => void; ms: number; cleared: boolean }> = []
    const timers: RemeasureTimers = {
      set(run, ms) {
        const entry = { run, ms, cleared: false }
        pending.push(entry)
        return entry
      },
      clear(handle) {
        ;(handle as { cleared: boolean }).cleared = true
      }
    }
    let measured = 0
    const remeasure = createRemeasure(timers, () => {
      measured += 1
    })
    remeasure.request()
    remeasure.request()
    remeasure.request()
    expect(measured).toBe(0)
    const live = pending.filter((entry) => !entry.cleared)
    expect(live).toHaveLength(1)
    expect(live[0]!.ms).toBe(VETA_REMEASURE_DEBOUNCE_MS)
    live[0]!.run()
    expect(measured).toBe(1)
  })

  it('[US-VETA-006.AC03, S25.04, S25.09] the wheel shifts the visible run by one chamber per notch, wrapping, and +N updates; with everything fitting it does nothing', () => {
    const six = row(2000, [1, 1, 1, 1, 1, 1])
    const measured = run([{ type: 'measure' }], six).machine
    const down = { type: 'wheel', delta: 100 } as const
    const up = { type: 'wheel', delta: -100 } as const
    const turned = run([down], six, measured)
    expect(ids(turned.steps)).toEqual(['S25.04'])
    expect(split(turned.machine, 6)).toEqual({ drawn: [1, 2, 3, 4], folded: [0, 5] })
    // One more notch reaches the last run, the next wraps back to the first.
    const last = run([down], six, turned.machine).machine
    expect(split(last, 6)).toEqual({ drawn: [2, 3, 4, 5], folded: [0, 1] })
    expect(split(run([down], six, last).machine, 6).drawn).toEqual([0, 1, 2, 3])
    // The other way wraps from the first run to the last.
    expect(split(run([up], six, measured).machine, 6).drawn).toEqual([2, 3, 4, 5])
    // "+N" updates: crews of different lengths fit a different count once the run moves (460 px holds 4 and 3, but
    // four of 3, 1, 1, 1), and the folded count follows.
    const sample = row(460)
    const before = run([{ type: 'measure' }], sample).machine
    expect(split(before, 6).folded).toHaveLength(4)
    const after = run([down, down], sample, before).machine
    expect(split(after, 6)).toEqual({ drawn: [2, 3, 4, 5], folded: [0, 1] })
    // Everything fits: the wheel does nothing.
    const fits = run([{ type: 'measure' }], row(1600, [1, 1])).machine
    const still = run([down], row(1600, [1, 1]), fits)
    expect(ids(still.steps)).toEqual(['S25.09'])
    expect(still.machine).toEqual(fits)
  })

  it('[S25.08, S25.10, BR-02] a reveal for a folded mine unfolds its chamber after the window grows; a folded mine is not on screen', () => {
    const layout = row(2000, [1, 1, 1, 1, 1, 3])
    const measured = run([{ type: 'measure' }], layout).machine
    // Folded, the sixth mine is not on screen (the drawn set is what `reportVisibleMines` sends).
    expect(split(measured, 6).drawn).not.toContain(5)
    const revealed = run([{ type: 'reveal', index: 5 }], layout, measured)
    expect(ids(revealed.steps)).toEqual(['S25.08'])
    // The window grows for the longer run first, then `layoutVeta {unfold-overflow}`, then the run shifts.
    expect(revealed.steps[0]).toMatchObject({
      effects: [
        { kind: 'grow', length: 4 + 36 + 36 + 44 + 58 * 3 + 138 },
        { kind: 'unfold', index: 5 }
      ]
    })
    expect(split(revealed.machine, 6)).toEqual({ drawn: [2, 3, 4, 5], folded: [0, 1] })
    expect(revealed.machine.state).toBe('overflowing')
    // A reveal for a drawn mine moves nothing and grows nothing.
    const drawn = run([{ type: 'reveal', index: 3 }], layout, revealed.machine)
    expect(ids(drawn.steps)).toEqual(['S25.08'])
    expect(drawn.machine).toEqual(revealed.machine)
    expect(drawn.steps[0]!.ok && drawn.steps[0]!.effects).toEqual([])
  })

  it('[ADR-025] a transition not listed in 07 machine 25 is rejected', () => {
    const layout = row(2000, [1, 1, 1, 1, 1, 1])
    const fits = run([{ type: 'measure' }], row(2000, [1, 1])).machine
    const overflowing = run([{ type: 'measure' }], layout).machine
    const shown = run([{ type: 'enter' }], layout, overflowing).machine
    expect(shown.state).toBe('list-shown')
    const refused: Array<[VetaOverflow, OverflowEvent]> = [
      [fits, { type: 'enter' }],
      [fits, { type: 'leave' }],
      [fits, { type: 'pick', index: 0 }],
      [overflowing, { type: 'leave' }],
      [overflowing, { type: 'pick', index: 5 }],
      [shown, { type: 'enter' }],
      [shown, { type: 'wheel', delta: 100 }],
      [shown, { type: 'reveal', index: 5 }],
      [UNMEASURED, { type: 'wheel', delta: 100 }],
      [UNMEASURED, { type: 'enter' }]
    ]
    for (const [from, event] of refused) {
      const next = stepOverflow(from, event, layout)
      expect(next.step.ok, `${from.state} ${event.type}`).toBe(false)
      expect(next.machine).toBe(from)
    }
    // Tab through the strip is no transition at all (S25.07): "+N" is never a stop, so nothing changes.
    const tabbed = run([{ type: 'tab' }], layout, overflowing)
    expect(ids(tabbed.steps)).toEqual(['S25.07'])
    expect(tabbed.machine).toEqual(overflowing)
    // The listed ones: the list shows on enter, hides on leave, and a pick unfolds (S25.05, S25.06, S25.11).
    expect(ids(run([{ type: 'leave' }], layout, shown).steps)).toEqual(['S25.06'])
    const picked = run([{ type: 'pick', index: 5 }], layout, shown)
    expect(ids(picked.steps)).toEqual(['S25.11'])
    expect(picked.machine.state).toBe('overflowing')
    expect(split(picked.machine, 6).drawn).toContain(5)
  })
})
