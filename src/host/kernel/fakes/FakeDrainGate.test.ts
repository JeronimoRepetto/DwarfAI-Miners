import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../contracts/wire'
import { runDrainGateContract } from '../testing/drainGate.contract'
import { FakeDrainGate } from './FakeDrainGate'

const DWARF = '01890a5d-ac96-774b-bcce-b302099a8061' as DwarfId

describe('FakeDrainGate', () => {
  runDrainGateContract(() => {
    const open = [{ kind: 'non-resumable-session' as const, dwarfId: DWARF }]
    return { gate: new FakeDrainGate(open), open }
  })

  it('[S12.15] a blocker opened by hand holds until it is cleared', () => {
    const gate = new FakeDrainGate()

    gate.block({ kind: 'open-ask', dwarfId: DWARF })
    const held = [...gate.blockers()]
    gate.clear()

    expect(held).toEqual([{ kind: 'open-ask', dwarfId: DWARF }])
    expect(gate.blockers()).toEqual([])
    expect(gate.reads).toBe(2)
  })
})
