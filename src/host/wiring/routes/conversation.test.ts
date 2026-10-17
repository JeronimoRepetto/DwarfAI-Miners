// layer: L2
// L2 (17 §1.2): the send path's `TurnSender` as `route` composes it (16 §4.6 row `TurnSender`;
// ISSUE-166, ISSUE-167): over crew's view of the dwarf, a launched dwarf's turn goes to its driver
// session, an observed dwarf's to the observed-session relay, and a departed dwarf, an owned dwarf
// whose session is gone, or an observed dwarf with no relay wired answers `session-closed`.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MessageId, ProviderIdentity } from '../../kernel/domain/values'
import type { TurnSender } from '../../modules/conversation'
import type { DriverSession, SendReceipt, TurnInput } from '../../modules/suppliers'
import { conversationTurns } from './conversation'

const DWARF = '00000000-0000-7000-8000-0000000167d1' as DwarfId
const IDENTITY: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-167' }
const TURN: TurnInput = {
  messageId: '00000000-0000-7000-8000-0000000167a1' as MessageId,
  kind: 'message',
  text: 'dig',
  attachments: []
}
const RECEIPT: SendReceipt = { confidence: 'confirmed', heldUntilTurnEnd: false, correlation: 'c' }
const RELAYED = {
  ok: true as const,
  value: {
    confidence: 'unconfirmed' as const,
    heldUntilTurnEnd: false,
    correlation: TURN.messageId,
    reactionEvidence: 'transcript-match' as const
  }
}

function world(opts: {
  dwarf: { departed: boolean; owned: boolean } | null
  live: boolean
  observed?: boolean
}) {
  const relayed: DwarfId[] = []
  const observedTurns: TurnSender = {
    send: async (dwarfId) => {
      relayed.push(dwarfId)
      return RELAYED
    }
  }
  const session = {
    ref: IDENTITY,
    capabilities: { reactionEvidence: 'turn-id' },
    sendTurn: async () => RECEIPT
  } as unknown as DriverSession
  const turns = conversationTurns({
    crew: {
      get: () => (opts.dwarf === null ? null : ({ identity: IDENTITY, ...opts.dwarf } as never))
    },
    sessions: { sessionFor: () => (opts.live ? session : null) },
    ...(opts.observed === false ? {} : { observedTurns })
  })
  return { turns, relayed }
}

describe('conversation route: the send path TurnSender', () => {
  it('[ADR-022, S7.04] a launched dwarf goes to its driver session, an observed dwarf to the observed relay', async () => {
    const launched = world({ dwarf: { departed: false, owned: true }, live: true })
    expect(await launched.turns.send(DWARF, TURN)).toMatchObject({
      ok: true,
      value: { confidence: 'confirmed', reactionEvidence: 'turn-id' }
    })
    expect(launched.relayed).toEqual([])
    const observed = world({ dwarf: { departed: false, owned: false }, live: false })
    expect(await observed.turns.send(DWARF, TURN)).toEqual(RELAYED)
    expect(observed.relayed).toEqual([DWARF])
  })

  it('[FM-078, S7.07] a departed or unknown dwarf, an owned dwarf whose session is gone, or no relay wired is session-closed', async () => {
    for (const opts of [
      { dwarf: null, live: false },
      { dwarf: { departed: true, owned: false }, live: false },
      { dwarf: { departed: false, owned: true }, live: false },
      { dwarf: { departed: false, owned: false }, live: false, observed: false }
    ]) {
      const { turns, relayed } = world(opts)
      expect({ opts, result: await turns.send(DWARF, TURN) }).toEqual({
        opts,
        result: { ok: false, error: { kind: 'session-closed' } }
      })
      expect(relayed).toEqual([])
    }
  })
})
