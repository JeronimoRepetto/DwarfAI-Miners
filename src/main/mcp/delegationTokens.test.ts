import { describe, expect, it } from 'vitest'
import { DelegationTokenRegistry } from './delegationTokens'

/**
 * The per-launch token registry in front of the delegation service (#511):
 * one token per parent launch, minted at injection time (T4) and identifying
 * that launch's own mine so the service knows where to launch a delegated
 * child. Pure — no HTTP, no crypto beyond an injectable generator.
 */

describe('DelegationTokenRegistry', () => {
  it('issues a token and answers the context it was issued for', () => {
    const registry = new DelegationTokenRegistry({ generateToken: () => 'tok-1' })
    const token = registry.issue({ mineId: 'mine:a' })
    expect(token).toBe('tok-1')
    expect(registry.contextFor('tok-1')).toEqual({ mineId: 'mine:a' })
  })

  it('mints a distinct token per call using the injected generator', () => {
    let n = 0
    const registry = new DelegationTokenRegistry({ generateToken: () => `tok-${++n}` })
    const first = registry.issue({ mineId: 'mine:a' })
    const second = registry.issue({ mineId: 'mine:b' })
    expect(first).not.toBe(second)
    expect(registry.contextFor(first)).toEqual({ mineId: 'mine:a' })
    expect(registry.contextFor(second)).toEqual({ mineId: 'mine:b' })
  })

  it('answers undefined for a token it never issued', () => {
    const registry = new DelegationTokenRegistry({ generateToken: () => 'tok-1' })
    expect(registry.contextFor('never-issued')).toBeUndefined()
  })

  it('forgets a token once revoked', () => {
    const registry = new DelegationTokenRegistry({ generateToken: () => 'tok-1' })
    registry.issue({ mineId: 'mine:a' })
    registry.revoke('tok-1')
    expect(registry.contextFor('tok-1')).toBeUndefined()
  })

  it('revoking an unknown token is a harmless no-op', () => {
    const registry = new DelegationTokenRegistry({ generateToken: () => 'tok-1' })
    expect(() => registry.revoke('never-issued')).not.toThrow()
  })

  it('generates real, distinct 32-hex-character tokens by default', () => {
    const registry = new DelegationTokenRegistry()
    const first = registry.issue({ mineId: 'mine:a' })
    const second = registry.issue({ mineId: 'mine:a' })
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toBe(second)
  })

  // #511 MEDIUM-1: `contextFor` used to be `this.contexts.get(token)` — a
  // plain `Map` lookup compares its key byte by byte and can return as soon
  // as two differ, the exact signal a constant-time compare exists to deny a
  // caller on the same machine timing its way toward a valid token. This
  // behavioural pin cannot itself prove the comparison is constant-time (no
  // synchronous unit test can observe timing without a flaky real clock,
  // which this codebase's own `tokensMatch` tests for `hookToken.ts` also
  // never attempt) — it only locks the answer a constant-time lookup and a
  // `Map.get` both give, so the fix is reviewed by reading `contextFor`,
  // not inferred from this test alone.
  it('rejects a forged token of the same length as one that was issued, but still accepts the real one', () => {
    const registry = new DelegationTokenRegistry({ generateToken: () => 'a'.repeat(32) })
    registry.issue({ mineId: 'mine:a' })
    expect(registry.contextFor('b'.repeat(32))).toBeUndefined()
    expect(registry.contextFor('a'.repeat(32))).toEqual({ mineId: 'mine:a' })
  })

  it('scans past one live token to find the one that actually matches', () => {
    let n = 0
    const registry = new DelegationTokenRegistry({ generateToken: () => `tok-${++n}` })
    registry.issue({ mineId: 'mine:a' })
    const second = registry.issue({ mineId: 'mine:b' })
    expect(registry.contextFor(second)).toEqual({ mineId: 'mine:b' })
  })
})
