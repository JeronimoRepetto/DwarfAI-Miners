import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import {
  admitDelegation,
  applyEvent,
  beginHandoff,
  type Delegation,
  type DelegationAdmission,
  type DelegationEvent,
  type DelegationId,
  type DelegationState
} from './delegation'
import type { SubtaskText } from './subtaskText'

// Machine 8 (07 §8) over plain values: time is passed in, nothing reads a clock (05 §2.2, R1).
const T0 = 1_790_000_000_000
const PARENT = 'dwarf-parent' as DwarfId
const WORKER = 'dwarf-worker' as DwarfId

const admission = (overrides: Partial<DelegationAdmission> = {}): DelegationAdmission => ({
  id: 'delegation-1' as DelegationId,
  ticket: 'ticket-1',
  parentDwarfId: PARENT,
  subtask: { task: 'write the tests' as SubtaskText, context: 'in src/' as SubtaskText },
  preferences: { subagentDelegationOn: true },
  launch: { launchedWithLetJevChoose: true, delegated: false },
  inFlight: { parent: 0, global: 0 },
  ...overrides
})

function attempted(): Delegation {
  const admitted = admitDelegation(admission(), T0)
  if (!admitted.ok) throw new Error('both gates are open')
  return admitted.value.delegation
}

function step(d: Delegation, event: DelegationEvent, at = T0 + 1_000): Delegation {
  const result = applyEvent(d, event, at)
  if (!result.ok) throw new Error(`${event.type} refused: ${result.error}`)
  return result.value.delegation
}

function running(): Delegation {
  return step(attempted(), { type: 'worker-launched', workerDwarfId: WORKER })
}

function handingOff(via: 'tool-result' | 'turn-input'): Delegation {
  const result = beginHandoff(running(), via, T0 + 2_000)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/** 07 §8, the transition table as written: id, from, the event that triggers it, to. */
const MACHINE_8_AS_WRITTEN: ReadonlyArray<{
  id: string
  from: () => Delegation | null
  event: DelegationEvent | 'admit-gate-open' | 'admit-gate-closed'
  to: DelegationState
  failure?: string
}> = [
  { id: 'S8.01', from: () => null, event: 'admit-gate-open', to: 'attempted' },
  {
    id: 'S8.02',
    from: () => null,
    event: 'admit-gate-closed',
    to: 'failed',
    failure: 'gate-closed'
  },
  {
    id: 'S8.03',
    from: attempted,
    event: { type: 'worker-launched', workerDwarfId: WORKER },
    to: 'running'
  },
  {
    id: 'S8.04',
    from: attempted,
    event: { type: 'jev-unreachable' },
    to: 'failed',
    failure: 'jev-unreachable'
  },
  {
    id: 'S8.05',
    from: attempted,
    event: { type: 'jev-could-not-choose' },
    to: 'failed',
    failure: 'jev-could-not-choose'
  },
  {
    id: 'S8.06',
    from: attempted,
    event: { type: 'no-provider' },
    to: 'failed',
    failure: 'no-provider'
  },
  {
    id: 'S8.07',
    from: attempted,
    event: { type: 'worker-launch-failed' },
    to: 'failed',
    failure: 'worker-failed'
  },
  {
    id: 'S8.08',
    from: () => handingOff('tool-result'),
    event: { type: 'handoff-delivered' },
    to: 'succeeded'
  },
  {
    id: 'S8.08',
    from: () => handingOff('turn-input'),
    event: { type: 'handoff-delivered' },
    to: 'succeeded'
  },
  {
    id: 'S8.09',
    from: running,
    event: { type: 'worker-lost' },
    to: 'failed',
    failure: 'worker-lost'
  },
  { id: 'S8.10', from: running, event: { type: 'setting-turned-off' }, to: 'running' },
  { id: 'S8.10', from: running, event: { type: 'window-closed' }, to: 'running' },
  // INV-80: an `attempted` delegation is in flight too; the toggle never cancels it either.
  { id: 'S8.10', from: attempted, event: { type: 'setting-turned-off' }, to: 'attempted' },
  { id: 'S8.10', from: attempted, event: { type: 'window-closed' }, to: 'attempted' },
  {
    id: 'S8.11',
    from: attempted,
    event: { type: 'parent-session-ended' },
    to: 'failed',
    failure: 'parent-gone'
  },
  {
    id: 'S8.11',
    from: running,
    event: { type: 'parent-session-ended' },
    to: 'failed',
    failure: 'parent-gone'
  },
  {
    id: 'S8.12',
    from: attempted,
    event: { type: 'host-crashed-while-routing' },
    to: 'failed',
    failure: 'worker-lost'
  },
  {
    id: 'S8.13',
    from: () => handingOff('turn-input'),
    event: { type: 'handoff-push-failed', parentSessionAlive: true },
    to: 'failed',
    failure: 'handoff-failed'
  }
]

const ALL_EVENTS: readonly DelegationEvent[] = [
  { type: 'worker-launched', workerDwarfId: WORKER },
  { type: 'jev-unreachable' },
  { type: 'jev-could-not-choose' },
  { type: 'no-provider' },
  { type: 'worker-launch-failed' },
  { type: 'handoff-delivered' },
  { type: 'worker-lost' },
  { type: 'setting-turned-off' },
  { type: 'window-closed' },
  { type: 'parent-session-ended' },
  { type: 'host-crashed-while-routing' },
  { type: 'handoff-push-failed', parentSessionAlive: true }
]

describe('delegation (machine 8)', () => {
  it('[S8.01, S8.02, S8.03, S8.04, S8.05, S8.06, S8.07, S8.08, S8.09, S8.10, S8.11, S8.12, S8.13] every machine-8 transition reaches its target state and a transition not in 07 is rejected', () => {
    const at = T0 + 5_000
    for (const row of MACHINE_8_AS_WRITTEN) {
      const from = row.from()
      let reached: { delegation: Delegation; transition: string }
      if (row.event === 'admit-gate-open' || row.event === 'admit-gate-closed') {
        const admitted = admitDelegation(
          admission({ preferences: { subagentDelegationOn: row.event === 'admit-gate-open' } }),
          at
        )
        if (!admitted.ok) throw new Error(`${row.id}: ${admitted.error}`)
        reached = admitted.value
      } else {
        if (from === null) throw new Error(`${row.id} needs a delegation`)
        const result = applyEvent(from, row.event, at)
        if (!result.ok) throw new Error(`${row.id} refused: ${result.error}`)
        reached = result.value
      }
      expect(reached.transition, row.id).toBe(row.id)
      expect(reached.delegation.state, row.id).toBe(row.to)
      expect(reached.delegation.failure, row.id).toBe(row.failure)
      if (row.to === 'succeeded' || row.to === 'failed') {
        // 09 §4.6 CHECKs: settled with a time, and the subtask text gone once settled.
        expect(reached.delegation.settledAt, row.id).toBe(at)
        expect(reached.delegation.task, row.id).toBeUndefined()
        expect(reached.delegation.context, row.id).toBeUndefined()
      } else {
        expect(reached.delegation.settledAt, row.id).toBeUndefined()
      }
    }

    // Every pair 07 does not list is rejected and changes nothing.
    const listed = new Set(
      MACHINE_8_AS_WRITTEN.flatMap((row) => {
        const from = row.from()
        return from === null || typeof row.event === 'string'
          ? []
          : [`${from.state}|${from.handoff?.via ?? '-'}|${row.event.type}`]
      })
    )
    const samples: readonly Delegation[] = [
      attempted(),
      running(),
      handingOff('tool-result'),
      handingOff('turn-input'),
      step(handingOff('tool-result'), { type: 'handoff-delivered' }),
      step(attempted(), { type: 'jev-unreachable' })
    ]
    let rejected = 0
    for (const sample of samples) {
      for (const event of ALL_EVENTS) {
        const key = `${sample.state}|${sample.handoff?.via ?? '-'}|${event.type}`
        const isHandoffEvent =
          event.type === 'handoff-delivered' || event.type === 'handoff-push-failed'
        const listedHere =
          listed.has(key) ||
          // a non-handoff event does not depend on the handoff having begun
          (!isHandoffEvent && listed.has(`${sample.state}|-|${event.type}`))
        if (listedHere) continue
        const result = applyEvent(sample, event, at)
        expect(result.ok, `${key} is not in 07 §8`).toBe(false)
        rejected += 1
      }
    }
    expect(rejected).toBeGreaterThan(0)

    // A worker that is the parent itself is refused (09 §4.6 CHECK).
    expect(applyEvent(attempted(), { type: 'worker-launched', workerDwarfId: PARENT }, at)).toEqual(
      { ok: false, error: 'worker-is-parent' }
    )
    // S8.13 with the parent gone is S8.11 instead: parent-gone, the handoff failed, no line.
    const parentGone = applyEvent(
      handingOff('turn-input'),
      { type: 'handoff-push-failed', parentSessionAlive: false },
      at
    )
    expect(parentGone.ok && parentGone.value.transition).toBe('S8.11')
    expect(parentGone.ok && parentGone.value.delegation.failure).toBe('parent-gone')
    expect(parentGone.ok && parentGone.value.delegation.handoff).toEqual({
      via: 'turn-input',
      phase: 'failed',
      phaseAt: at
    })
  })

  it('[US-DLG-001.AC03, S8.10, INV-80] turning the setting off leaves a running delegation running and refuses the next attempt as gate-closed', () => {
    const inFlight = running()
    const toggled = applyEvent(inFlight, { type: 'setting-turned-off' }, T0 + 3_000)
    expect(toggled).toEqual({ ok: true, value: { delegation: inFlight, transition: 'S8.10' } })
    const stillAttempted = attempted()
    expect(applyEvent(stillAttempted, { type: 'setting-turned-off' }, T0 + 3_000)).toEqual({
      ok: true,
      value: { delegation: stillAttempted, transition: 'S8.10' }
    })

    const next = admitDelegation(
      admission({
        id: 'delegation-2' as DelegationId,
        ticket: 'ticket-2',
        preferences: { subagentDelegationOn: false },
        inFlight: { parent: 1, global: 1 }
      }),
      T0 + 4_000
    )
    expect(next.ok && next.value.transition).toBe('S8.02')
    expect(next.ok && next.value.delegation).toEqual({
      id: 'delegation-2',
      parentDwarfId: PARENT,
      ticket: 'ticket-2',
      state: 'failed',
      failure: 'gate-closed',
      createdAt: T0 + 4_000,
      settledAt: T0 + 4_000
    })
  })

  it('[INV-68] succeeded is reachable only with handoff phase delivered', () => {
    expect(applyEvent(running(), { type: 'handoff-delivered' }, T0 + 3_000)).toEqual({
      ok: false,
      error: 'handoff-not-sending'
    })
    for (const via of ['tool-result', 'turn-input'] as const) {
      const done = step(handingOff(via), { type: 'handoff-delivered' }, T0 + 3_000)
      expect(done.state).toBe('succeeded')
      expect(done.handoff).toEqual({ via, phase: 'delivered', phaseAt: T0 + 3_000 })
    }
    // A handoff begins only on a running delegation, once.
    expect(beginHandoff(attempted(), 'tool-result', T0)).toEqual({
      ok: false,
      error: 'not-running'
    })
    expect(beginHandoff(handingOff('tool-result'), 'tool-result', T0)).toEqual({
      ok: false,
      error: 'handoff-already-begun'
    })
    // The turn-input push failure needs a turn-input handoff in flight.
    expect(
      applyEvent(
        handingOff('tool-result'),
        { type: 'handoff-push-failed', parentSessionAlive: true },
        T0
      )
    ).toEqual({ ok: false, error: 'handoff-not-sending' })
  })
})
