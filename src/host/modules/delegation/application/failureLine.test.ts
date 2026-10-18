// layer: L1
// L1 (17 §1.1): which `DelegationFailed` gives the parent's chat its one line (08 §2.8; 16 §5.4
// "Parent chat line"; 07 S8.02, S8.04–S8.07, S8.09, S8.11, S8.13) and what that line is: the
// approved US-DLG-005.AC01 text (PO #45) with the parent's display name, keyed by the delegation so
// a replay appends nothing (INV-82). Pure: no clock, no store.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import type { DelegationFailure, DelegationId } from '../domain/delegation'
import { parentFailureLine } from './failureLine'

const PARENT = '00000000-0000-7000-8000-0000000c2061' as DwarfId
const DELEGATION = '00000000-0000-7000-8000-0000000c2062' as DelegationId

const EVERY_FAILURE: readonly DelegationFailure[] = [
  'gate-closed',
  'jev-unreachable',
  'jev-could-not-choose',
  'no-provider',
  'worker-failed',
  'worker-lost',
  'handoff-failed',
  'parent-gone'
]

describe('the parent line of a failed delegation (US-DLG-005; 08 §2.8)', () => {
  it("[INV-82] every DelegationFailure but parent-gone yields the parent's line", () => {
    const lines = EVERY_FAILURE.map((failure) => ({
      failure,
      line: parentFailureLine(
        { delegationId: DELEGATION, parentDwarfId: PARENT, failure },
        'Grumli'
      )
    }))

    for (const { failure, line } of lines) {
      if (failure === 'parent-gone') {
        // S8.11: the parent's chat cannot receive it.
        expect(line).toBeNull()
        continue
      }
      // The same line for every cause (PO #45): no reason sentence is part of it.
      expect(line).toStrictEqual({
        parentDwarfId: PARENT,
        sourceKey: `delegation-failed:${DELEGATION}`,
        text: 'Jev could not take this subtask. Grumli continues it with its own subagent.'
      })
    }
  })

  it('[US-DLG-005.AC01] the line names the parent by the display name it is given', () => {
    const line = parentFailureLine(
      { delegationId: DELEGATION, parentDwarfId: PARENT, failure: 'jev-unreachable' },
      'Bramble the Deep'
    )

    expect(line?.text).toBe(
      'Jev could not take this subtask. Bramble the Deep continues it with its own subagent.'
    )
  })
})
