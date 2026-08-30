import { describe, expect, it } from 'vitest'
import {
  REACTION_WINDOW_MS,
  observeReaction,
  openReactionWatch,
  type ReactionSnapshot
} from './reaction'

/**
 * Reaction detection is fed nothing but the per-poll snapshots the panel
 * already receives, so every case here is a plain sequence of them — no timers,
 * no IPC, and an explicit clock reading per observation.
 */
function snapshot(overrides: Partial<ReactionSnapshot> = {}): ReactionSnapshot {
  return { status: 'working', ...overrides }
}

describe('openReactionWatch', () => {
  it('starts pending: a delivery is never a reaction on its own', () => {
    const watch = openReactionWatch('kick', snapshot(), 0)
    expect(watch.verdict).toBe('pending')
  })
})

describe('observeReaction for a kick', () => {
  it('promotes when the session stops working — the one thing a kick asks for', () => {
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'waiting' }), 1_000)
    expect(next.verdict).toBe('reacted')
  })

  it('stays pending while the session is still working', () => {
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'working' }), 1_000)
    expect(next.verdict).toBe('pending')
  })

  it('waits for the round trip when the session was already idle at delivery', () => {
    // Nothing was running, so "still waiting" proves nothing. The relayed kick
    // only becomes visible when the session wakes to read it and settles again.
    let watch = openReactionWatch('kick', snapshot({ status: 'waiting' }), 0)

    watch = observeReaction(watch, snapshot({ status: 'waiting' }), 1_000)
    expect(watch.verdict).toBe('pending')

    watch = observeReaction(watch, snapshot({ status: 'working' }), 2_000)
    expect(watch.verdict).toBe('pending')

    watch = observeReaction(watch, snapshot({ status: 'waiting' }), 3_000)
    expect(watch.verdict).toBe('reacted')
  })

  it('never claims a reaction from a session that simply disappeared', () => {
    // 'leaving' means the agent finished or vanished. That is not proof the
    // kick landed, and the marker must not say it was.
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'leaving' }), 1_000)
    expect(next.verdict).toBe('pending')
  })

  it('stays pending while the dwarf is missing from the snapshot entirely', () => {
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    const next = observeReaction(watch, undefined, 1_000)
    expect(next.verdict).toBe('pending')
  })
})

describe('observeReaction for a message', () => {
  it('promotes when the session produced a new message', () => {
    const watch = openReactionWatch('message', snapshot({ lastMessage: 'old' }), 0)
    const next = observeReaction(watch, snapshot({ lastMessage: 'new' }), 1_000)
    expect(next.verdict).toBe('reacted')
  })

  it('promotes when a first message appears where there was none', () => {
    const watch = openReactionWatch('message', snapshot({ lastMessage: undefined }), 0)
    const next = observeReaction(watch, snapshot({ lastMessage: 'on it' }), 1_000)
    expect(next.verdict).toBe('reacted')
  })

  it('promotes when an idle session picks up a turn', () => {
    const watch = openReactionWatch('message', snapshot({ status: 'waiting' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'working' }), 1_000)
    expect(next.verdict).toBe('reacted')
  })

  it('stays pending while nothing about the session changed', () => {
    const watch = openReactionWatch('message', snapshot({ status: 'working', lastMessage: 'a' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'working', lastMessage: 'a' }), 1_000)
    expect(next.verdict).toBe('pending')
  })

  it('does not read a finishing turn as a reaction to this message', () => {
    // working -> waiting only says the turn that was ALREADY running ended; the
    // queued message may still be unread.
    const watch = openReactionWatch('message', snapshot({ status: 'working', lastMessage: 'a' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'waiting', lastMessage: 'a' }), 1_000)
    expect(next.verdict).toBe('pending')
  })
})

describe('observeReaction bounds', () => {
  it('expires once the window has passed, instead of hanging forever', () => {
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'working' }), REACTION_WINDOW_MS)
    expect(next.verdict).toBe('expired')
  })

  it('expires even when the dwarf stopped appearing in snapshots', () => {
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    const next = observeReaction(watch, undefined, REACTION_WINDOW_MS + 1)
    expect(next.verdict).toBe('expired')
  })

  it('honours a caller-supplied window', () => {
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    expect(observeReaction(watch, undefined, 40, 50).verdict).toBe('pending')
    expect(observeReaction(watch, undefined, 50, 50).verdict).toBe('expired')
  })

  it('never downgrades a reaction that was already observed', () => {
    let watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    watch = observeReaction(watch, snapshot({ status: 'waiting' }), 1_000)
    expect(watch.verdict).toBe('reacted')

    watch = observeReaction(watch, snapshot({ status: 'working' }), REACTION_WINDOW_MS + 1)
    expect(watch.verdict).toBe('reacted')
  })

  it('bounds the window at a minute, so a marker can never outlive its usefulness', () => {
    expect(REACTION_WINDOW_MS).toBe(60_000)
  })
})

describe('observeReaction without a baseline', () => {
  it('adopts the first snapshot as the baseline instead of guessing one', () => {
    // A delivery fired before the first poll landed has nothing to compare
    // against; the first snapshot becomes the reference, never a reaction.
    let watch = openReactionWatch('message', undefined, 0)

    watch = observeReaction(watch, snapshot({ status: 'working', lastMessage: 'a' }), 1_000)
    expect(watch.verdict).toBe('pending')

    watch = observeReaction(watch, snapshot({ status: 'working', lastMessage: 'b' }), 2_000)
    expect(watch.verdict).toBe('reacted')
  })

  it('still expires when no snapshot ever arrives', () => {
    const watch = openReactionWatch('kick', undefined, 0)
    expect(observeReaction(watch, undefined, REACTION_WINDOW_MS).verdict).toBe('expired')
  })
})

describe('observeReaction purity', () => {
  it('returns a new watch rather than mutating the one it was given', () => {
    const watch = openReactionWatch('kick', snapshot({ status: 'working' }), 0)
    const next = observeReaction(watch, snapshot({ status: 'waiting' }), 1_000)

    expect(next).not.toBe(watch)
    expect(watch.verdict).toBe('pending')
  })
})
