import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_DELEGATIONS_GLOBAL } from './delegationConcurrency'
import { DEFAULT_MAX_RETAINED_TICKETS, DelegationTicketRegistry } from './delegationTickets'

/**
 * One delegated subtask's own ticket, from acceptance through its eventual
 * done/failed conclusion, with a bounded retention afterwards (#511). Pure —
 * an injected clock and id generator, no timers of its own; the service
 * calls `sweep()` on every request it handles, never on a schedule of its
 * own.
 */

const ROUTING = { provider: 'claude' as const, model: 'sonnet' }

describe('DelegationTicketRegistry', () => {
  it('creates a pending ticket carrying its routing', () => {
    const registry = new DelegationTicketRegistry({ generateTicketId: () => 't-1' })
    const ticket = registry.create('tok-1', ROUTING)
    expect(ticket).toBe('t-1')
    expect(registry.get('t-1', 'tok-1')).toEqual({ status: 'pending', routing: ROUTING })
  })

  it('answers undefined for a ticket presented with the WRONG token — indistinguishable from unknown', () => {
    const registry = new DelegationTicketRegistry({ generateTicketId: () => 't-1' })
    registry.create('tok-1', ROUTING)
    expect(registry.get('t-1', 'tok-2')).toBeUndefined()
  })

  it('answers undefined for a ticket id nobody ever created', () => {
    const registry = new DelegationTicketRegistry()
    expect(registry.get('never-created', 'tok-1')).toBeUndefined()
  })

  it('resolveDone moves a ticket to done with the outcome', () => {
    const registry = new DelegationTicketRegistry({ generateTicketId: () => 't-1' })
    registry.create('tok-1', ROUTING)
    const outcome = { kind: 'concluded' as const, text: 'done', endedAt: 5 }
    registry.resolveDone('t-1', outcome)
    expect(registry.get('t-1', 'tok-1')).toEqual({ status: 'done', outcome })
  })

  // `resolveFailed` itself was removed here (#511 LOW-5): it had no
  // production caller. A ticket is only ever created AFTER `launchChild`'s
  // own launch attempt already succeeded (`delegationService.ts`), so every
  // pre-launch failure this service can produce is refused inline, with no
  // ticket yet in existence for a "failed" state to attach to — wiring this
  // method in would have meant creating a ticket before knowing whether the
  // child launches at all, which no client is ever given the id to poll for.

  it('resolving an unknown ticket id is a harmless no-op', () => {
    const registry = new DelegationTicketRegistry()
    expect(() =>
      registry.resolveDone('never-created', { kind: 'concluded', endedAt: 1 })
    ).not.toThrow()
  })

  it('sweep drops a settled ticket once retentionMs has elapsed since it settled', () => {
    let now = 0
    const registry = new DelegationTicketRegistry({
      generateTicketId: () => 't-1',
      now: () => now,
      retentionMs: 1_000
    })
    registry.create('tok-1', ROUTING)
    registry.resolveDone('t-1', { kind: 'concluded', endedAt: 0 })
    now = 1_001
    registry.sweep()
    expect(registry.get('t-1', 'tok-1')).toBeUndefined()
  })

  it('sweep keeps a settled ticket younger than retentionMs', () => {
    let now = 0
    const registry = new DelegationTicketRegistry({
      generateTicketId: () => 't-1',
      now: () => now,
      retentionMs: 1_000
    })
    registry.create('tok-1', ROUTING)
    registry.resolveDone('t-1', { kind: 'concluded', endedAt: 0 })
    now = 500
    registry.sweep()
    expect(registry.get('t-1', 'tok-1')).toEqual({
      status: 'done',
      outcome: { kind: 'concluded', endedAt: 0 }
    })
  })

  it('sweep never drops a ticket still pending, however old', () => {
    let now = 0
    const registry = new DelegationTicketRegistry({
      generateTicketId: () => 't-1',
      now: () => now,
      retentionMs: 1_000
    })
    registry.create('tok-1', ROUTING)
    now = 999_999
    registry.sweep()
    expect(registry.get('t-1', 'tok-1')).toEqual({ status: 'pending', routing: ROUTING })
  })

  // The single test that used to stand here ("enforces a hard cap … by
  // evicting the oldest once exceeded") asserted that the FIRST-created
  // ticket was evicted once the cap was exceeded — but that ticket was still
  // PENDING, never resolved. That was #511 LOW-8's own bug: eviction must
  // never touch a still-pending ticket (see `sweep`'s own comment), so the
  // two tests below replace it — one pinning the corrected eviction
  // (skipping pending entries to find a settled one), one pinning the safe
  // fallback when nothing settled exists to evict at all.

  it('enforces a hard cap by evicting the oldest SETTLED ticket, never a pending one ahead of it', () => {
    let id = 0
    const registry = new DelegationTicketRegistry({
      generateTicketId: () => `t-${++id}`,
      maxRetained: 2
    })
    const pendingFirst = registry.create('tok-1', ROUTING)
    const settledSecond = registry.create('tok-1', ROUTING)
    registry.resolveDone(settledSecond, { kind: 'concluded', endedAt: 1 })
    registry.create('tok-1', ROUTING) // pushes the registry past the cap

    expect(registry.get(pendingFirst, 'tok-1')).toEqual({ status: 'pending', routing: ROUTING })
    expect(registry.get(settledSecond, 'tok-1')).toBeUndefined()
  })

  it('never evicts anything when every retained ticket is still pending, even over the cap', () => {
    let id = 0
    const registry = new DelegationTicketRegistry({
      generateTicketId: () => `t-${++id}`,
      maxRetained: 2
    })
    const first = registry.create('tok-1', ROUTING)
    const second = registry.create('tok-1', ROUTING)
    const third = registry.create('tok-1', ROUTING) // over the cap, none settled

    expect(registry.get(first, 'tok-1')).toEqual({ status: 'pending', routing: ROUTING })
    expect(registry.get(second, 'tok-1')).toEqual({ status: 'pending', routing: ROUTING })
    expect(registry.get(third, 'tok-1')).toEqual({ status: 'pending', routing: ROUTING })
  })

  it('the concurrency gate this app ships holds far fewer tickets pending than the retention cap allows, so that fallback is not reachable in production', () => {
    expect(DEFAULT_MAX_DELEGATIONS_GLOBAL).toBeLessThan(DEFAULT_MAX_RETAINED_TICKETS)
  })
})
