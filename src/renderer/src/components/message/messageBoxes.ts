/*
 * The conversation rows a chat view can be anchored to (ISSUE-293; ADR-024 item 3, `ChatViewState`; OQ-37 B): each
 * bubble the Host fed carries its message id (`data-message-id`), and its top is measured in the list's scroll
 * content, which is what `lib/chat/chatViewState` captures and restores against. Rows with no Host id are not anchors.
 */
import type { MessageId } from '@dwarfai/contracts'
import type { MessageBox } from '../../lib/chat/chatViewState'

/** The anchorable rows of a conversation list, in list order, each with its top in the list's scroll content. */
export function messageBoxesOf(list: HTMLElement): MessageBox[] {
  const origin = list.getBoundingClientRect().top - list.scrollTop
  return [...list.querySelectorAll<HTMLElement>('[data-message-id]')].map((row) => ({
    messageId: row.dataset['messageId'] as MessageId,
    top: row.getBoundingClientRect().top - origin
  }))
}
