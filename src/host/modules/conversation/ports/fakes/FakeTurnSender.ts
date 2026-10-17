// `FakeTurnSender` (16 §2.8 double of `TurnSender`, §4.6; 17 §2.2 `Fake<Port>`): the observed-session
// send paths in memory, passing `runTurnSenderContract` like `ObservedSessionTurnSender` (17 §1.3).
// A dwarf is relayed (its text "typed" into a terminal), queued (its text on its provider's queue) or
// has no send path. Never imported by production code (R14).
import type { DwarfId } from '../../../../kernel/domain/values'
import type { TurnInput } from '../../../suppliers'
import type { TurnSender, TurnSendResult } from '../turnSender'

export interface FakeTurnSenderRoutes {
  relayed?: readonly DwarfId[]
  queued?: readonly DwarfId[]
}

export class FakeTurnSender implements TurnSender {
  /** Every turn handed to `send`, in order, with its dwarf. */
  readonly sent: Array<{ dwarfId: DwarfId; turn: TurnInput }> = []
  private readonly relayed: Set<DwarfId>
  private readonly queued: Set<DwarfId>
  private readonly lost = new Set<DwarfId>()
  private readonly typedTexts: Array<{ dwarfId: DwarfId; text: string }> = []
  private readonly queuedTexts: Array<{ dwarfId: DwarfId; text: string }> = []

  constructor(routes: FakeTurnSenderRoutes = {}) {
    this.relayed = new Set(routes.relayed ?? [])
    this.queued = new Set(routes.queued ?? [])
  }

  /** Whether a send path exists for the dwarf (INV-33). */
  canDeliverTo(dwarfId: DwarfId): boolean {
    return this.relayed.has(dwarfId) || this.queued.has(dwarfId)
  }

  /** The relayed dwarf's terminal no longer is its recorded process when a write is due. */
  loseTarget(dwarfId: DwarfId): void {
    this.lost.add(dwarfId)
  }

  /** The texts typed into the dwarf's terminal. */
  typed(dwarfId: DwarfId): string[] {
    return this.typedTexts.filter((t) => t.dwarfId === dwarfId).map((t) => t.text)
  }

  /** The texts put on the dwarf's queue. */
  queuedFor(dwarfId: DwarfId): string[] {
    return this.queuedTexts.filter((t) => t.dwarfId === dwarfId).map((t) => t.text)
  }

  async send(dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> {
    this.sent.push({ dwarfId, turn })
    if (this.relayed.has(dwarfId)) {
      if (this.lost.has(dwarfId)) return { ok: false, error: { kind: 'session-closed' } }
      this.typedTexts.push({ dwarfId, text: turn.text.replace(/\s+/g, ' ').trim() })
      return { ok: true, value: handedOver(turn) }
    }
    if (this.queued.has(dwarfId)) {
      this.queuedTexts.push({ dwarfId, text: turn.text })
      return { ok: true, value: handedOver(turn) }
    }
    return { ok: false, error: { kind: 'session-closed' } }
  }
}

function handedOver(turn: TurnInput) {
  return {
    confidence: 'unconfirmed' as const,
    heldUntilTurnEnd: false,
    correlation: turn.messageId,
    reactionEvidence: 'transcript-match' as const
  }
}
