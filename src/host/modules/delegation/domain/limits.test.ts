import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { admitDelegation, type DelegationAdmission, type DelegationId } from './delegation'
import { MAX_DELEGATIONS_GLOBAL, MAX_DELEGATIONS_PER_PARENT, checkLimits } from './limits'
import type { SubtaskText } from './subtaskText'

// The delegation limits (ADR-013 item 1; 16 §5.4, §5.5): the transplanted per-parent and global
// in-flight caps, and depth 1 (INV-81). A refusal creates no delegation.
const T0 = 1_790_000_000_000

const call = (overrides: Partial<DelegationAdmission> = {}): DelegationAdmission => ({
  id: 'delegation-1' as DelegationId,
  ticket: 'ticket-1',
  parentDwarfId: 'dwarf-parent' as DwarfId,
  subtask: { task: 'write the tests' as SubtaskText },
  preferences: { subagentDelegationOn: true },
  launch: { launchedWithLetJevChoose: true, delegated: false },
  inFlight: { parent: 0, global: 0 },
  ...overrides
})

describe('delegation limits', () => {
  it('[ADR-013] a call above the per-parent or the global cap is concurrency-limit and a call from a delegated worker is depth-exceeded, both with no delegation created', () => {
    expect(MAX_DELEGATIONS_PER_PARENT).toBe(2)
    expect(MAX_DELEGATIONS_GLOBAL).toBe(4)
    const root = { delegated: false }

    // Just under each cap is admitted.
    expect(checkLimits(root, { parent: 1, global: 3 })).toEqual({ ok: true, value: 'within' })
    expect(admitDelegation(call({ inFlight: { parent: 1, global: 3 } }), T0).ok).toBe(true)

    // At either cap the next call is refused, with no delegation.
    for (const inFlight of [
      { parent: 2, global: 2 },
      { parent: 0, global: 4 }
    ]) {
      expect(checkLimits(root, inFlight)).toEqual({ ok: false, error: 'concurrency-limit' })
      expect(admitDelegation(call({ inFlight }), T0)).toEqual({
        ok: false,
        error: 'concurrency-limit'
      })
    }

    // A delegated worker's call is depth-exceeded, whatever the counts and the gate inputs.
    const worker = { launchedWithLetJevChoose: true, delegated: true }
    expect(checkLimits(worker, { parent: 0, global: 0 })).toEqual({
      ok: false,
      error: 'depth-exceeded'
    })
    for (const subagentDelegationOn of [false, true]) {
      expect(
        admitDelegation(call({ launch: worker, preferences: { subagentDelegationOn } }), T0)
      ).toEqual({ ok: false, error: 'depth-exceeded' })
    }
    expect(
      admitDelegation(call({ launch: worker, inFlight: { parent: 2, global: 4 } }), T0)
    ).toEqual({ ok: false, error: 'depth-exceeded' })

    // With the gate closed the call is gate-closed (a failed delegation, S8.02), not a limit.
    const closed = admitDelegation(
      call({ preferences: { subagentDelegationOn: false }, inFlight: { parent: 2, global: 4 } }),
      T0
    )
    expect(closed.ok && closed.value.delegation.failure).toBe('gate-closed')
  })
})
