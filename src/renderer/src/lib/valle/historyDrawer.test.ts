import type { MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { EREBOR, MORIA } from '../veta/testing/vetaFixtures'
import {
  HISTORY_DRAWER_START,
  historyDrawerMotion,
  historyDrawerPatch,
  stepHistoryDrawer,
  type HistoryDrawerInput,
  type HistoryDrawerState
} from './historyDrawer'

/*
 * 07 machine 36 (UC-061; 17 §1.1 diagram-conformance walk): the mine's history opens as a drawer under the Work front's
 * chat tabs and panes, rising 16 px with a fade; its own close sinks it with a fade; a climb out, leaving Valle or
 * hiding closes it at once; it follows a swap and is session-only. An input the machine does not list is refused
 * (ADR-024).
 */

const opening = (mineId: MineId): HistoryDrawerState => ({ kind: 'opening', mineId })
const open = (mineId: MineId): HistoryDrawerState => ({ kind: 'open', mineId })
const closing = (mineId: MineId): HistoryDrawerState => ({ kind: 'closing', mineId })

/** Each input in turn from `state`, every step taken; answers the last state, the ids and every effect. */
function walk(state: HistoryDrawerState, inputs: readonly HistoryDrawerInput[]) {
  const ids: string[] = []
  const effects: unknown[] = []
  for (const input of inputs) {
    const step = stepHistoryDrawer(state, input)
    if (!step.ok) throw new Error(`refused ${input.kind} from ${state.kind}`)
    ids.push(step.id)
    effects.push(...step.effects)
    state = step.state
  }
  return { state, ids, effects }
}

describe('machine 36 diagram conformance', () => {
  it("[US-VALLE-011.AC01, S36.01, S36.02] opening the mine's history raises a drawer under the tabs and panes from 16 px below with a fade", () => {
    const first = walk(HISTORY_DRAWER_START, [{ kind: 'open', mineId: MORIA, preset: 'front' }])
    expect(first.ids).toEqual(['S36.01'])
    expect(first.state).toEqual(opening(MORIA))
    expect(first.effects).toEqual([{ kind: 'write-session', open: true }, { kind: 'rise' }])
    // The rise: from 16 px below and transparent to its place, over `--dur-panel` with `--ease-out`.
    expect(historyDrawerMotion('rise', false)).toEqual({
      frames: [
        { opacity: 0, transform: 'translateY(16px)' },
        { opacity: 1, transform: 'none' }
      ],
      duration: 180,
      easing: 'cubic-bezier(0.2, 0.7, 0.1, 1)',
      fill: 'backwards'
    })
    // Motion done or its watchdog: open, nothing else to do.
    const risen = walk(first.state, [{ kind: 'risen' }])
    expect(risen.ids).toEqual(['S36.02'])
    expect(risen.state).toEqual(open(MORIA))
    expect(risen.effects).toEqual([])
    // Guard: the Work front only (in the Control room the history shows in the zone, S31.11).
    expect(
      stepHistoryDrawer(HISTORY_DRAWER_START, { kind: 'open', mineId: MORIA, preset: 'control' }).ok
    ).toBe(false)
    // Reduced motion: every duration token reads 0 ms, so the drawer appears in one frame (NFR-TIM-02).
    expect(historyDrawerMotion('rise', true).duration).toBe(0)
  })

  it('[US-VALLE-011.AC02, S36.03] its close control sinks it back with a fade', () => {
    const shut = walk(open(MORIA), [{ kind: 'close' }])
    expect(shut.ids).toEqual(['S36.03'])
    expect(shut.state).toEqual(closing(MORIA))
    expect(shut.effects).toEqual([{ kind: 'sink' }])
    // The sink: to 16 px below and transparent, over `--dur-fast` with `--ease-in`, holding its last frame.
    expect(historyDrawerMotion('sink', false)).toEqual({
      frames: [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(16px)' }
      ],
      duration: 90,
      easing: 'cubic-bezier(0.5, 0, 0.9, 0.3)',
      fill: 'forwards'
    })
    expect(historyDrawerMotion('sink', true).duration).toBe(0)
    const sunk = walk(shut.state, [{ kind: 'sunk' }])
    expect(sunk.ids).toEqual(['S36.03'])
    expect(sunk.state).toEqual(HISTORY_DRAWER_START)
    expect(sunk.effects).toEqual([{ kind: 'write-session', open: false }])
  })

  it('[US-VALLE-011.AC03, S36.04] a climb out, leaving Valle or hiding closes it at once with no fade', () => {
    for (const kind of ['climb-out', 'leave', 'hidden'] as const) {
      for (const from of [open(MORIA), opening(MORIA)]) {
        const step = walk(from, [{ kind }])
        expect(step.ids).toEqual(['S36.04'])
        expect(step.state).toEqual(HISTORY_DRAWER_START)
        // At once: any rise still playing ends, no sink plays.
        expect(step.effects).toEqual([
          { kind: 'stop-motion' },
          { kind: 'write-session', open: false }
        ])
      }
    }
  })

  it("[S36.05, S36.06, S36.07] a swap shows the new mine's history, a removed mine closes it, and it is session-only", () => {
    // S36.05: another mine swapped into the Work front; the drawer stays open, on it, with no motion.
    const swapped = walk(open(MORIA), [{ kind: 'swap', mineId: EREBOR }])
    expect(swapped.ids).toEqual(['S36.05'])
    expect(swapped.state).toEqual(open(EREBOR))
    expect(swapped.effects).toEqual([])
    // S36.06: its mine removed closes it at once; another mine removed changes nothing.
    expect(stepHistoryDrawer(open(EREBOR), { kind: 'mine-removed', mineId: MORIA }).ok).toBe(false)
    const removed = walk(open(EREBOR), [{ kind: 'mine-removed', mineId: EREBOR }])
    expect(removed.ids).toEqual(['S36.06'])
    expect(removed.state).toEqual(HISTORY_DRAWER_START)
    expect(removed.effects).toEqual([
      { kind: 'stop-motion' },
      { kind: 'write-session', open: false }
    ])
    // S36.07: it starts closed whatever came before, and its only record is the session store's (A-N18), never a
    // stored preference.
    expect(HISTORY_DRAWER_START).toEqual({ kind: 'closed' })
    expect(historyDrawerPatch(true)).toEqual({ kind: 'valle', patch: { historyOpen: true } })
    expect(historyDrawerPatch(false)).toEqual({ kind: 'valle', patch: { historyOpen: false } })
  })

  it('[ADR-024] a transition not listed in 07 machine 36 is rejected', () => {
    const refused: [HistoryDrawerState, HistoryDrawerInput][] = [
      [HISTORY_DRAWER_START, { kind: 'risen' }],
      [HISTORY_DRAWER_START, { kind: 'close' }],
      [HISTORY_DRAWER_START, { kind: 'sunk' }],
      [HISTORY_DRAWER_START, { kind: 'climb-out' }],
      [HISTORY_DRAWER_START, { kind: 'swap', mineId: EREBOR }],
      [HISTORY_DRAWER_START, { kind: 'mine-removed', mineId: MORIA }],
      [opening(MORIA), { kind: 'open', mineId: MORIA, preset: 'front' }],
      [opening(MORIA), { kind: 'close' }],
      [opening(MORIA), { kind: 'sunk' }],
      [open(MORIA), { kind: 'open', mineId: EREBOR, preset: 'front' }],
      [open(MORIA), { kind: 'risen' }],
      [open(MORIA), { kind: 'sunk' }],
      [open(MORIA), { kind: 'swap', mineId: MORIA }],
      [closing(MORIA), { kind: 'close' }],
      [closing(MORIA), { kind: 'risen' }],
      [closing(MORIA), { kind: 'climb-out' }],
      [closing(MORIA), { kind: 'swap', mineId: EREBOR }]
    ]
    for (const [state, input] of refused) {
      expect(stepHistoryDrawer(state, input), `${state.kind} + ${input.kind}`).toEqual({
        ok: false
      })
    }
  })
})
