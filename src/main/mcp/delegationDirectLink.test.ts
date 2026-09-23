import { describe, expect, it, vi } from 'vitest'
import type { DelegationRouting, ResultBody } from './delegationProtocol'
import { createDirectDelegationLink } from './delegationDirectLink'

/**
 * The in-process link a held Claude session's SDK tools call (#511 M1a) —
 * proven with a hand-written fake `delegate`/`result` pair, exactly the way
 * `delegationLink.test.ts` proves the HTTP twin with a hand-written
 * `DelegationFetch` fake: no real timers, no real network, no real service.
 */

const ROUTING: DelegationRouting = { provider: 'claude', model: 'sonnet' }

function fakeClock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = start
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    }
  }
}

describe('createDirectDelegationLink (#511 M1a)', () => {
  it('accepts a delegation and resolves done as soon as result() reports it, with no polling needed once settled', async () => {
    const clock = fakeClock()
    let state: ResultBody = { status: 'pending', routing: ROUTING }
    const link = createDirectDelegationLink({
      delegate: async () => ({ ticket: 'ticket-1', routing: ROUTING }),
      result: () => state,
      ...clock
    })

    state = { status: 'done', outcome: { kind: 'concluded', text: 'ok', endedAt: 1 } }
    const outcome = await link.delegate('find the bug', undefined, { waitMs: 5_000 })

    expect(outcome).toEqual({
      status: 'done',
      outcome: { kind: 'concluded', text: 'ok', endedAt: 1 }
    })
  })

  it('polls result() every DIRECT_DELEGATION_POLL_INTERVAL_MS until it stops answering pending', async () => {
    const clock = fakeClock()
    const result = vi.fn<() => ResultBody>()
    result
      .mockReturnValueOnce({ status: 'pending', routing: ROUTING })
      .mockReturnValueOnce({ status: 'pending', routing: ROUTING })
      .mockReturnValueOnce({
        status: 'done',
        outcome: { kind: 'concluded', text: 'ok', endedAt: 1 }
      })
    const link = createDirectDelegationLink({
      delegate: async () => ({ ticket: 'ticket-1', routing: ROUTING }),
      result,
      ...clock
    })

    const outcome = await link.delegate('find the bug', undefined, { waitMs: 10_000 })

    expect(result).toHaveBeenCalledTimes(3)
    expect(outcome.status).toBe('done')
  })

  it('answers pending with the ticket once the wait window elapses, never blocking forever', async () => {
    const clock = fakeClock()
    const link = createDirectDelegationLink({
      delegate: async () => ({ ticket: 'ticket-1', routing: ROUTING }),
      result: () => ({ status: 'pending', routing: ROUTING }),
      ...clock
    })

    const outcome = await link.delegate('find the bug', undefined, { waitMs: 2_000 })

    expect(outcome).toEqual({ status: 'pending', ticket: 'ticket-1', routing: ROUTING })
  })

  it('turns a delegate() failure into a failed tool result with no polling at all', async () => {
    const clock = fakeClock()
    const result = vi.fn<() => ResultBody>()
    const link = createDirectDelegationLink({
      delegate: async () => ({ failure: { kind: 'disabled', detail: 'off' } }),
      result,
      ...clock
    })

    const outcome = await link.delegate('find the bug', undefined, { waitMs: 5_000 })

    expect(outcome).toEqual({ status: 'failed', failure: { kind: 'disabled', detail: 'off' } })
    expect(result).not.toHaveBeenCalled()
  })

  it('result() echoes the ticket back onto a still-pending state, matching the tool result shape', async () => {
    const clock = fakeClock()
    const link = createDirectDelegationLink({
      delegate: async () => ({ ticket: 'ticket-1', routing: ROUTING }),
      result: () => ({ status: 'pending', routing: ROUTING }),
      ...clock
    })

    const outcome = await link.result('ticket-1')

    expect(outcome).toEqual({ status: 'pending', ticket: 'ticket-1', routing: ROUTING })
  })

  it('result() passes a done/failed state straight through', async () => {
    const clock = fakeClock()
    const link = createDirectDelegationLink({
      delegate: async () => ({ ticket: 'ticket-1', routing: ROUTING }),
      result: () => ({ status: 'failed', failure: { kind: 'unknown-ticket', detail: 'gone' } }),
      ...clock
    })

    expect(await link.result('ticket-1')).toEqual({
      status: 'failed',
      failure: { kind: 'unknown-ticket', detail: 'gone' }
    })
  })
})
