// layer: L6
import { describe, expect, it } from 'vitest'
import { modeTransitionSchema } from './windowApi'

/*
 * AMENDMENT-27 (owner-approved 2026-10-24; 14 §3.9 `ModeTransition.slot`, §6.5; 07 N-23, S24.13; ISSUE-293): the run
 * tells the target which slot to open for the carried chat. Optional and backward-compatible: absent means `'chat'`.
 */
const RUN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1b01'
const DWARF = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01'
const MINE = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02'
const carried = {
  transitionId: RUN,
  from: 'veta',
  to: 'panel',
  t0: 1016,
  chat: { dwarfId: DWARF, mineId: MINE },
  role: 'target'
}

describe('ModeTransition.slot (14 §3.9, AMENDMENT-27)', () => {
  it('[US-DLG-006.AC02, S24.13] a transition carrying slot chat or history validates', () => {
    expect(modeTransitionSchema.safeParse({ ...carried, slot: 'chat' }).success).toBe(true)
    const history = modeTransitionSchema.safeParse({ ...carried, slot: 'history' })
    expect(history.success && history.data.slot).toBe('history')
  })

  it('[US-DLG-006.AC02, S24.13] a transition without slot still validates and means the chat', () => {
    const parsed = modeTransitionSchema.safeParse(carried)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.slot).toBeUndefined()
  })

  it('[US-DLG-006.AC02, S24.13] an unknown slot value is refused', () => {
    for (const slot of ['map', '', 'HISTORY', 1, null]) {
      expect(modeTransitionSchema.safeParse({ ...carried, slot }).success, String(slot)).toBe(false)
    }
  })
})
