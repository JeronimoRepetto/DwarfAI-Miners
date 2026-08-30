import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUBBLE_TTL_MS, createBubbleBoard } from './bubbles'

function lastCall(onChange: ReturnType<typeof vi.fn>): ReadonlyMap<string, string> {
  const call = onChange.mock.calls.at(-1)
  if (!call) throw new Error('onChange was never called')
  return call[0] as ReadonlyMap<string, string>
}

describe('createBubbleBoard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a bubble when a dwarf first appears with a message', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1', lastMessage: 'Digging the API layer' }])
    expect(lastCall(onChange).get('d1')).toBe('Digging the API layer')
    board.dispose()
  })

  it('truncates long messages to the bubble budget with an ellipsis', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1', lastMessage: 'x'.repeat(200) }])
    const text = lastCall(onChange).get('d1') as string
    expect(text.length).toBeLessThanOrEqual(70)
    expect(text.endsWith('…')).toBe(true)
    board.dispose()
  })

  it('auto-hides a bubble after the TTL', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1', lastMessage: 'hello' }])
    vi.advanceTimersByTime(BUBBLE_TTL_MS - 1)
    expect(lastCall(onChange).has('d1')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(lastCall(onChange).has('d1')).toBe(false)
    board.dispose()
  })

  it('does not re-show a hidden bubble for an unchanged message', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1', lastMessage: 'same' }])
    vi.advanceTimersByTime(BUBBLE_TTL_MS)
    onChange.mockClear()
    board.sync([{ id: 'd1', lastMessage: 'same' }])
    expect(onChange).not.toHaveBeenCalled()
    board.dispose()
  })

  it('re-shows the bubble when the message changes and restarts the TTL', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1', lastMessage: 'first' }])
    vi.advanceTimersByTime(BUBBLE_TTL_MS - 1000)
    board.sync([{ id: 'd1', lastMessage: 'second' }])
    expect(lastCall(onChange).get('d1')).toBe('second')
    vi.advanceTimersByTime(BUBBLE_TTL_MS - 1)
    expect(lastCall(onChange).get('d1')).toBe('second')
    vi.advanceTimersByTime(1)
    expect(lastCall(onChange).has('d1')).toBe(false)
    board.dispose()
  })

  it('shows nothing for a dwarf without a message', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1' }])
    expect(onChange).not.toHaveBeenCalled()
    board.dispose()
  })

  it('drops the bubble as soon as its dwarf disappears', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1', lastMessage: 'still here' }])
    board.sync([])
    expect(lastCall(onChange).has('d1')).toBe(false)
    onChange.mockClear()
    vi.runAllTimers()
    expect(onChange).not.toHaveBeenCalled()
    board.dispose()
  })

  it('tracks several dwarfs independently', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([
      { id: 'd1', lastMessage: 'one' },
      { id: 'd2', lastMessage: 'two' }
    ])
    const visible = lastCall(onChange)
    expect(visible.get('d1')).toBe('one')
    expect(visible.get('d2')).toBe('two')
    board.dispose()
  })

  it('goes silent after dispose', () => {
    const onChange = vi.fn()
    const board = createBubbleBoard(onChange)
    board.sync([{ id: 'd1', lastMessage: 'bye' }])
    onChange.mockClear()
    board.dispose()
    vi.runAllTimers()
    expect(onChange).not.toHaveBeenCalled()
  })

  describe('hold and release', () => {
    it('keeps a held bubble visible long past the TTL', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'reading this takes a while' }])
      board.hold('d1')
      vi.advanceTimersByTime(BUBBLE_TTL_MS * 5)
      expect(lastCall(onChange).has('d1')).toBe(true)
      board.dispose()
    })

    it('restarts a full TTL from the moment of release', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'held then released' }])
      vi.advanceTimersByTime(BUBBLE_TTL_MS - 1000)
      board.hold('d1')
      vi.advanceTimersByTime(BUBBLE_TTL_MS * 5)
      board.release('d1')
      vi.advanceTimersByTime(BUBBLE_TTL_MS - 1)
      expect(lastCall(onChange).has('d1')).toBe(true)
      vi.advanceTimersByTime(1)
      expect(lastCall(onChange).has('d1')).toBe(false)
      board.dispose()
    })

    it('ignores a hold for a dwarf with no visible bubble', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1' }])
      board.hold('d1')
      board.hold('ghost')
      vi.runAllTimers()
      expect(onChange).not.toHaveBeenCalled()
      board.dispose()
    })

    it('does not resurrect a bubble held after it already hid', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'gone before the hold' }])
      vi.advanceTimersByTime(BUBBLE_TTL_MS)
      onChange.mockClear()
      board.hold('d1')
      board.release('d1')
      vi.runAllTimers()
      expect(onChange).not.toHaveBeenCalled()
      board.dispose()
    })

    it('treats release without a prior hold as a no-op on the running TTL', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'never held' }])
      vi.advanceTimersByTime(BUBBLE_TTL_MS - 1000)
      board.release('d1')
      vi.advanceTimersByTime(1000)
      expect(lastCall(onChange).has('d1')).toBe(false)
      board.dispose()
    })

    it('updates the text of a held bubble on a message change without unholding it', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'first' }])
      board.hold('d1')
      board.sync([{ id: 'd1', lastMessage: 'second' }])
      expect(lastCall(onChange).get('d1')).toBe('second')
      vi.advanceTimersByTime(BUBBLE_TTL_MS * 5)
      expect(lastCall(onChange).get('d1')).toBe('second')
      board.release('d1')
      vi.advanceTimersByTime(BUBBLE_TTL_MS)
      expect(lastCall(onChange).has('d1')).toBe(false)
      board.dispose()
    })

    it('still drops a held bubble when its dwarf disappears', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'walking out mid-read' }])
      board.hold('d1')
      board.sync([])
      expect(lastCall(onChange).has('d1')).toBe(false)
      onChange.mockClear()
      board.release('d1')
      vi.runAllTimers()
      expect(onChange).not.toHaveBeenCalled()
      board.dispose()
    })

    it('collapses repeated holds into one: a single release resumes the TTL', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'double held' }])
      board.hold('d1')
      board.hold('d1')
      board.release('d1')
      vi.advanceTimersByTime(BUBBLE_TTL_MS)
      expect(lastCall(onChange).has('d1')).toBe(false)
      board.dispose()
    })

    it('stays silent when disposed while a bubble is held', () => {
      const onChange = vi.fn()
      const board = createBubbleBoard(onChange)
      board.sync([{ id: 'd1', lastMessage: 'held at teardown' }])
      board.hold('d1')
      onChange.mockClear()
      board.dispose()
      board.release('d1')
      vi.runAllTimers()
      expect(onChange).not.toHaveBeenCalled()
    })
  })
})
