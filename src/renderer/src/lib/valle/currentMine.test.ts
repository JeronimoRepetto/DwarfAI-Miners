import type { MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { EREBOR, KHAZAD, MORIA } from '../veta/testing/vetaFixtures'
import {
  CURRENT_MINE_START,
  currentMineOf,
  currentMinePatch,
  mineSound,
  stepCurrentMine,
  type CurrentMineFacts,
  type CurrentMineInput,
  type CurrentMineState
} from './currentMine'

/*
 * 07 machine 35 (UC-060; 17 §1.1 diagram-conformance walk): one current mine for the Valle host, made current by a chat,
 * a painting or a dive, falling back to the chat in focus's column, else the first column; the same value the sound
 * engine reads. An input the machine does not list is refused (ADR-024).
 */

/** The Control room with three columns, no chat in focus. */
const CONTROL: CurrentMineFacts = {
  preset: 'control',
  mosaic: [MORIA, EREBOR, KHAZAD],
  frontMine: null,
  focusMine: null
}
const set = (mineId: MineId): CurrentMineState => ({ kind: 'set', mineId })

/** Each input in turn from `state`, every step taken; answers the last state. */
function walk(
  state: CurrentMineState,
  inputs: readonly CurrentMineInput[],
  facts: CurrentMineFacts = CONTROL
): { state: CurrentMineState; ids: string[] } {
  const ids: string[] = []
  for (const input of inputs) {
    const step = stepCurrentMine(state, input, facts)
    if (!step.ok) throw new Error(`refused ${input.kind}`)
    ids.push(step.id)
    state = step.state
  }
  return { state, ids }
}

describe('machine 35 diagram conformance', () => {
  it('[US-VALLE-013.AC01, S35.01] a chat opened or focused anywhere in Valle makes its mine current and clears every other mark', () => {
    const { state, ids } = walk(CURRENT_MINE_START, [{ kind: 'chat', mineId: EREBOR }])
    expect(ids).toEqual(['S35.01'])
    expect(state).toEqual(set(EREBOR))
    expect(currentMineOf(state, CONTROL)).toBe(EREBOR)
    // From another mine set: the chat's mine replaces it, one value, so no other mine keeps a mark.
    const next = walk(set(KHAZAD), [{ kind: 'chat', mineId: MORIA }])
    expect(next.state).toEqual(set(MORIA))
    expect(currentMineOf(next.state, CONTROL)).toBe(MORIA)
    // Guard: the mine is a mosaic column; a chat of a mine not shown changes nothing.
    const outside = 'not-a-column' as MineId
    expect(stepCurrentMine(set(KHAZAD), { kind: 'chat', mineId: outside }, CONTROL).ok).toBe(false)
  })

  it('[US-VALLE-013.AC02, S35.02] a single click on a painting or header makes the mine current without changing the chat in focus', () => {
    const facts: CurrentMineFacts = { ...CONTROL, focusMine: MORIA }
    const { state, ids } = walk(CURRENT_MINE_START, [{ kind: 'painting', mineId: KHAZAD }], facts)
    expect(ids).toEqual(['S35.02'])
    expect(currentMineOf(state, facts)).toBe(KHAZAD)
    // The chat in focus is a fact the machine reads, never one it writes: the next step still sees Moria's chat.
    expect(facts.focusMine).toBe(MORIA)
    // In the Work front, its one mine's painting.
    const front: CurrentMineFacts = { ...CONTROL, preset: 'front', frontMine: EREBOR }
    expect(walk(set(MORIA), [{ kind: 'painting', mineId: EREBOR }], front).ids).toEqual(['S35.02'])
  })

  it("[US-VALLE-013.AC03, S35.03] a double click on a mine's art dives in and makes it current", () => {
    const { state, ids } = walk(set(MORIA), [{ kind: 'dive', mineId: KHAZAD }])
    expect(ids).toEqual(['S35.03'])
    expect(state).toEqual(set(KHAZAD))
    const front: CurrentMineFacts = { ...CONTROL, preset: 'front', frontMine: KHAZAD }
    expect(currentMineOf(state, front)).toBe(KHAZAD)
  })

  it('[US-VALLE-013.AC05, S35.03, S35.04] in the Work front the one mine shown is always current', () => {
    const front: CurrentMineFacts = {
      preset: 'front',
      mosaic: [MORIA],
      frontMine: EREBOR,
      focusMine: KHAZAD
    }
    // Whatever was set, and with a chat of another mine in focus, the mine shown is current: no fallback needed.
    expect(currentMineOf(CURRENT_MINE_START, front)).toBe(EREBOR)
    expect(currentMineOf(set(MORIA), front)).toBe(EREBOR)
    // S35.04: a tab of another mine's dwarf selected changes nothing.
    const tab = stepCurrentMine(set(EREBOR), { kind: 'front-tab', mineId: KHAZAD }, front)
    expect(tab).toEqual({ ok: true, id: 'S35.04', state: set(EREBOR) })
    // S35.03: a swap or a list pick makes that mine current.
    expect(walk(set(EREBOR), [{ kind: 'dive', mineId: KHAZAD }], front).state).toEqual(set(KHAZAD))
  })

  it('[US-VALLE-013.AC06, S35.05, S35.06] with nothing made current it falls back to the mine of the chat in focus, else the first mosaic column', () => {
    expect(CURRENT_MINE_START).toEqual({ kind: 'fallback' })
    expect(currentMineOf(CURRENT_MINE_START, { ...CONTROL, focusMine: KHAZAD })).toBe(KHAZAD)
    expect(currentMineOf(CURRENT_MINE_START, CONTROL)).toBe(MORIA)
    // A chat in focus whose mine is not a column falls through to the first column.
    expect(currentMineOf(CURRENT_MINE_START, { ...CONTROL, focusMine: 'gone' as MineId })).toBe(
      MORIA
    )
    expect(currentMineOf(CURRENT_MINE_START, { ...CONTROL, mosaic: [] })).toBeNull()
    // S35.05: the current mine's column closed or removed, or a climb to a mosaic that lacks it.
    const closed = stepCurrentMine(set(EREBOR), { kind: 'gone', mineId: EREBOR }, CONTROL)
    expect(closed).toEqual({ ok: true, id: 'S35.05', state: CURRENT_MINE_START })
    // A set mine no longer on screen is never current: the fallback stands in until S35.05 is taken.
    expect(currentMineOf(set('gone' as MineId), { ...CONTROL, focusMine: EREBOR })).toBe(EREBOR)
  })

  it('[US-VALLE-016.AC01, S35.06] on a first visit with nothing picked the first mine shown by the fallback is the one heard', () => {
    // A first visit: the start-up pins put the first waiting dwarf's chat in focus (S29.01), so its mine is heard.
    const firstVisit: CurrentMineFacts = { ...CONTROL, focusMine: EREBOR }
    const current = currentMineOf(CURRENT_MINE_START, firstVisit)
    expect(current).toBe(EREBOR)
    expect(mineSound(current, [])).toEqual({ mineId: EREBOR, muted: false })
    // Nobody waiting and no chat: the first mine shown.
    expect(mineSound(currentMineOf(CURRENT_MINE_START, CONTROL), [])).toEqual({
      mineId: MORIA,
      muted: false
    })
    // A mine's own mute still silences its bed and crew (S31.08).
    expect(mineSound(MORIA, [MORIA])).toEqual({ mineId: MORIA, muted: true })
  })

  it('[S35.07, S35.08, INV-115] cues are never gated, a hidden Valle plays nothing, and there is one current mine per host', () => {
    // S35.07 and S35.08 take no transition: the current mine is kept for its next show.
    expect(stepCurrentMine(set(EREBOR), { kind: 'cue' }, CONTROL)).toEqual({
      ok: true,
      id: 'S35.07',
      state: set(EREBOR)
    })
    expect(stepCurrentMine(set(EREBOR), { kind: 'hidden' }, CONTROL)).toEqual({
      ok: true,
      id: 'S35.08',
      state: set(EREBOR)
    })
    // The sound reads the mine and its mute alone: nothing about a cue is gated on it.
    expect(Object.keys(mineSound(EREBOR, [])).sort()).toEqual(['mineId', 'muted'])
    // One value, for the Valle host, never a global field.
    expect(currentMinePatch(EREBOR)).toEqual({
      kind: 'current-mine',
      host: 'valle',
      mineId: EREBOR
    })
  })

  it('[ADR-024] a transition not listed in 07 machine 35 is rejected', () => {
    const refused = { ok: false, reason: 'not-listed' }
    // S35.05 leaves `set` only, and only for the current mine.
    expect(stepCurrentMine(CURRENT_MINE_START, { kind: 'gone', mineId: MORIA }, CONTROL)).toEqual(
      refused
    )
    expect(stepCurrentMine(set(EREBOR), { kind: 'gone', mineId: MORIA }, CONTROL)).toEqual(refused)
    // S35.04 is the Work front's; S35.02 needs the mine on screen.
    expect(stepCurrentMine(set(EREBOR), { kind: 'front-tab', mineId: MORIA }, CONTROL)).toEqual(
      refused
    )
    expect(
      stepCurrentMine(set(EREBOR), { kind: 'painting', mineId: 'gone' as MineId }, CONTROL)
    ).toEqual(refused)
  })
})
