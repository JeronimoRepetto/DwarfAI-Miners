// The conversation driving port `ConversationQueries` (16 §4.6; 05 §3.6): `feed`, one page of a
// dwarf's feed from the Host's message log alone (ADR-007 item 6: a reopened chat never waits for
// a provider read). The snapshot's `tails` read it with `limit: SNAPSHOT_TAIL` and
// `conversation.feed` (B-M26) pages the rest (host/transport).
//
// - Newest first by `sort_at DESC, id DESC` (`MessageLog.page` as amended, ISSUE-103): every stored
//   row of the dwarf — DwarfAI-sent rows and answers-records included — mapped to `MessageView`
//   (06 §0.2: no `sourceKey`, `origin` or `askId`).
// - `limit` defaults to 50 and never exceeds it: at most 50 rows exist per dwarf (INV-61, PO #87),
//   and a caller asking for more still gets at most 50. The wire refuses a limit above 50 before
//   anything runs (14 §3.6); this bound holds for every other caller.
// - `reachedStart` reads one row more than the page: true when no older row exists, so a page that
//   holds exactly the oldest row says so, and the UI asks for nothing further.
// - `before` an unknown message: no row is older than it in this dwarf's log, an empty page at its
//   start.
//
// `mineHistory` (ISSUE-104; 14 §3.6 `MineHistoryView`; ADR-007 item 5; PO #87): the history panel's
// read, from the same log and the same ≤ 50 rows as the feed (INV-61).
//
// - Speakers are crew's `crewOf(mineId, { includeDeparted: true })` in its order (AMENDMENT-10):
//   present and departed dwarfs alike, each marked, with crew's `displayName`, `rank` and
//   `providerId` (owner amendment F, 2026-10-07: a departed speaker keeps its role portrait); a mine
//   where no dwarf was ever recorded has none ("Nobody has worked here yet.").
// - Each speaker's messages are its stored rows, oldest first for reading, undelivered ones
//   included with their `delivery` (06 §0.2 `MessageView`; no Retry, the history is read-only). A
//   dwarf with no row has none: nothing is ever read from a provider file (PO #87).
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { DwarfView } from '../../crew'
import {
  toMessageView,
  type FeedPage,
  type FeedPageRequest,
  type MineHistoryView
} from '../domain/messages'
import type { MessageLog } from '../ports/messageLog'

/** 14 §3.6: a page never exceeds 50 rows (at most 50 exist per dwarf, PO #87). */
export const FEED_PAGE_LIMIT = 50

export interface ConversationFeedQueriesDeps {
  log: Pick<MessageLog, 'page'>
}

export class ConversationFeedQueries {
  constructor(private readonly deps: ConversationFeedQueriesDeps) {}

  feed(dwarfId: DwarfId, page?: FeedPageRequest): FeedPage {
    const limit = Math.min(page?.limit ?? FEED_PAGE_LIMIT, FEED_PAGE_LIMIT)
    const rows = this.deps.log.page(dwarfId, {
      ...(page?.before === undefined ? {} : { before: page.before }),
      limit: limit + 1
    })
    return {
      dwarfId,
      messages: rows.slice(0, limit).map(toMessageView),
      reachedStart: rows.length <= limit
    }
  }
}

/**
 * What mine history reads of crew: 16 §4.2 `CrewQueries.crewOf` with `includeDeparted`
 * (AMENDMENT-10), over the conversation → crew edge (05 §1.3, R4). `CrewQueries` is assignable.
 */
export interface MineCrew {
  crewOf(
    mineId: MineId,
    opts: { includeDeparted: true }
  ): ReadonlyArray<Pick<DwarfView, 'id' | 'displayName' | 'rank' | 'providerId' | 'departed'>>
}

export interface ConversationMineHistoryDeps {
  log: Pick<MessageLog, 'page'>
  crew: MineCrew
}

export class ConversationMineHistory {
  constructor(private readonly deps: ConversationMineHistoryDeps) {}

  mineHistory(mineId: MineId): MineHistoryView {
    const crew = this.deps.crew.crewOf(mineId, { includeDeparted: true })
    return {
      mineId,
      speakers: crew.map((dwarf) => ({
        dwarfId: dwarf.id,
        displayName: dwarf.displayName,
        rank: dwarf.rank,
        providerId: dwarf.providerId,
        departed: dwarf.departed,
        // The feed's own read (newest first, at most 50), turned oldest first for reading.
        messages: this.deps.log
          .page(dwarf.id, { limit: FEED_PAGE_LIMIT })
          .reverse()
          .map(toMessageView)
      }))
    }
  }
}
