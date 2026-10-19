import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { FakeSessionTerminator } from '../ports/fakes/FakeSessionTerminator'
import { runSessionTerminatorContract } from './sessionTerminator.contract'

// The double runs the same contract as the `host/wiring` bridge (17 §1.3, 16 §2.8).
describe('FakeSessionTerminator', () => {
  runSessionTerminatorContract(() => {
    const terminator = new FakeSessionTerminator()
    let sequence = 0
    return {
      terminator,
      seat: ({ mineId }) => {
        const dwarfId =
          `00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}` as DwarfId
        terminator.seat(mineId, dwarfId)
        return dwarfId
      },
      calls: () => terminator.calls
    }
  })

  const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
  const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId

  it('[ADR-014] a scripted outcome is what end and endAll answer for that dwarf', async () => {
    const terminator = new FakeSessionTerminator()
    terminator.seat(MINE, DWARF)
    terminator.script(DWARF, { kind: 'failed', reason: 'no-identity' })

    expect(await terminator.end(DWARF, 'stop-dwarf')).toEqual({
      kind: 'failed',
      reason: 'no-identity'
    })
    expect(await terminator.endAll(MINE)).toEqual(
      new Map([[DWARF, { kind: 'failed', reason: 'no-identity' }]])
    )
    expect(terminator.calls).toEqual([
      { method: 'end', dwarfId: DWARF, why: 'stop-dwarf' },
      { method: 'endAll', mineId: MINE }
    ])
  })
})
