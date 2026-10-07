// The ConversationQueries double (16 §4.6 driving port; 16 §2.8). Never imported by production code
// (R14). A test seeds each dwarf's rows newest first; `feed` pages them by the 14 §3.6 rule — rows
// older than `before`, at most `limit` (default and maximum 50, INV-61), `reachedStart` once the
// oldest seeded row is in the page — and records every call, so a transport test can assert what
// reached the module and what never did. `mineHistory` answers the history seeded for the mine, or
// no speakers (a mine where nobody ever worked), and records each call in `historyCalls`.
// `outcomeOf` (owner amendment E, 2026-10-06) answers the line seeded for the dwarf, or null.
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { FeedPage, FeedPageRequest, MessageView, MineHistoryView } from '../domain/messages'
import type { OutcomeLine } from '../domain/outcomeLine'
import type { ConversationQueries } from '../index'

const PAGE_LIMIT = 50

export class FakeConversationQueries implements ConversationQueries {
  /** Every `feed` call, in call order. */
  readonly calls: Array<{ dwarfId: DwarfId; page?: FeedPageRequest }> = []
  /** Every `mineHistory` call, in call order. */
  readonly historyCalls: MineId[] = []
  private readonly rows = new Map<DwarfId, MessageView[]>()
  private readonly histories = new Map<MineId, MineHistoryView>()
  private readonly outcomes = new Map<DwarfId, OutcomeLine>()

  /** Sets the stored line `outcomeOf` answers for `line.dwarfId`. */
  seedOutcome(line: OutcomeLine): void {
    this.outcomes.set(line.dwarfId, structuredClone(line))
  }

  // Amended: 16 §4.6 ConversationQueries.outcomeOf (owner amendment E, 2026-10-06)
  outcomeOf(dwarfId: DwarfId): OutcomeLine | null {
    const line = this.outcomes.get(dwarfId)
    return line === undefined ? null : structuredClone(line)
  }

  /** Sets `dwarfId`'s stored rows, newest first. */
  seed(dwarfId: DwarfId, newestFirst: readonly MessageView[]): void {
    this.rows.set(dwarfId, structuredClone([...newestFirst]))
  }

  /** Sets the history `mineHistory` answers for `view.mineId`. */
  seedHistory(view: MineHistoryView): void {
    this.histories.set(view.mineId, structuredClone(view))
  }

  mineHistory(mineId: MineId): MineHistoryView {
    this.historyCalls.push(mineId)
    return structuredClone(this.histories.get(mineId) ?? { mineId, speakers: [] })
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
