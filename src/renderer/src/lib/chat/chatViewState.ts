/*
 * Capture and restore of a chat's view state, exactly as ADR-024 item 3 writes `ChatViewState`
 * (ISSUE-284; OQ-37 B; INV-114): the scroll anchor is a message and how far into it the view
 * starts — never a pixel offset of the list, which differs between windows — or `'bottom'`; the
 * composer's caret/selection travels with it. Pure: the caller reads the list's geometry and each
 * message's top (in the list's scroll content) from the DOM and hands them in.
 */
import type { ChatViewState, MessageId } from '@dwarfai/contracts'

/** A message of the list and its top edge, in the list's scroll content. */
export interface MessageBox {
  messageId: MessageId
  top: number
}

/** The list's scroll geometry, as the element reports it. */
export interface ScrollGeometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** The composer's selection, as a textarea reports it (`null` when it has none). */
export interface ComposerSelection {
  selectionStart: number | null
  selectionEnd: number | null
  selectionDirection: 'forward' | 'backward' | 'none' | null
}

/** How close to the end of the list still counts as the bottom (sub-pixel scroll positions). */
const BOTTOM_TOLERANCE_PX = 2

/** The scroll anchor of a list scrolled to `list.scrollTop` over `messages`, in list order. */
export function captureScrollAnchor(
  list: ScrollGeometry,
  messages: readonly MessageBox[]
): ChatViewState['scrollAnchor'] {
  if (list.scrollHeight - list.clientHeight - list.scrollTop <= BOTTOM_TOLERANCE_PX) return 'bottom'
  let anchor: MessageBox | undefined
  for (const box of messages) {
    if (box.top <= list.scrollTop) anchor = box
    else break
  }
  if (anchor === undefined) return 'bottom'
  return { messageId: anchor.messageId, offsetPx: list.scrollTop - anchor.top }
}

/**
 * Where to scroll a list so `anchor` shows as it was captured: the same message at the same offset,
 * or the bottom. A message this list does not have reads as the bottom, never a guessed offset.
 */
export function restoredScrollTop(
  anchor: ChatViewState['scrollAnchor'],
  list: Omit<ScrollGeometry, 'scrollTop'>,
  messages: readonly MessageBox[]
): number {
  const bottom = Math.max(0, list.scrollHeight - list.clientHeight)
  if (anchor === 'bottom') return bottom
  const box = messages.find((candidate) => candidate.messageId === anchor.messageId)
  if (box === undefined) return bottom
  return Math.min(bottom, Math.max(0, box.top + anchor.offsetPx))
}

/** The whole `ChatViewState` of a chat: its scroll anchor and, when the composer has one, its selection. */
export function captureChatView(
  list: ScrollGeometry,
  messages: readonly MessageBox[],
  composer: ComposerSelection | null
): ChatViewState {
  const view: ChatViewState = { scrollAnchor: captureScrollAnchor(list, messages) }
  if (composer !== null && composer.selectionStart !== null && composer.selectionEnd !== null) {
    view.selection = {
      start: composer.selectionStart,
      end: composer.selectionEnd,
      direction: composer.selectionDirection ?? 'none'
    }
  }
  return view
}
