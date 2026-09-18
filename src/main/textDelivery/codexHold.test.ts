import { describe, expect, it } from 'vitest'
import { CODEX_HOLD_MAX_MS, CodexHoldQueue, type HoldCodexRequest } from './codexHold'

function request(overrides: Partial<HoldCodexRequest> = {}): HoldCodexRequest {
  return {
    dwarfId: 'dwarf-1',
    threadId: 'thread-a',
    cwd: '/mine',
    text: 'first',
    observed: {},
    ...overrides
  }
}

describe('CodexHoldQueue', () => {
  it('answers a held message back for its own thread', () => {
    const queue = new CodexHoldQueue()
    const held = queue.hold(request({ text: 'hello' }), 1_000)

    expect(queue.next('thread-a')).toEqual(held)
    expect(held.text).toBe('hello')
    expect(held.heldAt).toBe(1_000)
  })

  it('answers nothing for a thread it holds nothing for', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request({ threadId: 'thread-a' }), 1_000)

    expect(queue.next('thread-b')).toBeUndefined()
  })

  it('answers one thread in the order the messages were held', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request({ text: 'first' }), 1_000)
    queue.hold(request({ text: 'second' }), 2_000)

    expect(queue.next('thread-a')?.text).toBe('first')
    expect(queue.next('thread-a')?.text).toBe('second')
    expect(queue.next('thread-a')).toBeUndefined()
  })

  it('keeps both messages whole rather than merging them into one turn', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request({ text: 'first' }), 1_000)
    queue.hold(request({ text: 'second' }), 2_000)

    expect(queue.held().map((message) => message.text)).toEqual(['first', 'second'])
  })

  it('gives every held message an id of its own', () => {
    const queue = new CodexHoldQueue()
    const one = queue.hold(request(), 1_000)
    const two = queue.hold(request(), 2_000)

    expect(one.holdId).not.toBe(two.holdId)
  })

  it('takes one message at a time, leaving the rest of that thread held', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request({ text: 'first' }), 1_000)
    queue.hold(request({ text: 'second' }), 2_000)

    queue.next('thread-a')

    expect(queue.held().map((message) => message.text)).toEqual(['second'])
  })

  it('names every thread it is holding something for', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request({ threadId: 'thread-a' }), 1_000)
    queue.hold(request({ threadId: 'thread-b' }), 2_000)
    queue.hold(request({ threadId: 'thread-a' }), 3_000)

    expect(queue.threads()).toEqual(['thread-a', 'thread-b'])
  })

  it('drops everything held for one dwarf, oldest first, and nobody else', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request({ dwarfId: 'dwarf-1', text: 'first' }), 1_000)
    queue.hold(request({ dwarfId: 'dwarf-2', threadId: 'thread-b', text: 'other' }), 2_000)
    queue.hold(request({ dwarfId: 'dwarf-1', text: 'second' }), 3_000)

    expect(queue.dropDwarf('dwarf-1').map((message) => message.text)).toEqual(['first', 'second'])
    expect(queue.held().map((message) => message.text)).toEqual(['other'])
  })

  it('drops nothing for a dwarf it holds nothing for', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request(), 1_000)

    expect(queue.dropDwarf('dwarf-9')).toEqual([])
    expect(queue.held()).toHaveLength(1)
  })

  it('gives up a message held past the bound and keeps one still inside it', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request({ text: 'stale', threadId: 'thread-a' }), 1_000)
    queue.hold(request({ text: 'fresh', threadId: 'thread-b' }), 1_000 + CODEX_HOLD_MAX_MS)

    const expired = queue.expired(1_000 + CODEX_HOLD_MAX_MS + 1)

    expect(expired.map((message) => message.text)).toEqual(['stale'])
    expect(queue.held().map((message) => message.text)).toEqual(['fresh'])
  })

  it('keeps a message held for exactly the bound, which has not elapsed yet', () => {
    const queue = new CodexHoldQueue()
    queue.hold(request(), 1_000)

    expect(queue.expired(1_000 + CODEX_HOLD_MAX_MS)).toEqual([])
    expect(queue.held()).toHaveLength(1)
  })

  it('carries the tuning and the launch owner a resume will need', () => {
    const queue = new CodexHoldQueue()
    const held = queue.hold(
      request({ observed: { model: 'gpt-5', effort: 'high' }, launchDwarfId: 'dwarf-1' }),
      1_000
    )

    expect(held.observed).toEqual({ model: 'gpt-5', effort: 'high' })
    expect(held.launchDwarfId).toBe('dwarf-1')
  })
})
