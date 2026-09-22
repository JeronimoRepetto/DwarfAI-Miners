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
})
