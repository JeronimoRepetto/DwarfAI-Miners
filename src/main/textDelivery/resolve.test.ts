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

  it("carries a terminal endpoint's relay fallback address through unchanged", () => {
    // The runtime reads sessionName off the resolved endpoint when the console
    // attempt fails (issue #24); dropping it here would silently disable the
    // fallback for every send.
    const resolved = resolveTextDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } })
    )
    expect(resolved).toEqual({
      channel: 'terminal',
      endpoint: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' },
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

  it('always reports adjustEffort as null: no provider exposes a channel for it yet', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' } })
    )
    expect(stamped?.dwarfs[0]?.capabilities?.adjustEffort).toBeNull()
  })
})
