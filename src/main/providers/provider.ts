import type { DwarfProvider, FeedMessage, FeedPageCursor, ProviderSnapshot } from '../domain/types'
import type { FeedWindowRead } from './feedWindow'
import type { TextDeliveryTarget } from '../textDelivery/port'

/**
 * Port implemented by every AI CLI detector. scan() returns one snapshot per
 * live session; feed() is the click-to-focus fallback (recent transcript
 * messages for a dwarf discovered by the latest scan).
 */
export interface Provider {
  readonly kind: DwarfProvider
  scan(): Promise<ProviderSnapshot[]>
  /** Last `limit` messages of the dwarf's transcript; null for unknown ids. */
  feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null>
  /**
   * The `limit` things SAID immediately OLDER than `before`, with the tool
   * calls between them — one page of scrollback (#364). Null for unknown ids,
   * exactly as `feed` is.
   *
   * A sibling of `feed` rather than a third parameter on it, for the reason
   * #227 kept `readFeedWindowWithReachedStart` beside `readFeedWindow`: this
   * read has to say whether anything older is left, and `feed` has never
   * carried that fact. `feed` is the newest page, it rides the poll for the
   * watched dwarf (#196), and it must stay the exact shape its callers already
   * read — a page's extra answer is not something they should have to unwrap to
   * keep not needing it.
   *
   * Optional on the port because a provider may have no transcript to page. An
   * absent method and a null answer are the same fact to the caller: this
   * conversation cannot be paged, which is NOT "there is nothing older" — see
   * DwarfFeedPage.
   */
  feedPage?(dwarfId: string, limit: number, before: FeedPageCursor): Promise<FeedWindowRead | null>
  /**
   * Path to the file backing feed(), used to open a terminal that tails the
   * transcript live when no window can be focused. Undefined for unknown ids.
   */
  transcriptPath?(dwarfId: string): string | undefined
  /**
   * The FIRST thing a person said in this dwarf's own session, off the head of
   * whatever store feed() reads the tail of (#191).
   *
   * The opposite end of the file from everything else here, and asked for a
   * different reason: it is the receipt that tells the panel which dwarf on
   * the board is the session it launched itself. Answered raw — see
   * firstPrompt.ts for why this one string is deliberately not redacted, and
   * for the bound on the read.
   *
   * Undefined covers an unknown id, a session that has recorded no human turn
   * yet, and a store this provider cannot read. None of the three is proof
   * about who the session belongs to, so the caller must treat them alike.
   */
  firstPrompt?(dwarfId: string): Promise<string | undefined>
  /**
   * Capability surface: how a typed message could reach this dwarf's live
   * session right now, or null when no channel exists (unknown id, or a
   * session type with no way in). Answered from data the latest scan already
   * read, so it stays a synchronous map lookup — the panel asks for every
   * dwarf on every poll to decide what actions to offer.
   */
  textDelivery?(dwarfId: string): TextDeliveryTarget | null
}
