import { describe, expect, it } from 'vitest'
import type { OpenCodePermissionPush } from './permissionPushPayload'
import { OpenCodePermissionRegistry, UNCLAIMED_ASK_GRACE_MS } from './openCodePermissionRegistry'

function asked(overrides: { requestId?: string; sessionId?: string } = {}): OpenCodePermissionPush {
  return {
    provider: 'opencode',
    kind: 'asked',
    serverUrl: 'http://127.0.0.1:63417/',
    sessionId: 'ses_1',
    requestId: 'per_1',
    permission: 'bash',
    ...overrides
  }
}

function replied(
  overrides: { requestId?: string; sessionId?: string } = {}
): OpenCodePermissionPush {
  return {
    provider: 'opencode',
    kind: 'replied',
    serverUrl: 'http://127.0.0.1:63417/',
    sessionId: 'ses_1',
    requestId: 'per_1',
    reply: 'once',
    ...overrides
  }
}

function registry(clock: { now: number }): OpenCodePermissionRegistry {
  return new OpenCodePermissionRegistry({ now: () => clock.now })
}

describe('OpenCodePermissionRegistry', () => {
  it('opens a pending ask for the session it named', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked())
    expect(asks.isOpen('ses_1')).toBe(true)
    expect(asks.askFor('ses_1')).toEqual(asked())
    expect(asks.isOpen('other')).toBe(false)
  })

  it('ignores a reply naming a session with no pending ask', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(replied())
    expect(asks.isOpen('ses_1')).toBe(false)
  })

  it('closes the ask once the matching reply arrives', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked())
    asks.note(replied())
    expect(asks.isOpen('ses_1')).toBe(false)
  })

  it('never closes a pending ask on a reply naming a different requestId', () => {
    // The only way this mismatch happens is a second ask having already
    // replaced the first (see the next test) -- a stale reply must never
    // clear the newer one.
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked({ requestId: 'per_1' }))
    asks.note(replied({ requestId: 'per_stale' }))
    expect(asks.isOpen('ses_1')).toBe(true)
  })

  it('replaces an earlier ask for the same session with a later one', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked({ requestId: 'per_1' }))
    asks.note(asked({ requestId: 'per_2' }))
    expect(asks.askFor('ses_1')).toEqual(asked({ requestId: 'per_2' }))
  })

  it('drops an ask nobody replied to once the grace window elapses', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked())
    clock.now += UNCLAIMED_ASK_GRACE_MS
    expect(asks.isOpen('ses_1')).toBe(false)
  })

  it('keeps an ask open right up to the grace boundary', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked())
    clock.now += UNCLAIMED_ASK_GRACE_MS - 1
    expect(asks.isOpen('ses_1')).toBe(true)
  })

  it('forgets a session on request, for a later slice to call once it learns the session ended', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked())
    asks.forget('ses_1')
    expect(asks.isOpen('ses_1')).toBe(false)
  })

  describe('pendingSessionIds() (#588 T4)', () => {
    // T4's own way of driving forget() on session end: a poll walks every id
    // this registry is still holding and forgets whichever one has left the
    // published board, mirroring runtime.ts's existing hosted-process sweep
    // (`this.hosted.states()`) generalised to a session this app never
    // started. Nothing else in this registry can enumerate its own keys.
    it('lists every session with a pending ask right now', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked({ sessionId: 'ses_1', requestId: 'per_1' }))
      asks.note(asked({ sessionId: 'ses_2', requestId: 'per_2' }))
      expect([...asks.pendingSessionIds()].sort()).toEqual(['ses_1', 'ses_2'])
    })

    it('answers empty with nothing pending', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      expect(asks.pendingSessionIds()).toEqual([])
    })

    it('drops a session once it is forgotten', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked({ sessionId: 'ses_1', requestId: 'per_1' }))
      asks.forget('ses_1')
      expect(asks.pendingSessionIds()).toEqual([])
    })
  })

  it('closes only the session named, leaving a sibling session alone', () => {
    const clock = { now: 1_000 }
    const asks = registry(clock)
    asks.note(asked({ sessionId: 'ses_1', requestId: 'per_1' }))
    asks.note(asked({ sessionId: 'ses_2', requestId: 'per_2' }))
    asks.note(replied({ sessionId: 'ses_1', requestId: 'per_1' }))
    expect(asks.isOpen('ses_1')).toBe(false)
    expect(asks.isOpen('ses_2')).toBe(true)
  })

  describe('observe() (#588 review D1)', () => {
    // isOpen()/askFor() perform their own lazy prune, so asserting through
    // them after the clock moves proves nothing about observe() itself --
    // the lazy check alone would make the same assertion pass with no sweep
    // at all. These read the map's own size instead, which only observe()
    // can change.
    it('sweeps a pending ask nothing ever replies to, without anything ever asking about that session again', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked())
      clock.now += UNCLAIMED_ASK_GRACE_MS
      asks.observe()
      expect(asks.size).toBe(0)
    })

    it('leaves a pending ask alone right up to the grace boundary', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked())
      clock.now += UNCLAIMED_ASK_GRACE_MS - 1
      asks.observe()
      expect(asks.size).toBe(1)
    })

    it('sweeps only the matured entry, leaving a sibling session alone', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked({ sessionId: 'ses_1', requestId: 'per_1' }))
      clock.now += UNCLAIMED_ASK_GRACE_MS
      asks.note(asked({ sessionId: 'ses_2', requestId: 'per_2' }))
      asks.observe()
      expect(asks.size).toBe(1)
      expect(asks.isOpen('ses_2')).toBe(true)
    })
  })

  describe('note() does not restart the grace clock on a duplicate ask (#588 review D2)', () => {
    it('keeps the original grace clock when the same requestId is re-raised', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked({ requestId: 'per_1' }))
      clock.now += 30_000
      // Re-raised: same requestId, same session -- several tool calls in one
      // assistant message can each raise their own permission.asked for the
      // same underlying ask.
      asks.note(asked({ requestId: 'per_1' }))
      clock.now += UNCLAIMED_ASK_GRACE_MS - 30_000
      // If note() had restarted the clock on the re-raise, this would still
      // be open (only 30s old by that wrong baseline); it must not be.
      expect(asks.isOpen('ses_1')).toBe(false)
    })

    it('does take a fresh grace clock when a genuinely new requestId replaces the pending one', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked({ requestId: 'per_1' }))
      clock.now += 50_000
      asks.note(asked({ requestId: 'per_2' }))
      clock.now += UNCLAIMED_ASK_GRACE_MS - 1
      expect(asks.isOpen('ses_1')).toBe(true)
    })
  })

  /**
   * #588 review F1/F3: a pending ask now tracks whether it has ever been
   * SEEN on a dwarf, not merely whether it is pending. `askFor()` is the one
   * call OpenCodeProvider makes while actually drawing a session's dwarf
   * (opencodeProvider.ts's `publish()`), so a defined answer from it IS the
   * "drawn" event -- there is no second, separate signal for it.
   */
  describe('drawn lifecycle (#588 review F1/F3)', () => {
    it('never-drawn: stays off drawnSessionIds(), so board-absence alone has nothing to act on', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked())
      // Nothing has called askFor()/isOpen() yet -- the session was never
      // found on a poll's board, F1's own concrete failure.
      expect(asks.drawnSessionIds()).toEqual([])
      expect(asks.pendingSessionIds()).toEqual(['ses_1'])
    })

    it('never-drawn: still ages out at the grace window exactly as before (unaffected by F3)', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked())
      clock.now += UNCLAIMED_ASK_GRACE_MS
      asks.observe()
      expect(asks.size).toBe(0)
    })

    it('drawn: askFor() returning the ask is what marks it drawn, and adds it to drawnSessionIds()', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked())
      expect(asks.drawnSessionIds()).toEqual([])
      expect(asks.askFor('ses_1')).toEqual(asked())
      expect(asks.drawnSessionIds()).toEqual(['ses_1'])
    })

    it('drawn: no longer ages out on the clock, unlike a never-drawn ask (#588 review F3)', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked())
      asks.askFor('ses_1') // drawn: a dwarf carried this card at least once
      // Two minutes -- twice the grace window -- with the dialog still open
      // the whole time. The window was written for an ask nobody has SEEN;
      // it must not govern one that is actually on screen.
      clock.now += UNCLAIMED_ASK_GRACE_MS * 2
      asks.observe()
      expect(asks.size).toBe(1)
      expect(asks.askFor('ses_1')).toEqual(asked())
    })

    it('a fresh requestId replacing a drawn ask starts undrawn again, taking its own grace window', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked({ requestId: 'per_1' }))
      asks.askFor('ses_1') // drawn
      clock.now += 10_000
      // A genuinely new ask for the same session -- e.g. the person answered
      // the first and the agent immediately hit a second gated call.
      asks.note(asked({ requestId: 'per_2' }))
      expect(asks.drawnSessionIds()).toEqual([])
      expect(asks.pendingSessionIds()).toEqual(['ses_1'])
    })

    it('a reply closes a drawn ask exactly as it closes an undrawn one', () => {
      const clock = { now: 1_000 }
      const asks = registry(clock)
      asks.note(asked())
      asks.askFor('ses_1')
      asks.note(replied())
      expect(asks.isOpen('ses_1')).toBe(false)
      expect(asks.drawnSessionIds()).toEqual([])
    })
  })
})
