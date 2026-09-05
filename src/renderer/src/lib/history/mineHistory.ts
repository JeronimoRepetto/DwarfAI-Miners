import {
  MINE_HISTORY_MESSAGE_LIMIT,
  type FeedMessage,
  type MessageIssuer,
  type MineHistoryResult,
  type MineHistorySpeaker
} from '../../types'
import { authorOf, panelMessagesOf, type PanelMessage } from '../message/conversation'

/**
 * What the Mine History panel decides (#192), kept out of the component the
 * way `conversation.ts` keeps the message panel's decisions out of its own.
 *
 * `screens/history.md` fixes three things: tabs newest first by last-message
 * time, up to the latest fifty messages per tab, and a `Month DD, YYYY HH:MM`
 * timestamp at the lower right. Everything the source marks Unspecified is
 * resolved here by the defaults #192's maintainer comment settled — the
 * newest tab opens, the empty state is one line, local time is zero-padded
 * with the full English month — and each is named beside the code that spends
 * it, so the design can overrule one without a hunt.
 */

export const HISTORY_READING_NOTE = "Reading this mine's history..."
export const HISTORY_UNREADABLE_NOTE = "This mine's history could not be read."
export const HISTORY_EMPTY_NOTE = 'Nobody has spoken in this mine yet.'
/**
 * Said of the transcript region, never as chrome the design does not draw:
 * the CLIs prune their own transcripts (Claude Code after its
 * `cleanupPeriodDays`, 30 by default), so "the latest fifty" is a safe claim
 * and "everything ever said" never was. #192 asks for exactly this caveat.
 */
export const HISTORY_SCOPE_NOTE =
  'The latest 50 messages per dwarf, read from the transcripts the agent CLIs keep — they prune old ones themselves.'

/** Newest speaker first, by last-message time; ties break on id so a re-read cannot reshuffle them. */
export function orderSpeakers(speakers: readonly MineHistorySpeaker[]): MineHistorySpeaker[] {
  return [...speakers].sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.id.localeCompare(b.id))
}

/** The newest `limit` messages, still oldest first — the wire's order and the design's. */
export function latestMessages(
  messages: readonly FeedMessage[],
  limit: number = MINE_HISTORY_MESSAGE_LIMIT
): FeedMessage[] {
  return messages.slice(-limit)
}

/**
 * Which tab is open: the one the person chose while it still exists, else the
 * newest. A live re-read reorders tabs as dwarfs speak, and a selection that
 * followed the order would jump under the reader; one that followed the id
 * stays where they put it. Null when there is nothing to select.
 */
export function selectedSpeakerId(
  ordered: readonly MineHistorySpeaker[],
  current: string | null
): string | null {
  if (current !== null && ordered.some((speaker) => speaker.id === current)) return current
  return ordered[0]?.id ?? null
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * `Month DD, YYYY HH:MM`, the design's required format, spelled by hand rather
 * than through `toLocaleString`: the design fixes the shape, and a locale
 * formatter would move the day before the month, drop the zero padding or
 * translate the month on a machine whose language is not English. Local time,
 * because the person reading it is at the machine the message was written on.
 */
export function formatHistoryTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return ''
  const date = new Date(epochMs)
  const month = MONTHS[date.getMonth()]!
  return `${month} ${twoDigits(date.getDate())}, ${date.getFullYear()} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}

/** One row of a tab: the message, and whose face it is drawn under. */
export interface HistoryRow extends PanelMessage {
  author: MessageIssuer
}

/**
 * A speaker's transcript as rows, capped and attributed. The same `authorOf`
 * the message panel uses (#175): a prompt another agent issued wears that
 * agent's face, anything else wears the speaker's own.
 */
export function speakerRows(speaker: MineHistorySpeaker): HistoryRow[] {
  return panelMessagesOf(latestMessages(speaker.messages)).map((message) => ({
    ...message,
    author: authorOf(message, speaker)
  }))
}

/**
 * The one line the panel prints when there is no transcript to show, or null
 * when there is. Three ways to have nothing, and they are three different
 * statements — the same discipline `conversationOf` holds: "still reading"
 * becomes something, "nobody has spoken" may, and "could not be read" never
 * will, so none of them may be printed for another.
 */
export function historyNote(history: MineHistoryResult | undefined): string | null {
  if (history === undefined) return HISTORY_READING_NOTE
  if (!history.readable) return HISTORY_UNREADABLE_NOTE
  return history.speakers.length === 0 ? HISTORY_EMPTY_NOTE : null
}

/**
 * The one line #227 adds, admitting that a tab's oldest visible message is
 * not its conversation's first. `screens/history.md` never asked for this —
 * the design source is silent on both the placement and the copy — so both
 * are this issue's own invention, the way `panelHeight.ts` names the
 * constants the design left it to invent rather than pretending they came
 * from the PDF.
 */
export const HISTORY_TRUNCATED_NOTE = 'This tab does not reach the start of the conversation.'

/**
 * The truncation notice for one tab, or null when there is nothing to admit.
 *
 * `speaker.reachedStart` is `false`, `true` or absent (`MineHistorySpeaker` in
 * `contracts.ts`): only `false` draws the notice. Absent means unknown and
 * unknown says nothing, exactly like a known `true` — the design's own rule
 * for this field, so a future source that cannot compute it stays silent by
 * default rather than accidentally alarming. No selected speaker at all
 * (`undefined`) has nothing to admit either.
 */
export function speakerHistoryNotice(speaker: MineHistorySpeaker | undefined): string | null {
  return speaker?.reachedStart === false ? HISTORY_TRUNCATED_NOTE : null
}
