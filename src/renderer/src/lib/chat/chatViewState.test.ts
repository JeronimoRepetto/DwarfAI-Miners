import type { MessageId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  captureChatView,
  captureScrollAnchor,
  restoredScrollTop,
  type MessageBox
} from './chatViewState'

const m = (id: string): MessageId => id as MessageId
/** Five messages, 100 px apart, in a 250 px tall list 500 px long. */
const MESSAGES: MessageBox[] = [0, 1, 2, 3, 4].map((i) => ({
  messageId: m(`msg-${i}`),
  top: i * 100
}))
const list = (scrollTop: number) => ({ scrollTop, scrollHeight: 500, clientHeight: 250 })

describe('chat view state (ADR-024 item 3)', () => {
  it('[INV-114] a scroll anchor is captured as a message id and offset, or bottom, and restores the same message at the same offset', () => {
    // Scrolled up: the message at the top of the view, and how far into it the view starts.
    const anchor = captureScrollAnchor(list(130), MESSAGES)
    expect(anchor).toEqual({ messageId: m('msg-1'), offsetPx: 30 })
    // In the other window the same messages sit lower (taller header): the same message at the same offset.
    const shifted = MESSAGES.map((box) => ({ ...box, top: box.top + 40 }))
    expect(restoredScrollTop(anchor, { scrollHeight: 540, clientHeight: 250 }, shifted)).toBe(170)

    // At the bottom (within a pixel or two): 'bottom', restored to the bottom whatever the length.
    expect(captureScrollAnchor(list(249), MESSAGES)).toBe('bottom')
    expect(restoredScrollTop('bottom', { scrollHeight: 900, clientHeight: 250 }, MESSAGES)).toBe(
      650
    )
    // A message the target does not have (not loaded there): the bottom, never a guessed pixel offset.
    expect(
      restoredScrollTop(
        { messageId: m('gone'), offsetPx: 10 },
        { scrollHeight: 500, clientHeight: 250 },
        MESSAGES
      )
    ).toBe(250)

    // The composer caret/selection travels with the anchor.
    expect(
      captureChatView(list(130), MESSAGES, {
        selectionStart: 2,
        selectionEnd: 7,
        selectionDirection: 'backward'
      })
    ).toEqual({
      scrollAnchor: { messageId: m('msg-1'), offsetPx: 30 },
      selection: { start: 2, end: 7, direction: 'backward' }
    })
    expect(captureChatView(list(249), MESSAGES, null)).toEqual({ scrollAnchor: 'bottom' })
  })
})
