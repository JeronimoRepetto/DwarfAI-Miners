// layer: L1
// L1 (17 §1.1): the Host board the step-3a provider qualifiers read (providerQualifiers.ts `DwarfProviderLookup`; 21 §1
// item 2; 14 §4.3): a dwarf's provider as the last whole snapshot and every `dwarf.*` frame after it state it.
import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS, type SnapshotPage } from '@dwarfai/contracts'
import type { HostEvent } from '../window/ports/hostClient'
import { createDwarfProviderBoard } from './dwarfProviderBoard'

const [CLAUDE = '', CODEX = ''] = CATALOG_PROVIDER_IDS
const D1 = '01920000-0000-7000-9000-000000000401'
const D2 = '01920000-0000-7000-9000-000000000402'
const D3 = '01920000-0000-7000-9000-000000000403'

const wire = (id: string, providerId: string) => ({ id, providerId, mineId: 'm' })

/** A HostClient whose `subscribe` hands the test the handler. */
function hostOf() {
  let handler: ((event: HostEvent) => void) | undefined
  let unsubscribed = 0
  return {
    client: {
      subscribe: (h: (event: HostEvent) => void) => {
        handler = h
        return () => void (unsubscribed += 1)
      }
    },
    snapshot: (dwarfs: unknown[]) =>
      handler?.({
        kind: 'snapshot',
        snapshot: {
          seq: 1,
          chunks: [{ section: 'dwarfs', data: dwarfs }]
        } as unknown as SnapshotPage
      }),
    frame: (name: string, data: unknown) =>
      handler?.({ kind: 'frame', frame: { name, data, seq: 2 } } as unknown as HostEvent),
    unsubscribed: () => unsubscribed
  }
}

describe('dwarfProviderBoard', () => {
  it('[ADR-033] a dwarf has the provider the last snapshot and the dwarf frames after it state, and none once it departed', () => {
    const host = hostOf()
    const board = createDwarfProviderBoard(host.client)
    expect(board.providerOf(D1)).toBeUndefined()

    host.snapshot([wire(D1, CLAUDE), wire(D2, CODEX)])
    expect(board.providerOf(D1)).toBe(CLAUDE)
    expect(board.providerOf(D2)).toBe(CODEX)

    host.frame('dwarf.arrived', { dwarf: wire(D3, CODEX) })
    expect(board.providerOf(D3)).toBe(CODEX)
    host.frame('dwarf.departed', { dwarfId: D1 })
    expect(board.providerOf(D1)).toBeUndefined()

    // A snapshot replaces the board whole: a dwarf missing from it is gone (14 §4.3 rule 2).
    host.snapshot([wire(D2, CODEX)])
    expect(board.providerOf(D3)).toBeUndefined()
    expect(board.providerOf(D2)).toBe(CODEX)

    board.dispose()
    expect(host.unsubscribed()).toBe(1)
  })
})
