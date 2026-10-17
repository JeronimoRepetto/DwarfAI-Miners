// layer: L2
// The `TurnSender` bridge (16 §4.6 as extended by AMENDMENT-16, owner, 2026-10-15; 15 §1.2): a
// launched dwarf's turn reaches its driver session through suppliers' `SessionChannels`, and every
// answer becomes the receipt facts or a `DriverSendError`-shaped failure, never a silent loss.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MessageId, ProviderIdentity } from '../../kernel/domain/values'
import type { DriverSession, SendReceipt, TurnInput } from '../../modules/suppliers'
import { launchedTurnSender } from './turnSender'

const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId
const IDENTITY: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-1' }
const TURN: TurnInput = {
  messageId: '00000000-0000-7000-8000-0000000000a1' as MessageId,
  kind: 'message',
  text: 'dig',
  attachments: []
}

function session(sendTurn: (input: TurnInput) => Promise<SendReceipt>): DriverSession {
  return {
    ref: IDENTITY,
    capabilities: { reactionEvidence: 'turn-id' },
    sendTurn
  } as unknown as DriverSession
}

function bridge(found: DriverSession | null, identity: ProviderIdentity | null = IDENTITY) {
  const asked: unknown[] = []
  const sender = launchedTurnSender({
    dwarfs: { identityOf: () => identity },
    sessions: {
      sessionFor: (ref) => {
        asked.push(ref)
        return found
      }
    }
  })
  return { sender, asked }
}

describe('TurnSender bridge (conversation → suppliers)', () => {
  it('[ADR-022, S7.04, US-MSG-001.AC03] an accepted turn answers the receipt facts with the session reactionEvidence', async () => {
    const turns: TurnInput[] = []
    const { sender, asked } = bridge(
      session(async (input) => {
        turns.push(input)
        return {
          confidence: 'confirmed',
          heldUntilTurnEnd: false,
          correlation: 'c-1',
          providerTurnId: 't-1'
        }
      })
    )
    expect(await sender.send(DWARF, TURN)).toEqual({
      ok: true,
      value: {
        confidence: 'confirmed',
        heldUntilTurnEnd: false,
        correlation: 'c-1',
        providerTurnId: 't-1',
        reactionEvidence: 'turn-id'
      }
    })
    expect(asked).toEqual([IDENTITY])
    expect(turns).toEqual([TURN])
  })

  it('[FM-076, FM-078, S7.06, S7.07] a DriverSendError keeps its kind, and a channel-error keeps its reason', async () => {
    const closed = bridge(
      session(async () => {
        throw { kind: 'session-closed', reason: 'the session exited' }
      })
    )
    const broken = bridge(
      session(async () => {
        throw { kind: 'channel-error', reason: 'pipe closed' }
      })
    )
    expect(await closed.sender.send(DWARF, TURN)).toEqual({
      ok: false,
      error: { kind: 'session-closed' }
    })
    expect(await broken.sender.send(DWARF, TURN)).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: 'pipe closed' }
    })
  })

  it('[US-MSG-013.AC06, FM-078] a dwarf with no live session or no identity is session-closed, and anything else thrown is a channel error', async () => {
    expect(await bridge(null).sender.send(DWARF, TURN)).toEqual({
      ok: false,
      error: { kind: 'session-closed' }
    })
    expect(
      await bridge(
        session(async () => ({}) as SendReceipt),
        null
      ).sender.send(DWARF, TURN)
    ).toEqual({
      ok: false,
      error: { kind: 'session-closed' }
    })
    const odd = bridge(
      session(async () => {
        throw new Error('boom')
      })
    )
    expect(await odd.sender.send(DWARF, TURN)).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: 'the hand-over failed' }
    })
  })
})
