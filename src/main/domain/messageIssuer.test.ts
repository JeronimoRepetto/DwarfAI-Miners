import { describe, expect, it } from 'vitest'
import type { Dwarf, FeedMessage } from './types'
import { attributeIssuedMessages, launchingAgentOf } from './messageIssuer'

function dwarf(overrides: Partial<Dwarf> & Pick<Dwarf, 'id' | 'role'>): Dwarf {
  return {
    provider: 'claude',
    name: 'Dwarf',
    status: 'working',
    sessionId: 'session-1',
    ...overrides
  }
}

const FOREMAN = dwarf({ id: 'claude:session-1', role: 'foreman', name: 'coordinator' })
const WORKER = dwarf({ id: 'claude:session-1:agent-77', role: 'worker', name: 'survey the seam' })

describe('launchingAgentOf', () => {
  it('names the foreman that spawned a worker, rank and all', () => {
    expect(launchingAgentOf(WORKER, [FOREMAN, WORKER])).toEqual({
      role: 'foreman',
      name: 'coordinator'
    })
  })

  it('names nobody for a session root, whoever started it', () => {
    // The human's own launch, and the case the panel already had right: a root
    // has no launching AGENT, so its prompt keeps the user's face.
    expect(launchingAgentOf(FOREMAN, [FOREMAN, WORKER])).toBeUndefined()
    // A held root digs as a worker until it coordinates (#157), and its id is
    // still its session's own — there is no dwarf above it to find.
    const solo = dwarf({ id: 'claude:session-9', role: 'worker' })
    expect(launchingAgentOf(solo, [solo])).toBeUndefined()
  })

  it('names nobody when the dwarf it hangs off is not on the board', () => {
    expect(launchingAgentOf(WORKER, [WORKER])).toBeUndefined()
  })

  it('names nobody when the dwarf it hangs off is not a session root', () => {
    // The rank is the proof, and without it this would be a guess: a worker is
    // a DEPTH-1 spawn, so the only thing that can have launched it is the root.
    const notARoot = dwarf({ id: 'claude:session-1', role: 'worker', name: 'someone else' })
    expect(launchingAgentOf(WORKER, [notARoot, WORKER])).toBeUndefined()
  })

  it('names nobody for a worker2, because its launcher cannot be proved from the board', () => {
    // A worker2 is depth 2 OR DEEPER (rankForSpawnDepth), so the agent above it
    // is a worker or another worker2 — and its id names the SESSION it belongs
    // to, never the agent that spawned it. Naming the root here would be the
    // panel inventing an author, which is the bug this module exists to stop.
    const deep = dwarf({ id: 'claude:session-1:agent-99', role: 'worker2' })
    expect(launchingAgentOf(deep, [FOREMAN, deep])).toBeUndefined()
  })
})

describe('attributeIssuedMessages', () => {
  const issuer = { role: 'foreman' as const, name: 'coordinator' }
  const messages: FeedMessage[] = [
    { role: 'user', text: 'survey the seam', timestamp: 't0' },
    { role: 'assistant', text: 'On my way.', timestamp: 't1' },
    { role: 'user', text: 'stop at the fault', timestamp: 't2' }
  ]

  it("stamps the issuer on every user turn, because a subagent's has no other author", () => {
    // Not only the first: the feed is a bounded TAIL, so the oldest line it
    // carries is whatever survived truncation. Nothing outside this subagent's
    // parent session can address it at all, so every user turn in its own
    // transcript came from the agent above it.
    expect(attributeIssuedMessages(messages, issuer).map((message) => message.issuer)).toEqual([
      issuer,
      undefined,
      issuer
    ])
  })

  it("leaves the agent's own replies alone", () => {
    const [, reply] = attributeIssuedMessages(messages, issuer)
    expect(reply).toEqual({ role: 'assistant', text: 'On my way.', timestamp: 't1' })
  })

  it('changes nothing at all when there is no issuer to name', () => {
    expect(attributeIssuedMessages(messages, undefined)).toEqual(messages)
  })
})
