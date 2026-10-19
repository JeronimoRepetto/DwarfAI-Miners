// The Host board as the step-3a provider qualifiers read it (providerQualifiers.ts `DwarfProviderLookup`; 21 §1 item 2;
// 14 §4.3): the provider of each present dwarf, from HostClient's whole snapshot and every `dwarf.*` frame after it
// (ADR-003 item 7: the client hands on a whole snapshot, then each newer frame, and re-snapshots on a resync itself).
// A snapshot replaces the board whole; `dwarf.departed` removes a dwarf. A dwarf the board does not hold has no
// provider here, so its call carries no qualifier and the unqualified route answers it, never a guess.
//
// Candidate decision (21 §6): no candidate exists in UI main; new code on the `BoardFacadeAdapter` reading pattern.
import type { HostFrames, ProviderId } from '@dwarfai/contracts'
import type { HostClient } from '../window/ports/hostClient'
import type { DwarfProviderLookup } from './providerQualifiers'

export interface DwarfProviderBoard extends DwarfProviderLookup {
  /** Stops reading the Host. */
  dispose(): void
}

export function createDwarfProviderBoard(
  client: Pick<HostClient, 'subscribe'>
): DwarfProviderBoard {
  let providers = new Map<string, ProviderId>()
  const unsubscribe = client.subscribe((event) => {
    if (event.kind === 'snapshot') {
      providers = new Map()
      for (const chunk of event.snapshot.chunks) {
        if (chunk.section === 'dwarfs') {
          for (const dwarf of chunk.data) providers.set(dwarf.id, dwarf.providerId)
        }
      }
      return
    }
    const { frame } = event
    if (frame.name === 'dwarf.arrived' || frame.name === 'dwarf.changed') {
      const { dwarf } = frame.data as HostFrames['dwarf.changed']
      providers.set(dwarf.id, dwarf.providerId)
    } else if (frame.name === 'dwarf.departed') {
      providers.delete((frame.data as HostFrames['dwarf.departed']).dwarfId)
    }
  })
  return {
    providerOf: (dwarfId) => providers.get(dwarfId),
    dispose: () => unsubscribe()
  }
}
