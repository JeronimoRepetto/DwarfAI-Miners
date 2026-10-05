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
// - `mineHistory` joins with its issue (later: ISSUE-104).
import type { DwarfId } from '../../../kernel/domain/values'
import { toMessageView, type FeedPage, type FeedPageRequest } from '../domain/messages'
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
