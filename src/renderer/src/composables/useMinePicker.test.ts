import type { MineId, ModeTransition, MoveToModeParams, UiSessionPatch } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { declareFailureNotice } from '../lib/browse/addProject'
import type { Opener } from '../lib/veta/gripMenu'
import type { PickerMine } from '../lib/veta/minePicker'
import { EREBOR, MORIA, mineWire } from '../lib/veta/testing/vetaFixtures'
import type { MineDeclareResult } from '../types'
import { useMinePicker, type MinePickerBridge } from './useMinePicker'

/*
 * ISSUE-288 (TC-288-03): the Veta grip menu and mine picker carried out (07 machine 22): the mines read model the
 * picker lists, the menu's moves (A-N13 `moveToMode`), "Add a mine" through A-30 `declareMine` (and A-31
 * `declareMainProject` for a worktree), the hand-off to the Panel on a new mine, and a refusal shown as the Mines page
 * shows it. A scripted bridge stands in for UI main.
 */

const NEW_MINE = '01920000-0000-7000-8000-00000000a00a' as MineId

function world(answers: { declare?: MineDeclareResult | Error; main?: MineDeclareResult } = {}) {
  const calls: string[] = []
  const moves: MoveToModeParams[] = []
  const focused: Opener[] = []
  const addPanels: MineId[] = []
  const transitions: Array<(t: ModeTransition) => void> = []
  /** What reached UI main, in order: A-N18 patches and A-N13 moves (ISSUE-295). */
  const sent: Array<UiSessionPatch | MoveToModeParams> = []
  const mines = shallowRef<PickerMine[]>([
    { mine: mineWire(MORIA), crew: 1 },
    { mine: mineWire(EREBOR), crew: 0 }
  ])
  const bridge: MinePickerBridge = {
    declareMine() {
      calls.push('declareMine')
      const answer = answers.declare ?? { outcome: 'cancelled' }
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
    declareMainProject() {
      calls.push('declareMainProject')
      return Promise.resolve(answers.main ?? { outcome: 'failed', reason: 'no' })
    },
    moveToMode(params) {
      moves.push(params)
      sent.push(params)
      return Promise.resolve({ ok: true, value: undefined })
    },
    patchUiSession(patch) {
      sent.push(patch)
    },
    onModeTransition(handler) {
      transitions.push(handler)
      return () => undefined
    }
  }
  const scope = effectScope()
  const picker = scope.run(() =>
    useMinePicker({
      bridge,
      mines: () => mines.value,
      built: ['panel', 'veta', 'valle'],
      focus: (target) => focused.push(target),
      addPanel: (mineId) => addPanels.push(mineId)
    })
  )!
  return { picker, calls, moves, focused, addPanels, mines, scope, transitions, sent }
}

/** Lets the declare's answers land. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('useMinePicker', () => {
  it('[US-VETA-003.AC03, US-VETA-003.AC06, US-LAUNCH-007.AC11, S22.04, S22.06, S22.09] menu items move through moveToMode, and a picked mine raises the Add panel at it', () => {
    const { picker, moves, addPanels } = world()
    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'choose', item: 'open-panel' })
    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'choose', item: 'hide' })
    expect(moves).toEqual([{ mode: 'panel' }, { mode: 'hidden' }])

    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'choose', item: 'new-dwarf' })
    expect(picker.state.value).toBe('picker-open')
    expect(picker.rows.value.map((row) => row.mineId)).toEqual([MORIA, EREBOR])
    picker.dispatch({ type: 'pick-mine', mineId: EREBOR, enterable: true })
    expect(addPanels).toEqual([EREBOR])
    expect(picker.state.value).toBe('closed')
    expect(moves).toHaveLength(2)
  })

  it('[US-LAUNCH-007.AC14, S22.10, S22.12, S22.13] Add a mine declares through A-30 and hands off to the Panel on the new mine, never the Add panel', async () => {
    const { picker, calls, moves, addPanels } = world({
      declare: { outcome: 'added', mineId: NEW_MINE }
    })
    picker.dispatch({ type: 'entrance' })
    expect(picker.state.value).toBe('picker-empty')
    picker.dispatch({ type: 'add-mine' })
    expect(picker.state.value).toBe('choosing-folder')
    await settle()
    expect(calls).toEqual(['declareMine'])
    expect(moves).toEqual([{ mode: 'panel', mineId: NEW_MINE }])
    expect(addPanels).toEqual([])
    expect(picker.state.value).toBe('closed')
    expect(picker.last.value).toMatchObject({ ok: true, id: 'S22.13' })
  })

  // AMENDED (was: a worktree adopted its main project at once): US-MINES-004.AC03 asks first, so the adoption waits
  // for "Add <mine>" on the worktree question.
  it('[US-MINES-004.AC06, S22.14, S22.13] Add <mine> on the worktree question adopts the main project through A-31 and the Panel opens on that mine', async () => {
    const { picker, calls, moves } = world({
      declare: { outcome: 'worktree-of', worktreeOf: { worktree: '/w/ore-wt', root: '/w/ore' } },
      main: { outcome: 'added', mineId: NEW_MINE }
    })
    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'choose', item: 'new-dwarf' })
    picker.dispatch({ type: 'add-mine' })
    await settle()
    expect(calls).toEqual(['declareMine'])
    picker.answerWorktree(true)
    expect(picker.adopting.value).toBe(true)
    await settle()
    expect(calls).toEqual(['declareMine', 'declareMainProject'])
    expect(moves).toEqual([{ mode: 'panel', mineId: NEW_MINE }])
    expect(picker.last.value).toMatchObject({ ok: true, id: 'S22.14' })
    expect([picker.worktree.value, picker.adopting.value, picker.state.value]).toEqual([
      null,
      false,
      'closed'
    ])
  })

  it('[US-MINES-004.AC03, US-MINES-004.AC07, S22.14] a worktree folder asks first, and nothing is added or moved until it is answered', async () => {
    const { picker, calls, moves } = world({
      declare: { outcome: 'worktree-of', worktreeOf: { worktree: '/w/ore-wt', root: '/w/ore' } },
      main: { outcome: 'added', mineId: NEW_MINE }
    })
    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'choose', item: 'new-dwarf' })
    picker.dispatch({ type: 'add-mine' })
    await settle()
    expect(picker.worktree.value).toEqual({ worktree: '/w/ore-wt', root: '/w/ore' })
    expect(calls).toEqual(['declareMine'])
    expect(moves).toEqual([])
    expect(picker.state.value).toBe('choosing-folder')
    // Esc or a press outside cannot close the picker under the question.
    picker.dispatch({ type: 'dismiss' })
    expect(picker.state.value).toBe('choosing-folder')
  })

  it('[US-MINES-004.AC03, S22.11] Cancel on the worktree question adds nothing and goes back to the picker', async () => {
    const { picker, calls, moves } = world({
      declare: { outcome: 'worktree-of', worktreeOf: { worktree: '/w/ore-wt', root: '/w/ore' } }
    })
    picker.dispatch({ type: 'entrance' })
    picker.dispatch({ type: 'add-mine' })
    await settle()
    picker.answerWorktree(false)
    await settle()
    expect(picker.worktree.value).toBeNull()
    expect(picker.state.value).toBe('picker-empty')
    expect(picker.last.value).toMatchObject({ ok: true, id: 'S22.11' })
    expect([calls, moves]).toEqual([['declareMine'], []])
  })

  it('[US-VETA-010.AC04, S22.11] a cancelled folder dialog adds nothing and goes back to the picker', async () => {
    const { picker, moves } = world({ declare: { outcome: 'cancelled' } })
    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'choose', item: 'new-dwarf' })
    picker.dispatch({ type: 'add-mine' })
    await settle()
    expect(picker.state.value).toBe('picker-open')
    expect(picker.notice.value).toBeNull()
    expect(moves).toEqual([])
  })

  it("[S22.15] a refused declare or an unreachable UI main shows the Mines page's own error and adds nothing", async () => {
    const refused = world({
      declare: { outcome: 'failed', reason: 'That folder could not be added.' }
    })
    refused.picker.dispatch({ type: 'entrance' })
    refused.picker.dispatch({ type: 'add-mine' })
    await settle()
    expect(refused.picker.state.value).toBe('picker-empty')
    expect(refused.picker.notice.value).toBe('That folder could not be added.')
    expect(refused.moves).toEqual([])
    // The next Add a mine starts clean.
    refused.picker.dispatch({ type: 'add-mine' })
    expect(refused.picker.notice.value).toBeNull()

    const unreachable = world({ declare: new Error('gone') })
    unreachable.picker.dispatch({ type: 'grip-open' })
    unreachable.picker.dispatch({ type: 'choose', item: 'new-dwarf' })
    unreachable.picker.dispatch({ type: 'add-mine' })
    await settle()
    expect(unreachable.picker.state.value).toBe('picker-open')
    expect(unreachable.picker.notice.value).toBe('DwarfAI-Miners could not open the folder picker.')
    expect(unreachable.picker.last.value).toMatchObject({ ok: true, id: 'S22.15' })
  })

  it('[US-VETA-003.AC07, S22.03, S22.16] Esc or an outside click gives the focus back to the opener', () => {
    const { picker, focused } = world()
    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'dismiss' })
    picker.dispatch({ type: 'entrance' })
    picker.dispatch({ type: 'dismiss' })
    expect(focused).toEqual(['grip', 'entrance'])
  })

  it('[S22.17] a mode change with this window the source closes the menu or the picker silently', () => {
    const { picker, transitions, focused, moves } = world()
    picker.dispatch({ type: 'grip-open' })
    picker.dispatch({ type: 'choose', item: 'new-dwarf' })
    const change = (role: 'source' | 'target'): void => {
      for (const handler of transitions)
        handler({
          transitionId: '00000000-0000-4000-8000-000000000001',
          from: 'veta',
          to: 'panel',
          t0: 0,
          role
        })
    }
    change('target')
    expect(picker.state.value).toBe('picker-open')
    change('source')
    expect(picker.state.value).toBe('closed')
    expect(picker.last.value).toMatchObject({ ok: true, id: 'S22.17' })
    expect([focused, moves]).toEqual([[], []])
  })
})

/*
 * ISSUE-295 (TC-295-01, TC-295-02): the first-run journey's hand-off. A-N14 `ModeTransition` carries no mine of its own
 * (14 §3.9: only `chat`), so the hand-off names the mine as the Panel's current mine in the UI session store (A-N18
 * `current-mine`, ADR-024 item 1, ADR-033 item 4) before it asks for the move; the Panel's view opens it on arrival.
 */
describe('useMinePicker — the first mine from Veta (ISSUE-295)', () => {
  it('[US-VETA-010.AC03, S22.12, S22.13] a picked folder becomes the new mine and Veta hands off to the Panel with that mine open in the mine column, and the Add panel does not open', async () => {
    const { picker, calls, sent, addPanels, mines } = world({
      declare: { outcome: 'added', mineId: NEW_MINE }
    })
    mines.value = []
    picker.dispatch({ type: 'entrance' })
    expect(picker.state.value).toBe('picker-empty')
    picker.dispatch({ type: 'add-mine' })
    await settle()
    expect(calls).toEqual(['declareMine'])
    // The Panel's mine column is named first, then the move: the Panel lands already on the new mine.
    expect(sent).toEqual([
      { kind: 'current-mine', host: 'panel', mineId: NEW_MINE },
      { mode: 'panel', mineId: NEW_MINE }
    ])
    expect(addPanels).toEqual([])
    expect(picker.state.value).toBe('closed')
    expect(picker.last.value).toMatchObject({ ok: true, id: 'S22.13' })
  })

  it('[US-VETA-010.AC04, S22.11] cancelling the OS folder picker adds nothing and Veta stays exactly as it was, on first run', async () => {
    const { picker, calls, sent, addPanels, focused, mines } = world({
      declare: { outcome: 'cancelled' }
    })
    mines.value = []
    picker.dispatch({ type: 'entrance' })
    picker.dispatch({ type: 'add-mine' })
    expect(picker.state.value).toBe('choosing-folder')
    await settle()
    expect(calls).toEqual(['declareMine'])
    // Back on the empty picker the "+" opened, with nothing sent, raised, refused or focused away.
    expect(picker.state.value).toBe('picker-empty')
    expect(picker.last.value).toMatchObject({ ok: true, id: 'S22.11' })
    expect(picker.notice.value).toBeNull()
    expect([sent, addPanels, focused]).toEqual([[], [], []])
    expect(picker.machine.value.opener).toBe('entrance')
  })

  it('[S22.14, S22.15] a worktree hands off on the mine it folds into; a refused folder shows the Mines page error and adds nothing', async () => {
    const folded = world({
      declare: { outcome: 'worktree-of', worktreeOf: { worktree: '/w/ore-wt', root: '/w/ore' } },
      main: { outcome: 'added', mineId: NEW_MINE }
    })
    folded.mines.value = []
    folded.picker.dispatch({ type: 'entrance' })
    folded.picker.dispatch({ type: 'add-mine' })
    await settle()
    folded.picker.answerWorktree(true)
    await settle()
    expect(folded.calls).toEqual(['declareMine', 'declareMainProject'])
    expect(folded.sent).toEqual([
      { kind: 'current-mine', host: 'panel', mineId: NEW_MINE },
      { mode: 'panel', mineId: NEW_MINE }
    ])
    expect(folded.addPanels).toEqual([])
    expect(folded.picker.last.value).toMatchObject({ ok: true, id: 'S22.14' })

    const refused = world({ declare: { outcome: 'failed', reason: 'invalid-path' } })
    refused.mines.value = []
    refused.picker.dispatch({ type: 'entrance' })
    refused.picker.dispatch({ type: 'add-mine' })
    await settle()
    expect(refused.picker.last.value).toMatchObject({ ok: true, id: 'S22.15' })
    expect(refused.picker.state.value).toBe('picker-empty')
    expect(refused.picker.notice.value).toBe(
      declareFailureNotice({ outcome: 'failed', reason: 'invalid-path' })
    )
    expect([refused.sent, refused.addPanels]).toEqual([[], []])
  })
})
