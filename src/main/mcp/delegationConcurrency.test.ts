import { describe, expect, it } from 'vitest'
import { DelegationConcurrencyGate } from './delegationConcurrency'

/**
 * The fan-out bound in front of the delegation service (#511): each acquired
 * slot is a REAL agent CLI process this app is about to start, on a machine
 * that has already overheated once from unbounded concurrent launches — see
 * this module's own top comment for why the defaults are as small as they are.
 */

describe('DelegationConcurrencyGate', () => {
  it('acquires up to the per-parent limit for one token', () => {
    const gate = new DelegationConcurrencyGate({ perParent: 2, global: 10 })
    expect(gate.tryAcquire('tok-1')).toBe(true)
    expect(gate.tryAcquire('tok-1')).toBe(true)
    expect(gate.tryAcquire('tok-1')).toBe(false)
  })

  it('lets a different token acquire independently of another token’s own count', () => {
    const gate = new DelegationConcurrencyGate({ perParent: 1, global: 10 })
    expect(gate.tryAcquire('tok-1')).toBe(true)
    expect(gate.tryAcquire('tok-2')).toBe(true)
  })

  it('refuses once the GLOBAL cap is reached, even across many tokens each under their own limit', () => {
    const gate = new DelegationConcurrencyGate({ perParent: 5, global: 2 })
    expect(gate.tryAcquire('tok-1')).toBe(true)
    expect(gate.tryAcquire('tok-2')).toBe(true)
    expect(gate.tryAcquire('tok-3')).toBe(false)
  })

  it('lets a token acquire again once it releases a slot', () => {
    const gate = new DelegationConcurrencyGate({ perParent: 1, global: 10 })
    expect(gate.tryAcquire('tok-1')).toBe(true)
    expect(gate.tryAcquire('tok-1')).toBe(false)
    gate.release('tok-1')
    expect(gate.tryAcquire('tok-1')).toBe(true)
  })

  it('releasing frees a global slot too, letting another token in', () => {
    const gate = new DelegationConcurrencyGate({ perParent: 5, global: 1 })
    expect(gate.tryAcquire('tok-1')).toBe(true)
    expect(gate.tryAcquire('tok-2')).toBe(false)
    gate.release('tok-1')
    expect(gate.tryAcquire('tok-2')).toBe(true)
  })

  it('never goes negative when released more times than acquired', () => {
    const gate = new DelegationConcurrencyGate({ perParent: 1, global: 1 })
    gate.release('tok-1')
    gate.release('tok-1')
    expect(gate.tryAcquire('tok-1')).toBe(true)
  })

  it('uses the documented defaults when no limits are given', () => {
    const gate = new DelegationConcurrencyGate()
    for (let i = 0; i < 2; i++) expect(gate.tryAcquire('tok-1')).toBe(true)
    expect(gate.tryAcquire('tok-1')).toBe(false)
  })
})
