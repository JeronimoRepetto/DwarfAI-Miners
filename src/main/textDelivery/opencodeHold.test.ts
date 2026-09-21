import { describe, expect, it } from 'vitest'
import { OPENCODE_HOLD_MAX_MS, OpenCodeHoldQueue, type HoldOpenCodeRequest } from './opencodeHold'

function request(overrides: Partial<HoldOpenCodeRequest> = {}): HoldOpenCodeRequest {
  return {
    dwarfId: 'dwarf-1',
    sessionId: 'session-a',
    cwd: '/mine',
    text: 'first',
    ...overrides
  }
}

describe('OpenCodeHoldQueue', () => {
  it('answers a held message back for its own session', () => {
    const queue = new OpenCodeHoldQueue()
    const held = queue.hold(request({ text: 'hello' }), 1_000)

    expect(queue.next('session-a')).toEqual(held)
    expect(held.text).toBe('hello')
    expect(held.heldAt).toBe(1_000)
  })

  it('answers nothing for a session it holds nothing for', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request({ sessionId: 'session-a' }), 1_000)

    expect(queue.next('session-b')).toBeUndefined()
  })

  it('answers one session in the order the messages were held', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request({ text: 'first' }), 1_000)
    queue.hold(request({ text: 'second' }), 2_000)

    expect(queue.next('session-a')?.text).toBe('first')
    expect(queue.next('session-a')?.text).toBe('second')
    expect(queue.next('session-a')).toBeUndefined()
  })

  it('keeps both messages whole rather than merging them into one turn', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request({ text: 'first' }), 1_000)
    queue.hold(request({ text: 'second' }), 2_000)

    expect(queue.held().map((message) => message.text)).toEqual(['first', 'second'])
  })

  it('gives every held message an id of its own', () => {
    const queue = new OpenCodeHoldQueue()
    const one = queue.hold(request(), 1_000)
    const two = queue.hold(request(), 2_000)

    expect(one.holdId).not.toBe(two.holdId)
  })

  /**
   * Mirroring the Codex queue's minting is not enough on its own: this
   * runtime can hold a Codex message and an OpenCode message in the SAME
   * pass, and DwarfSendSettledPush correlates by holdId alone. A collision
   * between the two queues' own counters would let one queue's verdict
   * settle the other queue's message.
   */
  it("never mints an id shaped like the Codex hold queue's own", () => {
    const queue = new OpenCodeHoldQueue()
    const held = queue.hold(request(), 1_000)

    expect(held.holdId).not.toMatch(/^hold:\d+$/)
  })

  it('takes one message at a time, leaving the rest of that session held', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request({ text: 'first' }), 1_000)
    queue.hold(request({ text: 'second' }), 2_000)

    queue.next('session-a')

    expect(queue.held().map((message) => message.text)).toEqual(['second'])
  })

  it('names every session it is holding something for', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request({ sessionId: 'session-a' }), 1_000)
    queue.hold(request({ sessionId: 'session-b' }), 2_000)
    queue.hold(request({ sessionId: 'session-a' }), 3_000)

    expect(queue.sessions()).toEqual(['session-a', 'session-b'])
  })

  it('drops everything held for one dwarf, oldest first, and nobody else', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request({ dwarfId: 'dwarf-1', text: 'first' }), 1_000)
    queue.hold(request({ dwarfId: 'dwarf-2', sessionId: 'session-b', text: 'other' }), 2_000)
    queue.hold(request({ dwarfId: 'dwarf-1', text: 'second' }), 3_000)

    expect(queue.dropDwarf('dwarf-1').map((message) => message.text)).toEqual(['first', 'second'])
    expect(queue.held().map((message) => message.text)).toEqual(['other'])
  })

  it('drops nothing for a dwarf it holds nothing for', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request(), 1_000)

    expect(queue.dropDwarf('dwarf-9')).toEqual([])
    expect(queue.held()).toHaveLength(1)
  })

  it('gives up a message held past the bound and keeps one still inside it', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request({ text: 'stale', sessionId: 'session-a' }), 1_000)
    queue.hold(request({ text: 'fresh', sessionId: 'session-b' }), 1_000 + OPENCODE_HOLD_MAX_MS)

    const expired = queue.expired(1_000 + OPENCODE_HOLD_MAX_MS + 1)

    expect(expired.map((message) => message.text)).toEqual(['stale'])
    expect(queue.held().map((message) => message.text)).toEqual(['fresh'])
  })

  it('keeps a message held for exactly the bound, which has not elapsed yet', () => {
    const queue = new OpenCodeHoldQueue()
    queue.hold(request(), 1_000)

    expect(queue.expired(1_000 + OPENCODE_HOLD_MAX_MS)).toEqual([])
    expect(queue.held()).toHaveLength(1)
  })
})
