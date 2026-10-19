// The equality rule of `ProviderIdentity` (06 §3; ADR-015 item 7): equal on all three parts, an
// absent `providerAgentId` being the stored `''`. Pure: no I/O, no clock read (05 §2.2, R1).
import type { ProviderIdentity } from './values'

/** Whether two identities name the same provider session or subagent (INV-21). */
export function sameProviderIdentity(a: ProviderIdentity, b: ProviderIdentity): boolean {
  return providerIdentityKey(a) === providerIdentityKey(b)
}

/**
 * One string per identity, equal iff the identities are (INV-21): the three parts as a JSON
 * array, so no two identities collide by concatenation. The `DwarfArrived` / `DwarfRebound`
 * lifecycle facts are keyed by it (09 §5.6).
 */
export function providerIdentityKey(i: ProviderIdentity): string {
  return JSON.stringify([i.providerId, i.providerSessionId, i.providerAgentId ?? ''])
}
