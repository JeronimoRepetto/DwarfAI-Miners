// OS lane (17 §1.8) for the S-021-2 analyzer, which runs on the maintainer's machines over a recorded OpenCode event
// stream. Synthetic events only, in the shapes the analyzer reads; no provider CLI runs here (17 §5.5).
import { describe, expect, it } from 'vitest'
import { openCodeTurnEvents } from './openCodeTurnEvents.mjs'

const status = (type) => ({
  type: 'session.status',
  properties: { sessionID: 's', status: { type } }
})
const message = (id, role, completed) => ({
  type: 'message.updated',
  properties: {
    info: { id, role, time: completed ? { created: 1, completed: 2 } : { created: 1 } }
  }
})
const part = { type: 'message.part.updated', properties: { part: { type: 'text' } } }
const idle = { type: 'session.idle', properties: { sessionID: 's' } }

describe('S-021-2 analyzer (OS lane, synthetic input)', () => {
  it('[S-021-2, ADR-021] the event analyzer names the OpenCode event kinds that occur exactly once per turn', () => {
    // Turn 1: one assistant message, its completed update sent twice. Turn 2: a tool step, so two assistant
    // messages complete in one turn.
    const events = [
      status('busy'),
      message('u1', 'user', false),
      message('a1', 'assistant', false),
      part,
      message('a1', 'assistant', true),
      message('a1', 'assistant', true),
      status('idle'),
      idle,
      status('busy'),
      message('u2', 'user', false),
      message('a2', 'assistant', true),
      part,
      part,
      message('a3', 'assistant', true),
      status('idle'),
      idle
    ]
    const result = openCodeTurnEvents(events, 2)
    expect(result.counts).toEqual({
      'session.status:busy': 2,
      'session.status:idle': 2,
      'session.idle': 2,
      'message.updated': 3,
      'message.completed:assistant': 3,
      'message.part.updated': 3
    })
    expect(result.oncePerTurn).toEqual([
      'session.idle',
      'session.status:busy',
      'session.status:idle'
    ])
  })
})
