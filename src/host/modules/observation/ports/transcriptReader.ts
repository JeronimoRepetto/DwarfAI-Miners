// Driven port of observation (05 §3.3, 16 §4.3 `TranscriptReader`): the on-demand read of an
// observed dwarf's transcript, for history and rehydration. Type-only (05 §2.2).
//
// Package gap: `TranscriptEntry` is named but not defined; it is the `ConversationEntry` an
// adapter parses (15 §1.2), since the history renders the same rows the ingest stores.
import type { ConversationEntry } from '../../suppliers'
import type { ObservedSessionRef } from './observedSessionStore'

/** One transcript row of an observed dwarf, oldest first in an answer. */
export type TranscriptEntry = ConversationEntry

export interface TranscriptReader {
  // on-demand read for history/rehydration of observed dwarfs
  /**
   * Up to `limit` entries older than the entry whose `sourceKey` is `before` (the newest ones when
   * absent), oldest first; `[]` for an unreadable source (16 §4.3), never a throw.
   */
  entries(
    ref: ObservedSessionRef,
    window: { before?: string; limit: number }
  ): Promise<TranscriptEntry[]>
}
