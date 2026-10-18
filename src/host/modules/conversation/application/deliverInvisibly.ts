// `ConversationCommands.deliverInvisibly` (05 §3.6, 16 §4.6 row `deliverInvisibly`; ADR-013 item 6;
// 11 F6 step 7; UC-017 "Turn-input handoff"; ISSUE-205) and the ingest side of the same rule.
//
// - `deliverInvisibly(parent, text)`: a delegation result pushed to the parent's session as turn
//   input, for a driver that needs it (the `ParentDeliverer` bridge is its only caller). The text
//   must carry the DwarfAI handoff marker on its first line (domain/handoffMarker.ts): an unmarked
//   text is refused `failed` and never pushed, because its echo could not be told from the parent's
//   own chat. A dwarf that cannot receive (`canReceiveMessages` false, INV-33) is `cannot-receive`.
//   Otherwise ONE `TurnSender.send` with `TurnInput.kind = 'handoff'`: accepted → `delivered`; a
//   closed session → `cannot-receive`; a channel error or a rejected send → `failed`. It is never
//   retried (ADR-013 O-13b) and writes no `messages` and no `deliveries` row and publishes nothing
//   (INV-68, PO #87 literal): the delegation records the outcome on `Delegation.handoff`. The text
//   is never logged or stored (NFR-SEC-12).
// - The ingest side (`recognise`, applied by `createConversation` to every batch before `ingest`):
//   an entry whose first line carries the marker of a delegation pushed to THAT dwarf is its echo,
//   flagged `handoffEcho`, so the log claims its `message_keys` key with no message (09 §5.2) and
//   nothing is published. A marker this Host did not push to that dwarf is ordinary text (18 T-25,
//   C-26: an agent printing a marker makes nothing disappear). The marker is remembered before the
//   push, so an echo read while the hand-over is in flight is recognised too.
//
// The remembered markers are Host memory, bounded per dwarf (`MARKERS_KEPT`): after a Host restart
// a late echo of an earlier push is shown as ordinary text (truthful, never hidden by a guess).
import type { DwarfId, MessageId, Result } from '../../../kernel/domain/values'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { ConversationEntry } from '../../suppliers'
import { handoffMarkOf } from '../domain/handoffMarker'
import type { TurnSender } from '../ports/turnSender'
import type { MessageRecipients } from './send'

/** 16 §4.6 `ConversationCommands.deliverInvisibly` (the copy of 05 §3.6). */
export interface ConversationDeliverCommand {
  deliverInvisibly(
    parent: DwarfId,
    text: string
  ): Promise<Result<'delivered', 'cannot-receive' | 'failed'>> // delegation result pushed as turn input with the DwarfAI handoff marker (ADR-013 item 6); writes NO message row (PO #87 literal, 06 INV-68); the caller records the outcome on Delegation.handoff
}

/** The pushed markers kept per dwarf (a parent holds at most two delegations in flight). */
export const MARKERS_KEPT = 16

export class InvisibleHandoffs {
  /** The delegation ids whose marked result was pushed to each dwarf, oldest first. */
  private readonly pushed = new Map<DwarfId, string[]>()

  constructor(private readonly deps: { ids: IdGenerator }) {}

  async deliverInvisibly(
    parent: DwarfId,
    text: string,
    route: { turns: TurnSender; recipients: MessageRecipients }
  ): Promise<Result<'delivered', 'cannot-receive' | 'failed'>> {
    const delegationId = handoffMarkOf(text)
    if (delegationId === null) return { ok: false, error: 'failed' }
    if (!route.recipients.canReceiveMessages(parent)) return { ok: false, error: 'cannot-receive' }
    this.remember(parent, delegationId)
    try {
      const sent = await route.turns.send(parent, {
        // Required by `TurnInput`; no row carries it (INV-68).
        messageId: this.deps.ids.uuidv7() as MessageId,
        kind: 'handoff',
        text,
        attachments: []
      })
      if (sent.ok) return { ok: true, value: 'delivered' }
      return {
        ok: false,
        error: sent.error.kind === 'session-closed' ? 'cannot-receive' : 'failed'
      }
    } catch {
      return { ok: false, error: 'failed' }
    }
  }

  /** The batch with each echo of a handoff pushed to `dwarfId` flagged `handoffEcho`. */
  recognise(dwarfId: DwarfId, entries: ConversationEntry[]): ConversationEntry[] {
    const known = this.pushed.get(dwarfId)
    if (known === undefined) return entries
    return entries.map((entry) => {
      const marked = handoffMarkOf(entry.text)
      return marked !== null && known.includes(marked) ? { ...entry, handoffEcho: true } : entry
    })
  }

  private remember(dwarfId: DwarfId, delegationId: string): void {
    const known = this.pushed.get(dwarfId) ?? []
    if (!known.includes(delegationId)) known.push(delegationId)
    this.pushed.set(dwarfId, known.slice(-MARKERS_KEPT))
  }
}
