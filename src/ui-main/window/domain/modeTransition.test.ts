// layer: L1
import { describe, expect, it } from 'vitest'
import {
  nextModeTransition,
  type ModeRun,
  type ModeTransitionEvent,
  type ModeTransitionNode
} from './modeTransition'

const BUILT = ['panel', 'veta', 'valle', 'hidden'] as const
const run = (over: Partial<ModeRun> = {}): ModeRun => ({
  transitionId: 't-1',
  from: 'veta',
  to: 'panel',
  done: [],
  ...over
})
const settled = (mode: ModeRun['from']): ModeTransitionNode => ({ state: 'settled', mode })
const preparing = (over: Partial<ModeRun> = {}): ModeTransitionNode => ({
  state: 'preparing',
  run: run(over)
})
const playing = (over: Partial<ModeRun> = {}): ModeTransitionNode => ({
  state: 'playing',
  run: run(over)
})
const completing = (over: Partial<ModeRun> = {}): ModeTransitionNode => ({
  state: 'completing',
  run: run(over)
})

/** Steps `node` through `events` and answers each transition id taken, failing on a refused one. */
function walk(
  node: ModeTransitionNode,
  events: ModeTransitionEvent[]
): {
  ids: string[]
  last: ModeTransitionNode
} {
  const ids: string[] = []
  let at = node
  for (const event of events) {
    const step = nextModeTransition(at, event, BUILT)
    if (!step.ok) throw new Error(`${event.type} refused in ${at.state}: ${step.error}`)
    ids.push(step.value.id)
    at = step.value.to
  }
  return { ids, last: at }
}

describe('machine 27 diagram conformance', () => {
  it('[S27.01, S27.02, S27.03, S27.05] a move runs settled, preparing, playing, completing, settled', () => {
    const { ids, last } = walk(settled('veta'), [
      { type: 'move', mode: 'panel', transitionId: 't-1' },
      { type: 'prepared' },
      { type: 'done', role: 'source' },
      { type: 'done', role: 'target' },
      { type: 'landed' }
    ])
    expect(ids).toEqual(['S27.01', 'S27.02', 'half-done', 'S27.03', 'S27.05'])
    expect(last).toEqual(settled('panel'))
  })

  it('[S27.04] the watchdog completes a run whose done never came', () => {
    const step = nextModeTransition(playing({ done: ['source'] }), { type: 'watchdog' }, BUILT)
    expect(step).toEqual({
      ok: true,
      value: { id: 'S27.04', to: completing({ done: ['source'] }) }
    })
  })

  it('[S27.06] reduced motion goes from preparing to settled in the target', () => {
    const step = nextModeTransition(preparing(), { type: 'reduced-motion' }, BUILT)
    expect(step).toEqual({ ok: true, value: { id: 'S27.06', to: settled('panel') } })
  })

  it('[S27.07] a failed target returns to settled in the source', () => {
    const step = nextModeTransition(preparing(), { type: 'target-failed' }, BUILT)
    expect(step).toEqual({ ok: true, value: { id: 'S27.07', to: settled('veta') } })
  })

  it('[S27.08] hidden mid-motion settles in the target, hidden', () => {
    const step = nextModeTransition(playing(), { type: 'hidden' }, BUILT)
    expect(step).toEqual({ ok: true, value: { id: 'S27.08', to: settled('hidden') } })
  })

  it('[S27.09] a second move during a run is held and runs after the run settles', () => {
    // Owner OQ-78 (AMENDMENT-10): the mode can always be changed, so a request is held, never dropped; the last wins.
    const first = walk(playing(), [
      { type: 'move', mode: 'valle', transitionId: 't-2' },
      { type: 'move', mode: 'hidden', transitionId: 't-3' }
    ])
    expect(first.ids).toEqual(['S27.09', 'S27.09'])
    expect(first.last).toEqual(playing({ held: { mode: 'hidden', transitionId: 't-3' } }))
    // A click or a key is ignored, never queued.
    expect(nextModeTransition(first.last, { type: 'input' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.09', to: first.last }
    })
    // Once the run settles the held request is what the settled node carries, to start as S27.01.
    const done = walk(first.last, [{ type: 'watchdog' }, { type: 'landed' }])
    expect(done.last).toEqual({
      state: 'settled',
      mode: 'panel',
      held: { mode: 'hidden', transitionId: 't-3' }
    })
    expect(walk(done.last, [{ type: 'move', mode: 'hidden', transitionId: 't-3' }]).ids).toEqual([
      'S27.01'
    ])
  })

  it('[S27.10, S27.12] an app close or a UI crash mid-run leaves lastMode on the source unless S27.03 ran', () => {
    expect(nextModeTransition(playing(), { type: 'closed' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.10', to: { state: 'closed', lastMode: 'veta' } }
    })
    expect(nextModeTransition(completing(), { type: 'closed' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.10', to: { state: 'closed', lastMode: 'panel' } }
    })
    expect(nextModeTransition(settled('panel'), { type: 'closed' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.10', to: { state: 'closed', lastMode: 'panel' } }
    })
    expect(nextModeTransition(playing(), { type: 'crashed' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.12', to: { state: 'lost' } }
    })
  })

  it('[S27.11] a departed carried dwarf still completes the run', () => {
    expect(nextModeTransition(preparing(), { type: 'departed' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.11', to: completing() }
    })
    expect(nextModeTransition(playing(), { type: 'departed' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.11', to: completing() }
    })
  })

  it('[S27.13] two displays play one run', () => {
    expect(nextModeTransition(playing(), { type: 'displays-differ' }, BUILT)).toEqual({
      ok: true,
      value: { id: 'S27.13', to: playing() }
    })
  })

  it('[S27.14] a reveal mid-run is held', () => {
    const held = walk(playing(), [
      { type: 'reveal', revealId: 1 },
      { type: 'reveal', revealId: 2 }
    ])
    expect(held.ids).toEqual(['S27.14', 'S27.14'])
    expect(held.last).toEqual(playing({ heldReveal: 2 }))
    const done = walk(held.last, [{ type: 'watchdog' }, { type: 'landed' }])
    expect(done.last).toEqual({ state: 'settled', mode: 'panel', heldReveal: 2 })
  })

  it('[ADR-025] a transition not listed in 07 machine 27 is rejected', () => {
    expect(nextModeTransition(settled('panel'), { type: 'done', role: 'source' }, BUILT)).toEqual({
      ok: false,
      error: 'not-listed'
    })
    expect(nextModeTransition(playing(), { type: 'prepared' }, BUILT)).toEqual({
      ok: false,
      error: 'not-listed'
    })
    expect(nextModeTransition(preparing(), { type: 'hidden' }, BUILT)).toEqual({
      ok: false,
      error: 'not-listed'
    })
    expect(
      nextModeTransition(playing({ done: ['source'] }), { type: 'done', role: 'source' }, BUILT)
    ).toEqual({
      ok: false,
      error: 'not-listed'
    })
    // S27.01 guards: the target mode built (BR-19), and not the mode already shown.
    expect(
      nextModeTransition(settled('panel'), { type: 'move', mode: 'veta', transitionId: 't' }, [
        'panel',
        'hidden'
      ])
    ).toEqual({ ok: false, error: 'not-built' })
    expect(
      nextModeTransition(
        settled('panel'),
        { type: 'move', mode: 'panel', transitionId: 't' },
        BUILT
      )
    ).toEqual({ ok: false, error: 'already-shown' })
  })
})
