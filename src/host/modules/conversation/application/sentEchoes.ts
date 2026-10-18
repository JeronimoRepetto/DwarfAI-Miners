// `SentEchoes` (INV-60; ISSUE-182, amendment-16 lead decision of 2026-10-15): the person's messages
// handed to a launched session whose echo has not come back yet, in Host memory only. A driver
// echoes a message it was handed (`ConversationEntry.echoOf` = the receipt's correlation), and the
// echo can arrive before the hand-over's receipt names that correlation (ADR-007 item 3 assumes it
// is known at write). Without this record the echo is a second bubble of the same message.
//
// - `track` when the hand-over starts (the row is written, its delivery `sending`); `correlate` when
//   the receipt answers; `forget` when the hand-over failed (no echo will come).
// - `claim(dwarfId, entry, origin)`: a live-stream `person` entry of that dwarf is the echo of
//   - the waiting message whose known correlation it names (`echoOf`), whatever its text; or
//   - the oldest waiting message whose correlation is not known yet, or that names none, with the
//     same text as sent (trimmed).
//   The claimed message stops waiting: an echo is claimed once. Anything else claims nothing.
// - At most `WAITING_PER_DWARF` messages wait per dwarf (the oldest goes first).
// - Host memory only: a Host stopped between a send and its echo forgets it, and that echo is stored
//   as a row of its own (a recorded known risk, coordinator ruling on #1413).
import type { DwarfId, MessageId } from '../../../kernel/domain/values'
import type { ConversationEntry } from '../../suppliers'

/** How many sent messages of one dwarf may wait for their echo at once. */
export const WAITING_PER_DWARF = 8

interface Waiting {
  readonly dwarfId: DwarfId
  readonly messageId: MessageId
  readonly text: string
  correlation: string | null
}

export class SentEchoes {
  /** In hand-over order. */
  private readonly waiting: Waiting[] = []

  track(dwarfId: DwarfId, messageId: MessageId, text: string): void {
    this.forget(messageId)
    const ofDwarf = this.waiting.filter((w) => w.dwarfId === dwarfId)
    if (ofDwarf.length >= WAITING_PER_DWARF) this.remove(ofDwarf[0] as Waiting)
    this.waiting.push({ dwarfId, messageId, text: text.trim(), correlation: null })
  }

  correlate(messageId: MessageId, correlation: string): void {
    const w = this.waiting.find((candidate) => candidate.messageId === messageId)
    if (w !== undefined) w.correlation = correlation
  }

  forget(messageId: MessageId): void {
    const w = this.waiting.find((candidate) => candidate.messageId === messageId)
    if (w !== undefined) this.remove(w)
  }

  claim(
    dwarfId: DwarfId,
    entry: ConversationEntry,
    origin: 'live-stream' | 'transcript'
  ): MessageId | null {
    if (origin !== 'live-stream' || entry.role !== 'person') return null
    const ofDwarf = this.waiting.filter((w) => w.dwarfId === dwarfId)
    const { echoOf } = entry
    const byCorrelation =
      echoOf === undefined ? undefined : ofDwarf.find((w) => w.correlation === echoOf)
    const text = entry.text.trim()
    const claimed =
      byCorrelation ??
      ofDwarf.find((w) => w.text === text && (w.correlation === null || echoOf === undefined))
    if (claimed === undefined) return null
    this.remove(claimed)
    return claimed.messageId
  }

  private remove(w: Waiting): void {
    this.waiting.splice(this.waiting.indexOf(w), 1)
  }
}
