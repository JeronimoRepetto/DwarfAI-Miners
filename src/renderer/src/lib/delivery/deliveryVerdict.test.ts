import { describe, expect, it } from 'vitest'
import type { DwarfKickState, DwarfSendState } from '../../types'
import {
  kickEndedTheSession,
  kickMarker,
  kickStatusLine,
  sendMarker,
  sendStatusLine
} from './deliveryVerdict'

/**
 * The whole point of the two-phase verdict: "delivered" means the message was
 * handed to the session's queue, which is NOT the same as the session acting on
 * it. Every string below has to keep those two apart.
 */

describe('sendMarker', () => {
  it('shows nothing when there is no delivery to report', () => {
    expect(sendMarker(undefined)).toBeNull()
  })

  it('marks an in-flight send', () => {
    const marker = sendMarker({ phase: 'sending' })
    expect(marker?.glyph).toBe('…')
    expect(marker?.cls).toBe('is-sending')
  })

  it('says the message was handed over, not that it was acted on', () => {
    const state: DwarfSendState = {
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: true
    }
    const marker = sendMarker(state)

    expect(marker?.glyph).toBe('✓')
    expect(marker?.cls).toBe('is-delivered')
    expect(marker?.title).toMatch(/handed to the session/i)
    expect(marker?.title).not.toMatch(/reacted/i)
  })

  it('admits when the window closed without a reaction', () => {
    const state: DwarfSendState = {
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: false
    }
    expect(sendMarker(state)?.title).toMatch(/no reaction/i)
  })

  it('claims a reaction only once one was observed', () => {
    const marker = sendMarker({ phase: 'reacted', via: 'claude-relay' })
    expect(marker?.glyph).toBe('✓✓')
    expect(marker?.cls).toBe('is-reacted')
    expect(marker?.title).toMatch(/reacted/i)
  })

  it('carries the failure reason so the marker can explain itself', () => {
    const marker = sendMarker({ phase: 'failed', via: 'terminal', error: 'The relay timed out.' })
    expect(marker?.glyph).toBe('✕')
    expect(marker?.cls).toBe('is-failed')
    expect(marker?.title).toBe('The relay timed out.')
  })

  it('falls back to a plain reason when the failure carried none', () => {
    expect(sendMarker({ phase: 'failed', via: 'terminal' })?.title).toBeTruthy()
  })
})

describe('kickMarker', () => {
  it('shows nothing when there is no kick to report', () => {
    expect(kickMarker(undefined)).toBeNull()
  })

  it('marks an in-flight kick', () => {
    expect(kickMarker({ phase: 'kicking' })?.glyph).toBe('…')
  })

  it('says the kick was handed over, not that the session stopped', () => {
    const state: DwarfKickState = {
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: true
    }
    const marker = kickMarker(state)

    expect(marker?.glyph).toBe('✓')
    expect(marker?.title).toMatch(/handed to the session/i)
    expect(marker?.title).not.toMatch(/reacted|stopped/i)
  })

  it('claims a reaction only once the session was seen acting on it', () => {
    const marker = kickMarker({ phase: 'reacted', via: 'terminal' })
    expect(marker?.glyph).toBe('✓✓')
    expect(marker?.cls).toBe('is-reacted')
    expect(marker?.title).toMatch(/reacted/i)
  })

  it('carries the failure reason', () => {
    const marker = kickMarker({ phase: 'failed', via: 'terminal', error: 'No console to reach.' })
    expect(marker?.title).toBe('No console to reach.')
  })
})

describe('sendStatusLine', () => {
  it('names the channel and stops short of claiming a reaction', () => {
    const line = sendStatusLine({ phase: 'delivered', via: 'claude-relay', awaitingReaction: true })
    expect(line).toContain('claude-relay')
    expect(line).toMatch(/handed/i)
    expect(line).not.toMatch(/reacted/i)
  })

  it('reports the reaction once it is real', () => {
    const line = sendStatusLine({ phase: 'reacted', via: 'terminal' })
    expect(line).toContain('terminal')
    expect(line).toMatch(/reacted/i)
  })

  it('says so when the window closed unobserved', () => {
    const line = sendStatusLine({ phase: 'delivered', via: 'terminal', awaitingReaction: false })
    expect(line).toMatch(/no reaction/i)
  })

  it('has nothing to say about an in-flight or failed send', () => {
    expect(sendStatusLine({ phase: 'sending' })).toBeNull()
    expect(sendStatusLine({ phase: 'failed', via: 'terminal', error: 'nope' })).toBeNull()
    expect(sendStatusLine(undefined)).toBeNull()
  })
})

describe('kickStatusLine', () => {
  it('names the channel and stops short of claiming the session stopped', () => {
    const line = kickStatusLine({ phase: 'delivered', via: 'claude-relay', awaitingReaction: true })
    expect(line).toContain('claude-relay')
    expect(line).toMatch(/handed/i)
    expect(line).not.toMatch(/reacted/i)
  })

  it('reports the reaction once it is real', () => {
    expect(kickStatusLine({ phase: 'reacted', via: 'terminal' })).toMatch(/reacted/i)
  })

  it('has nothing to say about an in-flight or failed kick', () => {
    expect(kickStatusLine({ phase: 'kicking' })).toBeNull()
    expect(kickStatusLine({ phase: 'failed', via: 'terminal', error: 'nope' })).toBeNull()
    expect(kickStatusLine(undefined)).toBeNull()
  })
})

/*
 * A kick that ENDED the session is a different act from one that was handed
 * over (#217), and the copy has to keep them apart the way ✓ and ✓✓ already
 * keep handed-over apart from reacted. Nothing is watched for afterwards:
 * there is no session left to react, so a marker that said "watching for it to
 * react" would be waiting for something that cannot happen — and one that
 * promoted itself to ✓✓ would claim a reaction from a process that is gone.
 */
describe('a kick that ended the session', () => {
  it('says the session was ended, never that a turn was interrupted', () => {
    const line = kickStatusLine({ phase: 'delivered', via: 'launched-process' })
    expect(line).toContain('Ended the session')
    expect(line).not.toContain('watching')
    expect(line).not.toContain('handed over')
  })

  it('marks it without ever claiming a reaction', () => {
    const marker = kickMarker({ phase: 'delivered', via: 'launched-process' })
    expect(marker?.glyph).toBe('✓')
    expect(marker?.cls).toBe('is-delivered')
    expect(marker?.title).toContain('ended')
    expect(marker?.title).not.toContain('react')
  })

  it('leaves every other channel saying exactly what it said before', () => {
    expect(kickStatusLine({ phase: 'delivered', via: 'terminal', awaitingReaction: true })).toBe(
      'Kick handed over via terminal — watching for the session to react.'
    )
  })

  it('knows which channels end a session and which only ask', () => {
    expect(kickEndedTheSession('launched-process')).toBe(true)
    expect(kickEndedTheSession('held-session')).toBe(false)
    expect(kickEndedTheSession(undefined)).toBe(false)
  })
})
