import type { Dwarf, DwarfFeedResult, FeedMessage, MessageIssuer } from '../../types'

/**
 * What the message panel may honestly draw for one dwarf (#159).
 *
 * The hard part of the panel is not the bubbles, it is that "the
 * conversation" means a different thing per session type — and the design
 * draws one surface for all of them. So the decision of WHAT is on screen, and
 * of what the panel claims it is, is made here rather than in the component:
 * a session type with nothing to show gets an empty state, never an invented
 * exchange (the capability-matrix discipline of
 * `docs/question-capture-evaluation.md`).
 *
 * Two sources, and the difference between them is a difference in evidence:
 *
 * - **held** — `Dwarf.conversation`: the words this app itself watched go by
 *   on a stream it is holding. First-hand, and complete for as far back as the
 *   retention bound reaches.
 * - **observed** — the provider's own bounded transcript tail (`DwarfFeedResult`,
 *   read on demand), or failing that the `lastMessage` every poll already
 *   carries. Second-hand and one write behind: a session writes its transcript
 *   when it feels like it, so this is the latest ACTIVITY rather than a live
 *   exchange, and the panel says so.
 *
 * A held session usually has both — the poll finds its transcript on disk like
 * any other — and the first-hand reading wins.
 */

export type ConversationSource = 'held' | 'observed' | 'none'

/** One bubble. `agent`/`user` rather than the wire's `assistant`, because the panel draws dwarfs. */
export interface PanelMessage {
  from: 'agent' | 'user'
  text: string
  /** A stable list key: the wire carries no message id, so position and time make one. */
  key: string
  /**
   * Who wrote it, when the wire named an agent rather than the human (#175).
   * Absent means whichever side `from` says: the human, or this dwarf itself.
   */
  issuer?: MessageIssuer
}

export interface PanelConversation {
  source: ConversationSource
  messages: PanelMessage[]
  /** One line saying what these messages ARE — never decoration, and never absent. */
  note: string
}

export const HELD_NOTE = 'This panel is holding this session — the exchange as it happened.'
export const OBSERVED_NOTE = "Latest activity, read from this session's own transcript."
export const READING_NOTE = "Reading this session's latest activity..."
export const NOTHING_SAID_NOTE = 'Nothing has been said in this session yet.'
export const NO_TRANSCRIPT_NOTE = 'This session keeps no transcript this panel can read.'
/**
 * Said in FRONT of whichever note above applies, for a dwarf the board reports
 * as leaving (#192). The ending changes nothing about what the words are —
 * first-hand or read from the transcript — so that claim stays; what changes
 * is that nothing further will be said, and the panel is now what is left of
 * the conversation rather than a window onto it.
 */
export const ENDED_NOTE = 'This session has ended.'

/**
 * Wire messages as the panel draws them. Exported since #192 because the Mine
 * History panel draws the same rows from the same wire shape, and two readings
 * of who is `agent` and who is `user` would eventually disagree.
 */
export function panelMessagesOf(messages: readonly FeedMessage[]): PanelMessage[] {
  return messages.map((message, index) => {
    // An issuer is an AGENT naming itself as the author, so the row is an agent
    // row whatever half of the exchange the wire's `role` calls it (#175). The
    // two say different things: `role` is which turn this is, and the issuer is
    // who took it — a coordinator's instruction to its worker is the worker's
    // user turn and was never the user's.
    const from = message.role === 'assistant' || message.issuer !== undefined ? 'agent' : 'user'
    return {
      from,
      text: message.text,
      key: `${from}-${index}-${message.timestamp}`,
      ...(message.issuer === undefined ? {} : { issuer: message.issuer })
    }
  })
}

/** The `lastMessage` every poll carries, as the one bubble it is — or nothing. */
function fromLastMessage(lastMessage: string | undefined): FeedMessage[] {
  if (lastMessage === undefined || lastMessage.trim() === '') return []
  // No timestamp on the wire for this one: the poll says what was last said,
  // never when. An empty string is the honest stand-in, and it is only ever
  // spent on a list key.
  return [{ role: 'assistant', text: lastMessage, timestamp: '' }]
}

/**
 * Resolve what to draw for `dwarf`, given whatever transcript read has come
 * back for it — `undefined` while one is still in flight, which is its own
 * answer rather than an empty one.
 */
export function conversationOf(
  dwarf: Pick<Dwarf, 'conversation' | 'lastMessage' | 'status'>,
  feed?: DwarfFeedResult
): PanelConversation {
  const shown = liveConversationOf(dwarf, feed)
  if (dwarf.status !== 'leaving') return shown
  return { ...shown, note: `${ENDED_NOTE} ${shown.note}` }
}

/** What the panel draws while the session is still there to be drawn. */
function liveConversationOf(
  dwarf: Pick<Dwarf, 'conversation' | 'lastMessage'>,
  feed?: DwarfFeedResult
): PanelConversation {
  if (dwarf.conversation !== undefined && dwarf.conversation.length > 0) {
    return { source: 'held', messages: panelMessagesOf(dwarf.conversation), note: HELD_NOTE }
  }

  const tail = feed !== undefined && feed.messages.length > 0 ? feed.messages : []
  const messages = tail.length > 0 ? tail : fromLastMessage(dwarf.lastMessage)
  if (messages.length > 0) {
    return { source: 'observed', messages: panelMessagesOf(messages), note: OBSERVED_NOTE }
  }

  // Three ways to have nothing, and they are three different statements. The
  // panel prints whichever one is true rather than one blank line for all of
  // them: "still reading" becomes something, "said nothing yet" may, and "no
  // transcript at all" never will.
  if (feed === undefined) return { source: 'none', messages: [], note: READING_NOTE }
  return {
    source: 'none',
    messages: [],
    note: feed.readable ? NOTHING_SAID_NOTE : NO_TRANSCRIPT_NOTE
  }
}

/**
 * Whose face and name one row is drawn with (#175).
 *
 * The panel draws a dwarf's own portrait against what it said, and that reading
 * only holds while the only agent in a conversation is the dwarf whose panel it
 * is. It is not: the prompt that STARTED an agent-launched session was written
 * by the agent above it, and drawing it as this dwarf would be the same error
 * one rank along from drawing it as the human.
 *
 * Here rather than in the component for the reason the whole module is: who
 * authored what is a decision, and the panel is thin.
 */
export function authorOf(
  message: PanelMessage,
  dwarf: Pick<Dwarf, 'role' | 'name'>
): MessageIssuer {
  return message.issuer ?? { role: dwarf.role, name: dwarf.name }
}

/**
 * The text the panel's opening height is derived from: the LATEST message,
 * whichever source it came from (see screens/mine.md). Empty when nothing was
 * said, which is what opens the panel at its floor.
 */
export function latestText(conversation: PanelConversation): string {
  return conversation.messages.at(-1)?.text ?? ''
}
