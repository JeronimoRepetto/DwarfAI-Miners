// layer: L2
// The `TurnSender` bridge (16 §4.6 as extended by AMENDMENT-16, owner, 2026-10-15; 15 §1.2): a
// launched dwarf's turn reaches its driver session through suppliers' `SessionChannels`, and every
// answer becomes the receipt facts or a `DriverSendError`-shaped failure, never a silent loss.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MessageId, ProviderIdentity } from '../../kernel/domain/values'
import type { DriverSession, SendReceipt, TurnInput } from '../../modules/suppliers'
import type { TurnSender } from '../../modules/conversation'
import { launchedTurnSender, observedSendTargets, routedTurnSender } from './turnSender'

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

describe('TurnSender bridge: launched sessions to their driver, observed dwarfs to the observed relay (ISSUE-167)', () => {
  const RECEIPT: SendReceipt = {
    confidence: 'confirmed',
    heldUntilTurnEnd: false,
    correlation: 'c-1'
  }
  const OBSERVED_RECEIPT = {
    ok: true as const,
    value: {
      confidence: 'unconfirmed' as const,
      heldUntilTurnEnd: false,
      correlation: 'm-1',
      reactionEvidence: 'transcript-match' as const
    }
  }

  function routed(opts: {
    live: DriverSession | null
    owned: boolean
    identity?: ProviderIdentity | null
  }) {
    const toObserved: DwarfId[] = []
    const observed: TurnSender = {
      send: async (dwarfId) => {
        toObserved.push(dwarfId)
        return OBSERVED_RECEIPT
      }
    }
    const sender = routedTurnSender({
      dwarfs: {
        identityOf: () => (opts.identity === undefined ? IDENTITY : opts.identity),
        owned: () => opts.owned
      },
      sessions: { sessionFor: () => opts.live },
      observed
    })
    return { sender, toObserved }
  }

  it('[ADR-022, S7.04] a dwarf with a live driver session is handed to its driver, never to the relay', async () => {
    const { sender, toObserved } = routed({ live: session(async () => RECEIPT), owned: true })
    expect(await sender.send(DWARF, TURN)).toMatchObject({
      ok: true,
      value: { confidence: 'confirmed' }
    })
    expect(toObserved).toEqual([])
  })

  it('[ADR-022, S7.04] an observed dwarf (not owned, no driver session) is handed to the observed relay', async () => {
    const { sender, toObserved } = routed({ live: null, owned: false })
    expect(await sender.send(DWARF, TURN)).toEqual(OBSERVED_RECEIPT)
    expect(toObserved).toEqual([DWARF])
  })

  it('[ADR-012, FM-078, S7.07] an owned dwarf whose session is gone, or a dwarf with no identity, is session-closed and never relayed', async () => {
    for (const opts of [
      { live: null, owned: true },
      { live: null, owned: false, identity: null }
    ]) {
      const { sender, toObserved } = routed(opts)
      expect(await sender.send(DWARF, TURN)).toEqual({
        ok: false,
        error: { kind: 'session-closed' }
      })
      expect(toObserved).toEqual([])
    }
  })

  it('[ADR-014, INV-33] an observed dwarf is a target with its provider identity and the process observation recorded; anything else is none', () => {
    const PROCESS = { pid: 7, processStartTimeMs: 1, bootId: 'b' }
    const view = (over: Partial<{ departed: boolean; owned: boolean }> = {}) => ({
      identity: IDENTITY,
      departed: false,
      owned: false,
      ...over
    })
    const targets = (
      dwarf: ReturnType<typeof view> | null,
      held = true,
      process: typeof PROCESS | null = PROCESS
    ) =>
      observedSendTargets({
        dwarfs: { get: () => dwarf },
        observation: {
          observedSessionOf: () => (held ? { dwarfId: DWARF, streamIds: ['s'] } : null)
        },
        processes: { processIdentityOf: () => process }
      })
    expect(targets(view()).targetOf(DWARF)).toEqual({
      providerId: 'simulated',
      providerSessionId: 'session-1',
      process: PROCESS
    })
    expect(targets(view(), true, null).targetOf(DWARF)).toEqual({
      providerId: 'simulated',
      providerSessionId: 'session-1',
      process: null
    })
    expect(targets(null).targetOf(DWARF)).toBeNull()
    expect(targets(view({ departed: true })).targetOf(DWARF)).toBeNull()
    expect(targets(view({ owned: true })).targetOf(DWARF)).toBeNull()
    expect(targets(view(), false).targetOf(DWARF)).toBeNull()
  })
})
