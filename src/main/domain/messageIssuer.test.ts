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

/**
 * A Codex dwarf, whose id is `codex:<threadId>` for a spawned agent exactly as
 * for a root — which is why #218's launcher could never be read out of it.
 */
function codexDwarf(overrides: Partial<Dwarf> & Pick<Dwarf, 'id' | 'role'>): Dwarf {
  return dwarf({
    provider: 'codex',
    sessionId: overrides.id.slice('codex:'.length),
    ...overrides
  })
}

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

  it('names nobody for a worker2 whose parent edge nothing established', () => {
    // A worker2 is depth 2 OR DEEPER (rankForSpawnDepth), so the agent above it
    // is a worker or another worker2 — unknowable from the rank. Naming the
    // root here would be the panel inventing an author, which is the bug this
    // module exists to stop. Amended for #189: the assertion is the one #175
    // wrote and still the rule, but the reason moved — the launcher is now
    // resolved from a declared parent edge, and this dwarf carries none.
    const deep = dwarf({ id: 'claude:session-1:agent-99', role: 'worker2' })
    expect(launchingAgentOf(deep, [FOREMAN, deep])).toBeUndefined()
  })

  it('names the agent that launched a worker2 once the board carries its edge', () => {
    // #189. The rank could never say who spawned a worker2, and the id says
    // which SESSION it belongs to rather than who launched it. The edge says,
    // and the launcher's OWN entry gives the rank — nothing infers one here.
    const parent = dwarf({ id: 'claude:session-1:a1', role: 'worker', name: 'Explorer' })
    const deep = dwarf({
      id: 'claude:session-1:a2',
      role: 'worker2',
      parentId: 'claude:session-1:a1'
    })
    expect(launchingAgentOf(deep, [FOREMAN, parent, deep])).toEqual({
      role: 'worker',
      name: 'Explorer'
    })
  })

  it('names nobody for a worker2 whose named parent is not on the board', () => {
    // #189's refusal, kept: an edge is a claim about a dwarf, and a dwarf that
    // finished first is not there to be named. Unknown stays unattributed.
    const deep = dwarf({
      id: 'claude:session-1:a2',
      role: 'worker2',
      parentId: 'claude:session-1:a1'
    })
    expect(launchingAgentOf(deep, [FOREMAN, deep])).toBeUndefined()
  })

  it("names a Codex agent's parent thread, whatever rank that thread stands at", () => {
    // #218. A Codex sub-agent is a thread of its own, so its dwarf is a
    // session dwarf and its parent is another one — no rank pairing describes
    // that, and none is consulted: the parent's entry is the answer.
    const parent = codexDwarf({ id: 'codex:thread-p', role: 'foreman', name: 'codex-thread-p' })
    const agent = codexDwarf({
      id: 'codex:thread-c',
      role: 'worker',
      name: 'Bernoulli',
      parentId: 'codex:thread-p'
    })
    expect(launchingAgentOf(agent, [parent, agent])).toEqual({
      role: 'foreman',
      name: 'codex-thread-p'
    })
  })

  it('names nobody for a dwarf whose declared edge points back at itself', () => {
    // Nothing on the board can be its own launcher. A provider that wrote the
    // dwarf's own id as its edge has stated no edge, and the refusal has to be
    // explicit: the rank check below it never sees a declared edge, so without
    // this a self-reference would attribute a prompt to the dwarf that read it.
    const agent = codexDwarf({
      id: 'codex:thread-c',
      role: 'worker',
      name: 'Bernoulli',
      parentId: 'codex:thread-c'
    })
    expect(launchingAgentOf(agent, [agent])).toBeUndefined()
  })

  it('never reads a launcher out of a dwarf id, however a provider spells one', () => {
    // #218's exact wrong answer, pinned. A Codex agent's id is `codex:<uuid>`,
    // so slicing it at the last colon named the literal `codex` — a provider,
    // not an agent. Nothing is sliced any more, so a dwarf standing under that
    // name is still nobody's launcher.
    const notAnAgent = codexDwarf({ id: 'codex', role: 'foreman', name: 'the provider itself' })
    const agent = codexDwarf({ id: 'codex:thread-c', role: 'worker', name: 'Bernoulli' })
    expect(launchingAgentOf(agent, [notAnAgent, agent])).toBeUndefined()
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
