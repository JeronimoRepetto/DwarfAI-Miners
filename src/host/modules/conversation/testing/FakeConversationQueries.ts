// The ConversationQueries double (16 §4.6 driving port; 16 §2.8). Never imported by production code
// (R14). A test seeds each dwarf's rows newest first; `feed` pages them by the 14 §3.6 rule — rows
// older than `before`, at most `limit` (default and maximum 50, INV-61), `reachedStart` once the
// oldest seeded row is in the page — and records every call, so a transport test can assert what
// reached the module and what never did.
import type { DwarfId } from '../../../kernel/domain/values'
import type { FeedPage, FeedPageRequest, MessageView } from '../domain/messages'
import type { ConversationQueries } from '../index'

const PAGE_LIMIT = 50

export class FakeConversationQueries implements ConversationQueries {
  /** Every `feed` call, in call order. */
  readonly calls: Array<{ dwarfId: DwarfId; page?: FeedPageRequest }> = []
  private readonly rows = new Map<DwarfId, MessageView[]>()

  /** Sets `dwarfId`'s stored rows, newest first. */
  seed(dwarfId: DwarfId, newestFirst: readonly MessageView[]): void {
    this.rows.set(dwarfId, structuredClone([...newestFirst]))
  }

  feed(dwarfId: DwarfId, page?: FeedPageRequest): FeedPage {
    this.calls.push(page === undefined ? { dwarfId } : { dwarfId, page: { ...page } })
    const all = this.rows.get(dwarfId) ?? []
    const from = page?.before === undefined ? 0 : all.findIndex((m) => m.id === page.before) + 1
    if (from === 0 && page?.before !== undefined)
      return { dwarfId, messages: [], reachedStart: true }
    const limit = Math.min(page?.limit ?? PAGE_LIMIT, PAGE_LIMIT)
    const messages = all.slice(from, from + limit)
    return {
      dwarfId,
      messages: structuredClone(messages),
      reachedStart: from + messages.length >= all.length
    }
  }
}
