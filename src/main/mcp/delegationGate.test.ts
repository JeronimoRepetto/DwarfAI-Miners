import { describe, expect, it } from 'vitest'
import type { DwarfProvider } from '../domain/types'
import { DELEGATION_CAPABLE_PROVIDERS, delegationEnabledFor } from './delegationGate'

/**
 * The three-level gate in front of the MCP subtask-delegation server (#511):
 * a TypeSafe key configured, the Settings checkbox on, and THIS launch
 * actually routed by Jev — all three required, and no substitute for any of
 * them. Pure and provider-aware: `delegationEnabledFor` is the one place the
 * whole decision is made, so T4's injection adapters have nothing left to
 * decide but how to wire a server in, never whether to.
 */

function input(overrides: Partial<Parameters<typeof delegationEnabledFor>[0]> = {}) {
  return {
    keyConfigured: true,
    delegation: true,
    routedByJev: true,
    provider: 'claude' as DwarfProvider,
    ...overrides
  }
}

describe('DELEGATION_CAPABLE_PROVIDERS', () => {
  it('names exactly Claude and OpenCode today', () => {
    expect(DELEGATION_CAPABLE_PROVIDERS).toEqual(['claude', 'opencode'])
  })
})

describe('delegationEnabledFor', () => {
  it('is true when every gate level holds and the provider is capable', () => {
    expect(delegationEnabledFor(input())).toBe(true)
    expect(delegationEnabledFor(input({ provider: 'opencode' }))).toBe(true)
  })

  it('is false with no TypeSafe key configured', () => {
    expect(delegationEnabledFor(input({ keyConfigured: false }))).toBe(false)
  })

  it('is false with the Settings checkbox off', () => {
    expect(delegationEnabledFor(input({ delegation: false }))).toBe(false)
  })

  it('is false when this launch was not itself routed by Jev', () => {
    expect(delegationEnabledFor(input({ routedByJev: false }))).toBe(false)
  })

  // Codex waits on one measurement (see the constant's own comment);
  // Antigravity is excluded on documented-mechanism grounds, not a gap.
  it.each(['codex', 'antigravity'] as const)(
    'is false for %s, whatever the other three levels say',
    (provider) => {
      expect(delegationEnabledFor(input({ provider }))).toBe(false)
    }
  )

  it('needs every level at once — two of three true is still false', () => {
    expect(delegationEnabledFor(input({ keyConfigured: false, delegation: false }))).toBe(false)
    expect(delegationEnabledFor(input({ delegation: false, routedByJev: false }))).toBe(false)
    expect(delegationEnabledFor(input({ keyConfigured: false, routedByJev: false }))).toBe(false)
  })
})
