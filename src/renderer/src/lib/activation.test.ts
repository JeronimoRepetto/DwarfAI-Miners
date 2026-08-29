import { describe, expect, it } from 'vitest'
import type { DwarfActivation } from '../types'
import { shouldHidePanelAfterActivation } from './activation'

describe('shouldHidePanelAfterActivation', () => {
  it.each<[string, DwarfActivation]>([
    ['an existing terminal was focused', { focused: true, openedTerminal: false, feed: [] }],
    ['a new terminal was opened', { focused: false, openedTerminal: true, feed: [] }],
    [
      'neither succeeded and the transcript feed is shown instead',
      {
        focused: false,
        openedTerminal: false,
        feed: [{ role: 'assistant', text: 'x', timestamp: '' }]
      }
    ],
    ['nothing at all could be done', { focused: false, openedTerminal: false, feed: [] }]
  ])('never hides the always-on-top panel when %s', (_description, result) => {
    expect(shouldHidePanelAfterActivation(result)).toBe(false)
  })
})
