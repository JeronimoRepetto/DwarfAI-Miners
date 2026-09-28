import {
  MINE_HISTORY_MESSAGE_LIMIT,
  type FailedSend,
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
/** The design's own empty line (screens/mine.md, Mine history), since #635. */
export const HISTORY_EMPTY_NOTE = 'Nobody has worked here yet.'
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

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/*
 * A time as the redesigned history prints it (#635): "HH:MM", local and zero-padded on a 24-hour
 * clock, spelled by hand so no locale moves or translates it. The `Month DD, YYYY HH:MM` footer the
 * old panel printed (formatHistoryTimestamp) went with the footer; the design draws none.
 */
export function historyClock(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return ''
  const date = new Date(epochMs)
  return twoDigits(date.getHours()) + ':' + twoDigits(date.getMinutes())
}

export function historyTitle(mineName: string): string {
  return 'History · ' + mineName
}

export function historyLabel(mineName: string): string {
  return 'Mine history, ' + mineName
}

/** Said at the head of the transcript: the cap is the wire's own, never a second copy of it. */
export const HISTORY_READ_ONLY_NOTE =
  'Read-only · up to the last ' + MINE_HISTORY_MESSAGE_LIMIT + ' messages'

/*
 * "last · HH:MM" under a tab's name, or "no messages" (copy.md, Mine history): the last timed entry
 * of the dwarf's conversation, a message it never received included (PANEL-QUESTIONS 16).
 */
export function historyTabLast(
  speaker: MineHistorySpeaker,
  failed: readonly FailedSend[] = []
): string {
  if (speaker.messages.length === 0 && failed.length === 0) return 'no messages'
  const last = Math.max(
    speaker.messages.length === 0 ? -Infinity : speaker.lastMessageAt,
    ...failed.map((send) => send.sentAt)
  )
  return 'last · ' + historyClock(last)
}

/*
 * The tabs, one per dwarf, in the order the mine's roster draws its crew (#635): the anatomy's
 * tabs follow the crew, and a dwarf in the same place in both is found in both. A dwarf that has
 * left the mine has no place in the roster, so those follow, newest first as the tabs were ordered
 * before (orderSpeakers).
 */
export function historyTabs(
  speakers: readonly MineHistorySpeaker[],
  crewIds: readonly string[]
): MineHistorySpeaker[] {
  const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]))
  const present = crewIds.flatMap((id) => byId.get(id) ?? [])
  const current = new Set(present.map((speaker) => speaker.id))
  return [...present, ...orderSpeakers(speakers.filter((speaker) => !current.has(speaker.id)))]
}

/** One row of a tab: the message, whose face it is drawn under, and its own time. */
export interface HistoryRow extends PanelMessage {
  author: MessageIssuer
  /** "HH:MM", or nothing where the transcript gave no time. */
  time: string
  /** A message the person sent that never reached the session (PANEL-QUESTIONS 16). */
  failed?: true
}

/**
 * A speaker's transcript as rows, capped and attributed. The same `authorOf`
 * the message panel uses (#175): a prompt another agent issued wears that
 * agent's face, anything else wears the speaker's own.
 */
export function speakerRows(
  speaker: MineHistorySpeaker,
  failed: readonly FailedSend[] = []
): HistoryRow[] {
  /*
   * A message that never arrived is part of what happened (PANEL-QUESTIONS 16): from the app's own
   * record of the send, placed among the transcript's messages by when it was sent, the latest
   * fifty of the two together.
   */
  const timed: { at: number; message: FeedMessage; failed: boolean }[] = [
    ...speaker.messages.map((message) => ({
      at: Date.parse(message.timestamp),
      message,
      failed: false
    })),
    ...failed.map((send) => ({
      at: send.sentAt,
      message: {
        role: 'user' as const,
        text: send.text,
        timestamp: new Date(send.sentAt).toISOString()
      },
      failed: true
    }))
  ]
  // A stable sort, and a row with no time keeps its place in the transcript.
  const ordered = failed.length === 0 ? timed : [...timed].sort((a, b) => (a.at || 0) - (b.at || 0))
  const kept = ordered.slice(-MINE_HISTORY_MESSAGE_LIMIT)
  return panelMessagesOf(kept.map((entry) => entry.message)).map((message, index) => ({
    ...message,
    author: authorOf(message, speaker),
    time: historyClock(kept[index]!.at),
    ...(kept[index]!.failed ? { failed: true as const } : {})
  }))
}

export type HistoryMark = 'delivered' | 'reacted' | 'failed'

/** A mark as the bubble draws it: text with a name, never colour alone (components.md, Chat bubble). */
export const HISTORY_MARK: Record<
  HistoryMark,
  { mark: HistoryMark; glyph: string; title: string }
> = {
  delivered: { mark: 'delivered', glyph: '✓', title: 'Handed over to the queue' },
  reacted: { mark: 'reacted', glyph: '✓✓', title: 'Seen acting on it' },
  // Without Retry or Copy: the history is read-only (PANEL-QUESTIONS 16).
  failed: { mark: 'failed', glyph: '✕ not delivered', title: 'Not delivered' }
}

/*
 * The delivery mark each row wears, read off the record itself (#635). Delivered and reacted are
 * different facts (AGENTS.md; reaction.ts): a prompt in the transcript was handed to the session,
 * so it is at least ✓, and it is ✓✓ only once the session was seen acting after it — a later turn
 * of its own, spoken or a step. A prompt another agent issued is not this session acting. The
 * dwarf's own words carry no mark, and a message that never reached the transcript is not in it
 * to mark: a live ✕ belongs to the MessagePanel.
 */
export function historyMarks(rows: readonly HistoryRow[]): (HistoryMark | undefined)[] {
  let actedAfter = false
  const marks: (HistoryMark | undefined)[] = new Array(rows.length).fill(undefined)
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.failed) marks[i] = 'failed'
    else if (row.from === 'user') marks[i] = actedAfter ? 'reacted' : 'delivered'
    else if (row.issuer === undefined) actedAfter = true
  }
  return marks
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
