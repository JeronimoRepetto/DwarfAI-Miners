// `runTurnSenderContract` (16 §2.8, §4.6 row `TurnSender`: "SM5 delivery-mark machine incl.
// close/reopen", ADR-022 items 1–3; 17 §1.3: the double runs the same suite as the real adapter),
// for the observed-session side of the port (ISSUE-167): `FakeTurnSender` and
// `ObservedSessionTurnSender` over a `ProcessControl` double pass the same cases. Never imported by
// production code (R14).
//
// A world holds three observed dwarfs: one whose session takes a terminal relay (an observed
// Claude session), one whose session takes its provider's own queue (an observed Codex thread), and
// one of a provider with no recorded send path (an observed OpenCode session, 15 §3.1 O3).
import { describe, expect, it } from 'vitest'
import type { DwarfId, MessageId } from '../../../kernel/domain/values'
import type { TurnInput } from '../../suppliers'
import { advance, startDelivery } from '../domain/delivery'
import type { TurnSender } from '../ports/turnSender'

export interface TurnSenderContractWorld {
  sender: TurnSender
  /** Whether the sender has a delivery route to the dwarf (crew's `hasDeliveryRoute`, INV-33). */
  canDeliverTo(dwarfId: DwarfId): boolean
  /** An observed dwarf whose session takes the text relayed into its terminal. */
  relayed: DwarfId
  /** An observed dwarf whose session takes the text on its provider's own queue. */
  queued: DwarfId
  /** An observed dwarf of a provider with no recorded send path. */
  unrouted: DwarfId
  /** From now on, the relayed dwarf's terminal is not its recorded process at the moment of writing. */
  loseTargetBeforeWrite(): void
  /** Each text that reached the relayed dwarf's terminal, in order. */
  typed(): string[]
  /** Each text put on the queued dwarf's queue, in order. */
  queuedTexts(): string[]
}

const UNKNOWN = '00000000-0000-7000-8000-00000000dead' as DwarfId
const AT = 1_790_000_000_000

function turn(text: string, n = 1): TurnInput {
  return {
    messageId: `00000000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}` as MessageId,
    kind: 'message',
    text,
    attachments: []
  }
}

export function runTurnSenderContract(label: string, make: () => TurnSenderContractWorld): void {
  describe(`TurnSender contract (observed sessions): ${label}`, () => {
    it('[ADR-022, S7.04] a relayed turn is handed over unconfirmed and becomes reacted only on the transcript echo', async () => {
      const world = make()
      const sent = turn('dig the north tunnel')
      const result = await world.sender.send(world.relayed, sent)
      if (!result.ok) throw new Error(`the relay refused: ${JSON.stringify(result.error)}`)
      expect(result.value).toEqual({
        confidence: 'unconfirmed',
        heldUntilTurnEnd: false,
        correlation: expect.any(String) as unknown as string,
        reactionEvidence: 'transcript-match'
      })
      expect(result.value.correlation).not.toBe('')
      expect(world.typed()).toEqual(['dig the north tunnel'])

      // Machine 7: the receipt is ✓ unconfirmed (S7.04), and only transcript evidence of the kind
      // the receipt names moves it to ✓✓ (S7.05); no turn id was offered to wait on.
      const { delivery } = startDelivery({
        messageId: sent.messageId,
        dwarfId: world.relayed,
        kind: 'message',
        at: AT
      })
      const handedOver = advance(
        delivery,
        { t: 'accepted', confidence: result.value.confidence },
        AT + 1
      )
      if (!handedOver.ok) throw new Error('machine 7 refused the hand-over')
      expect(handedOver.delivery).toMatchObject({ phase: 'delivered', confidence: 'unconfirmed' })
      const echoed = advance(
        handedOver.delivery,
        { t: 'activity-correlated', reactionEvidence: result.value.reactionEvidence },
        AT + 2
      )
      expect(echoed.ok && echoed.delivery.phase).toBe('reacted')
    })

    it('[INV-33, S7.07] a provider with no recorded send path answers channel-closed and the dwarf cannot receive', async () => {
      const world = make()
      expect(world.canDeliverTo(world.unrouted)).toBe(false)
      expect(world.canDeliverTo(UNKNOWN)).toBe(false)
      expect(world.canDeliverTo(world.relayed)).toBe(true)
      expect(world.canDeliverTo(world.queued)).toBe(true)
      for (const dwarfId of [world.unrouted, UNKNOWN]) {
        expect(await world.sender.send(dwarfId, turn('dig'))).toEqual({
          ok: false,
          error: { kind: 'session-closed' }
        })
      }
      expect(world.typed()).toEqual([])
      expect(world.queuedTexts()).toEqual([])
    })

    it('[ADR-022] an observed Codex message is queued for the next turn and never written mid-turn', async () => {
      const world = make()
      const text = 'dig  the\nnorth tunnel'
      const result = await world.sender.send(world.queued, turn(text))
      if (!result.ok) throw new Error(`the queue refused: ${JSON.stringify(result.error)}`)
      expect(result.value).toMatchObject({
        confidence: 'unconfirmed',
        heldUntilTurnEnd: false,
        reactionEvidence: 'transcript-match'
      })
      expect(result.value.providerTurnId).toBeUndefined()
      expect(world.queuedTexts()).toEqual([text])
      expect(world.typed()).toEqual([])
    })

    it('[ADR-012] nothing is written when the target terminal cannot be positively identified just before writing', async () => {
      const world = make()
      world.loseTargetBeforeWrite()
      expect(await world.sender.send(world.relayed, turn('dig'))).toEqual({
        ok: false,
        error: { kind: 'session-closed' }
      })
      expect(world.typed()).toEqual([])
    })
  })
}
