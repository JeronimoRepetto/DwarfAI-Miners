import { describe, expect, it, vi } from 'vitest'
import type { Dwarf, Mine } from '../domain/types'
import type { TextDeliveryTarget } from './port'
import { resolveKickDelivery, resolveTextDelivery, stampTextDelivery } from './resolve'

function targetsFrom(entries: Record<string, TextDeliveryTarget>) {
  return (id: string): TextDeliveryTarget | null => entries[id] ?? null
}

describe('resolveTextDelivery', () => {
  it('returns null for a dwarf no provider claims', () => {
    expect(resolveTextDelivery('claude:ghost', targetsFrom({}))).toBeNull()
  })

  it('resolves a terminal target to its own console endpoint with no prefix', () => {
    const resolved = resolveTextDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(resolved).toEqual({
      channel: 'terminal',
      endpoint: { kind: 'terminal', pid: 42 },
      prefix: ''
    })
  })

  it('resolves a headless session to its relay endpoint with no prefix', () => {
    const resolved = resolveTextDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' } })
    )
    expect(resolved).toEqual({
      channel: 'claude-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      prefix: ''
    })
  })

  /*
   * AMENDED for #308 (was: "carries a terminal endpoint's relay fallback
   * address through unchanged", which asserted `channel: 'terminal'` with
   * `endpoint: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' }`
   * — #24's order, the console first and the name only read off the endpoint
   * after a focus had failed).
   *
   * A MESSAGE goes the other way round now. The name is the address it uses
   * and the pid is only what a relay that never started falls back to; see
   * sendRouteOf in resolve.ts for why the reversal is a hazard fix rather than
   * a preference.
   */
  it('sends a named console session over the relay, keeping its console as the fallback', () => {
    const resolved = resolveTextDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } })
    )
    expect(resolved).toEqual({
      channel: 'claude-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      consoleFallbackPid: 42,
      prefix: ''
    })
  })

  it("keeps a worker's prefix while its named foreman's message crosses to the relay", () => {
    // The flip happens at the endpoint, so the hop that produced the prefix
    // must survive it: the session at the top is still being asked to pass
    // the text on to the agent the person pointed at (#308, #157).
    const resolved = resolveTextDelivery(
      'claude:s1:agent-9',
      targetsFrom({
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'terminal', pid: 7, sessionName: 'sample-project-70' }
      })
    )
    expect(resolved).toEqual({
      channel: 'foreman-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      consoleFallbackPid: 7,
      prefix: '[for agent Explorer] '
    })
  })

  it('leaves a console session with no name on its console, having nothing else to offer', () => {
    // The one case the console tier is still the primary for (#308): no
    // registry name, so no relay address exists at all.
    const resolved = resolveTextDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(resolved).toEqual({
      channel: 'terminal',
      endpoint: { kind: 'terminal', pid: 42 },
      prefix: ''
    })
  })

  it('routes a worker to its foreman endpoint and prefixes the worker name', () => {
    const resolved = resolveTextDelivery(
      'claude:s1:agent-9',
      targetsFrom({
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' }
      })
    )
    expect(resolved).toEqual({
      channel: 'foreman-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      prefix: '[for agent Explorer] '
    })
  })

  it('routes a worker whose foreman is terminal-hosted to that console', () => {
    const resolved = resolveTextDelivery(
      'claude:s1:agent-9',
      targetsFrom({
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'terminal', pid: 7 }
      })
    )
    expect(resolved).toMatchObject({
      channel: 'foreman-relay',
      endpoint: { kind: 'terminal', pid: 7 },
      prefix: '[for agent Explorer] '
    })
  })

  /*
   * #157's addressing rule, and the first thing in this repository to actually
   * use the second hop MAX_FOREMAN_HOPS was built for.
   *
   * A worker2 is a subagent OF a subagent, so its relay names the worker that
   * launched it and that worker relays on to the session. Both routes end in
   * the same queue — the intermediate worker has no queue of its own — so the
   * only thing the choice changes is what the session is TOLD, and a session
   * that never launched the worker2 has no idea who "Scout" is. The whole path
   * is the only phrasing it can act on.
   */
  it('routes a worker2 up through the worker that launched it, naming both', () => {
    const resolved = resolveTextDelivery(
      'claude:s1:agent-deep',
      targetsFrom({
        'claude:s1:agent-deep': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1:agent-9',
          workerName: 'Scout'
        },
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' }
      })
    )
    expect(resolved).toEqual({
      channel: 'foreman-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      // Outermost first: the session is asked to pass this to Explorer, who is
      // asked to pass it to Scout.
      prefix: '[for agent Explorer] [for agent Scout] '
    })
  })

  it('returns null when the foreman itself has no channel', () => {
    const resolved = resolveTextDelivery(
      'claude:s1:agent-9',
      targetsFrom({
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        }
      })
    )
    expect(resolved).toBeNull()
  })

  it('gives up instead of looping when foreman links form a cycle', () => {
    const resolved = resolveTextDelivery(
      'a',
      targetsFrom({
        a: { kind: 'foreman-relay', foremanDwarfId: 'b', workerName: 'A' },
        b: { kind: 'foreman-relay', foremanDwarfId: 'a', workerName: 'B' }
      })
    )
    expect(resolved).toBeNull()
  })

  it('resolves a Codex thread to its own queue endpoint with no prefix', () => {
    const resolved = resolveTextDelivery(
      'codex:t1',
      targetsFrom({ 'codex:t1': { kind: 'codex-queue', threadId: 't1' } })
    )
    expect(resolved).toEqual({
      channel: 'codex-queue',
      endpoint: { kind: 'codex-queue', threadId: 't1' },
      prefix: ''
    })
  })
})

describe('resolveKickDelivery', () => {
  it('returns null for a dwarf no provider claims', () => {
    expect(resolveKickDelivery('claude:ghost', targetsFrom({}))).toBeNull()
  })

  it('resolves a terminal target to its own console endpoint with no prefix', () => {
    const resolved = resolveKickDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(resolved).toEqual({
      channel: 'terminal',
      endpoint: { kind: 'terminal', pid: 42 },
      prefix: ''
    })
  })

  it('resolves a headless session to its relay endpoint with no prefix', () => {
    const resolved = resolveKickDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' } })
    )
    expect(resolved).toEqual({
      channel: 'claude-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      prefix: ''
    })
  })

  it("routes a worker to its foreman endpoint under a '[cancel agent X]' tag, not the send prefix", () => {
    const resolved = resolveKickDelivery(
      'claude:s1:agent-9',
      targetsFrom({
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' }
      })
    )
    expect(resolved).toEqual({
      channel: 'foreman-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      prefix: '[cancel agent Explorer] '
    })
  })

  it('keeps a named console session on its console, where the message now leaves it (#308)', () => {
    // The one asymmetry #308 introduces, and the whole reason send and kick
    // resolve separately: an interrupt IS a keystroke and carries no user
    // text, so Esc into the wrong window costs a cancelled turn rather than a
    // leaked sentence. The relay stays this tier's fallback (#24).
    const resolved = resolveKickDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } })
    )
    expect(resolved).toEqual({
      channel: 'terminal',
      endpoint: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' },
      prefix: ''
    })
  })

  it("carries a terminal-hosted foreman's relay fallback address across the hop", () => {
    // A worker kick lands on the foreman's console; when that console cannot
    // be reached, the runtime falls back to the foreman's relay address, so
    // the hop must not strip it (issue #24).
    const resolved = resolveKickDelivery(
      'claude:s1:agent-9',
      targetsFrom({
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'terminal', pid: 7, sessionName: 'sample-project-70' }
      })
    )
    expect(resolved).toEqual({
      channel: 'foreman-relay',
      endpoint: { kind: 'terminal', pid: 7, sessionName: 'sample-project-70' },
      prefix: '[cancel agent Explorer] '
    })
  })

  it('returns null when the foreman itself has no channel', () => {
    const resolved = resolveKickDelivery(
      'claude:s1:agent-9',
      targetsFrom({
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        }
      })
    )
    expect(resolved).toBeNull()
  })

  it('gives up instead of looping when foreman links form a cycle', () => {
    const resolved = resolveKickDelivery(
      'a',
      targetsFrom({
        a: { kind: 'foreman-relay', foremanDwarfId: 'b', workerName: 'A' },
        b: { kind: 'foreman-relay', foremanDwarfId: 'a', workerName: 'B' }
      })
    )
    expect(resolved).toBeNull()
  })

  it('cancels a worker2 by naming the same path back up the tree (#157)', () => {
    const resolved = resolveKickDelivery(
      'claude:s1:agent-deep',
      targetsFrom({
        'claude:s1:agent-deep': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1:agent-9',
          workerName: 'Scout'
        },
        'claude:s1:agent-9': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'terminal', pid: 7 }
      })
    )
    expect(resolved?.prefix).toBe('[cancel agent Explorer] [cancel agent Scout] ')
  })

  /**
   * The one place send and kick routing part company (#97). A Codex queue item
   * is drained at the thread's next idle boundary, so an interrupt sent that
   * way arrives exactly when the turn it meant to cut short has already ended:
   * exit 0, a ✓, and nothing cancelled. Mid-turn drain is precisely the half
   * the live experiment did not test, and a channel that reports a cancel it
   * never performed is worse than a disabled button with a reason.
   */
  it('refuses to route a kick over the Codex queue, which cannot interrupt a turn', () => {
    expect(
      resolveKickDelivery(
        'codex:t1',
        targetsFrom({ 'codex:t1': { kind: 'codex-queue', threadId: 't1' } })
      )
    ).toBeNull()
  })

  /**
   * A process this panel LAUNCHED is the mirror image of the queue (#217): it
   * can be ended and it can never be written to, because `codex exec` reads
   * one prompt and exits. So the kick routes and the message does not — the
   * opposite asymmetry to the queue's, through the same one rule each.
   */
  it('routes a kick to a process this panel launched', () => {
    expect(
      resolveKickDelivery(
        'codex:t1',
        targetsFrom({ 'codex:t1': { kind: 'launched-process', launchId: 'launch:1' } })
      )
    ).toEqual({
      channel: 'launched-process',
      endpoint: { kind: 'launched-process', launchId: 'launch:1' },
      prefix: ''
    })
  })

  it('refuses to route a message to a process this panel launched', () => {
    expect(
      resolveTextDelivery(
        'codex:t1',
        targetsFrom({ 'codex:t1': { kind: 'launched-process', launchId: 'launch:1' } })
      )
    ).toBeNull()
  })

  /**
   * Ending a process is the whole session, so it may only ever answer a kick
   * aimed at that session itself. A worker's cancel that reached here would
   * kill the foreman's process — the user asked to stop one agent, not to end
   * everything running in that folder.
   */
  it("refuses a worker's cancel that would end its foreman's whole process", () => {
    expect(
      resolveKickDelivery(
        'codex:t1:agent-9',
        targetsFrom({
          'codex:t1:agent-9': {
            kind: 'foreman-relay',
            foremanDwarfId: 'codex:t1',
            workerName: 'Explorer'
          },
          'codex:t1': { kind: 'launched-process', launchId: 'launch:1' }
        })
      )
    ).toBeNull()
  })

  it('still routes that same session for a message', () => {
    // The point of the refusal above: it takes away the kick, never the send.
    expect(
      resolveTextDelivery(
        'codex:t1',
        targetsFrom({ 'codex:t1': { kind: 'codex-queue', threadId: 't1' } })
      )
    ).not.toBeNull()
  })
})

describe('stampTextDelivery', () => {
  function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
    return {
      id: 'claude:s1',
      provider: 'claude',
      role: 'foreman',
      name: 'boss',
      status: 'working',
      sessionId: 's1',
      ...overrides
    }
  }

  function mine(dwarfs: Dwarf[]): Mine {
    return {
      id: 'mine:c:\\work',
      path: 'C:\\work',
      name: 'work',
      tier: 'bronze',
      dwarfs,
      tokensObserved: 0,
      updatedAt: 1
    }
  }

  it('stamps the resolved channel onto every reachable dwarf', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBe('terminal')
  })

  it('leaves an unreachable dwarf without a channel', () => {
    const [stamped] = stampTextDelivery([mine([dwarf()])], targetsFrom({}))
    expect(stamped?.dwarfs[0]?.textDelivery).toBeUndefined()
  })

  it('never offers a channel to a leaving dwarf whose session is already gone', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf({ status: 'leaving' })])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBeUndefined()
  })

  it('copies instead of mutating the provider-owned dwarf objects', () => {
    const original = dwarf()
    stampTextDelivery(
      [mine([original])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(original.textDelivery).toBeUndefined()
  })

  it('asks the provider once per dwarf', () => {
    const targetOf = vi.fn().mockReturnValue(null)
    stampTextDelivery([mine([dwarf(), dwarf({ id: 'claude:s2' })])], targetOf)
    expect(targetOf).toHaveBeenCalledTimes(2)
  })

  it('mirrors the resolved channel onto capabilities.sendText and capabilities.cancel', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(stamped?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'terminal',
      cancel: 'terminal',
      adjustEffort: null
    })
  })

  it('leaves capabilities unset for an unreachable dwarf, same as textDelivery', () => {
    const [stamped] = stampTextDelivery([mine([dwarf()])], targetsFrom({}))
    expect(stamped?.dwarfs[0]?.capabilities).toBeUndefined()
  })

  it('never offers capabilities to a leaving dwarf whose session is already gone', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf({ status: 'leaving' })])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42 } })
    )
    expect(stamped?.dwarfs[0]?.capabilities).toBeUndefined()
  })

  /**
   * The queue is the one channel where sendText and cancel disagree, so the
   * stamped matrix has to carry both answers rather than mirroring one (#97).
   * The panel then enables Chat and disables Kick with the queue's own reason.
   */
  it('stamps the queue for sending and null for cancelling on a Codex thread', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf({ id: 'codex:t1', provider: 'codex' })])],
      targetsFrom({ 'codex:t1': { kind: 'codex-queue', threadId: 't1' } })
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBe('codex-queue')
    expect(stamped?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'codex-queue',
      cancel: null,
      adjustEffort: null
    })
  })

  /**
   * The second asymmetric channel, and the opposite one (#217). A session
   * launched with `codex exec` takes no messages — it reads one prompt and
   * exits — but the panel still holds the process it started, so the exit is
   * real. The matrix therefore has to carry a cancel WITHOUT a sendText, which
   * `textDelivery` must stay absent for: it is the field the composer reads.
   */
  it('stamps a cancel and no send channel for a session this panel launched', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf({ id: 'codex:t1', provider: 'codex' })])],
      targetsFrom({ 'codex:t1': { kind: 'launched-process', launchId: 'launch:1' } })
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBeUndefined()
    expect(stamped?.dwarfs[0]?.capabilities).toEqual({
      sendText: null,
      cancel: 'launched-process',
      adjustEffort: null
    })
  })

  /**
   * The third asymmetric channel, and the first where the two halves disagree
   * for one session rather than for one session TYPE (#308). An observed
   * Claude session with a registry name takes messages over the relay and
   * interrupts at its console, so the matrix has to publish two different
   * channels for one dwarf — and `textDelivery` must follow sendText, because
   * it is the field the composer reads: a bar that advertised 'terminal' here
   * would promise a hint main is no longer going to honour.
   */
  it('stamps the relay for sending and the console for cancelling on a named session', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } })
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBe('claude-relay')
    expect(stamped?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'claude-relay',
      cancel: 'terminal',
      adjustEffort: null
    })
  })

  it('always reports adjustEffort as null: no provider exposes a channel for it yet', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' } })
    )
    expect(stamped?.dwarfs[0]?.capabilities?.adjustEffort).toBeNull()
  })
})

/*
 * Issue #237, step 5. Two providers can be held now, and their protocols do
 * not agree about cancellation: the Agent SDK documents an `interrupt` control
 * request, and Antigravity's bidirectional stream documents user text events
 * on its input side and nothing else.
 *
 * So `interruptible` is a fact carried by the endpoint rather than derived
 * from its KIND, and both callers read the one rule — the panel must disable
 * the control main is bound to refuse, which is exactly what these two
 * functions exist to keep in step (#97's own reasoning, second case).
 */
describe('a held session whose protocol has no cancel (#237, step 5)', () => {
  const HELD_NO_CANCEL = {
    kind: 'held-session' as const,
    sessionId: 'agy-1',
    interruptible: false
  }
  const HELD = { kind: 'held-session' as const, sessionId: 'sess-1', interruptible: true }

  it('still routes a MESSAGE, because the stream takes one', () => {
    expect(
      resolveTextDelivery('antigravity:agy-1', targetsFrom({ 'antigravity:agy-1': HELD_NO_CANCEL }))
    ).toEqual({
      channel: 'held-session',
      endpoint: HELD_NO_CANCEL,
      prefix: ''
    })
  })

  it('refuses to route a kick, rather than reporting one it cannot perform', () => {
    expect(
      resolveKickDelivery('antigravity:agy-1', targetsFrom({ 'antigravity:agy-1': HELD_NO_CANCEL }))
    ).toBeNull()
  })

  it('routes a kick for a held session whose protocol does have one', () => {
    expect(resolveKickDelivery('claude:sess-1', targetsFrom({ 'claude:sess-1': HELD }))).toEqual({
      channel: 'held-session',
      endpoint: HELD,
      prefix: ''
    })
  })

  it('stamps send without cancel, so the bar can say which half is missing', () => {
    const held: Dwarf = {
      id: 'antigravity:agy-1',
      provider: 'antigravity',
      role: 'foreman',
      name: 'boss',
      status: 'working',
      sessionId: 'agy-1'
    }
    const [mine] = stampTextDelivery(
      [
        {
          id: 'mine:c:\work',
          path: 'C:\work',
          name: 'work',
          tier: 'bronze',
          dwarfs: [held],
          tokensObserved: 0,
          updatedAt: 1
        }
      ],
      targetsFrom({ 'antigravity:agy-1': HELD_NO_CANCEL })
    )
    expect(mine?.dwarfs[0]?.textDelivery).toBe('held-session')
    expect(mine?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'held-session',
      cancel: null,
      adjustEffort: null
    })
  })
})
