import { describe, expect, it, vi } from 'vitest'
import { MAX_CODEX_QUEUE_TEXT_CHARS, MAX_DWARF_TEXT_CHARS } from '../domain/types'
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
   * AMENDED for #319 (was, under #308: "sends a named console session over the
   * relay, keeping its console as the fallback", which asserted
   * `channel: 'claude-relay'`, `endpoint: { kind: 'claude-relay', sessionName }`
   * and `consoleFallbackPid: 42` — the relay primary, the console its fallback).
   *
   * #319 reverses #308 back: a message to a named observed session goes to its
   * CONSOLE (primary again) and falls back to the relay. So the endpoint is the
   * terminal, the pid is the address it uses, and the session name is only what
   * a console write that delivered nothing falls back to — the mirror of what
   * #308 held. See sendRouteOf in resolve.ts. The mechanism at that console
   * changed again in #371 (a write by pid, no window); the routing did not, and
   * this file is about the routing.
   */
  it('writes to a named console session, keeping the relay as the fallback', () => {
    const resolved = resolveTextDelivery(
      'claude:s1',
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } })
    )
    expect(resolved).toEqual({
      channel: 'terminal',
      endpoint: { kind: 'terminal', pid: 42 },
      relayFallbackSessionName: 'sample-project-70',
      prefix: ''
    })
  })

  /*
   * AMENDED for #319 (was, under #308: "keeps a worker's prefix while its named
   * foreman's message crosses to the relay", which asserted
   * `endpoint: { kind: 'claude-relay', sessionName }` and `consoleFallbackPid: 7`).
   *
   * The flip is at the endpoint, so the hop that produced the prefix must still
   * survive it: the session at the top is asked to pass the text to the agent
   * the person pointed at (#157). Only the tier under it reversed — the
   * foreman's console takes the message, the foreman's relay is the fallback.
   */
  it("keeps a worker's prefix while its named foreman's message goes to the console", () => {
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
      endpoint: { kind: 'terminal', pid: 7 },
      relayFallbackSessionName: 'sample-project-70',
      prefix: '[for agent Explorer] '
    })
  })

  it('leaves a console session with no name on its console, having nothing else to offer', () => {
    // A pid but no registry name, so no relay address exists at all: the console
    // is the only channel, with no fallback behind it.
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
      adjustEffort: null,
      attach: 'terminal',
      // AMENDED for #431: the matrix gained a per-route ceiling.
      maxTextChars: MAX_DWARF_TEXT_CHARS
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
      adjustEffort: null,
      attach: null,
      // AMENDED for #431: the matrix gained a per-route ceiling.
      // AMENDED again for #437 (was MAX_DWARF_TEXT_CHARS): the queue is the one
      // route whose message is still an argv element, so it keeps the
      // command-line bound the whole app used to share.
      maxTextChars: MAX_CODEX_QUEUE_TEXT_CHARS
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
      adjustEffort: null,
      attach: null,
      // AMENDED for #431: the matrix gained a per-route ceiling.
      maxTextChars: MAX_DWARF_TEXT_CHARS
    })
  })

  /*
   * AMENDED for #319 (was, under #308: "stamps the relay for sending and the
   * console for cancelling on a named session", which asserted
   * `textDelivery: 'claude-relay'` and `sendText: 'claude-relay'` while cancel
   * stayed 'terminal' — the one dwarf whose two halves disagreed).
   *
   * #319 sends the message to the console again, so both halves are 'terminal'
   * once more: the asymmetry #308 introduced here is gone. `textDelivery`
   * follows sendText, and the composer's hint is the console tier's — which is
   * exactly what main is now going to do.
   */
  it('stamps the console for both sending and cancelling on a named session', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } })
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBe('terminal')
    expect(stamped?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'terminal',
      cancel: 'terminal',
      adjustEffort: null,
      attach: 'terminal',
      // AMENDED for #431: the matrix gained a per-route ceiling.
      maxTextChars: MAX_DWARF_TEXT_CHARS
    })
  })

  it('always reports adjustEffort as null: no provider exposes a channel for it yet', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'sample-project-70' } })
    )
    expect(stamped?.dwarfs[0]?.capabilities?.adjustEffort).toBeNull()
  })

  /*
   * The third member of the matrix (#408). It is narrower than sendText rather
   * than a mirror of it, which is the whole reason it exists: every channel
   * takes a string, and only two were measured to carry a file.
   */
  it.each([
    ['terminal', { kind: 'terminal', pid: 42 } as const, 'terminal'],
    [
      'held-session',
      { kind: 'held-session', sessionId: 's1', interruptible: true } as const,
      'held-session'
    ]
  ])(
    'stamps %s as the attach channel, because a file was measured to reach it',
    (_name, target, expected) => {
      const [stamped] = stampTextDelivery([mine([dwarf()])], targetsFrom({ 'claude:s1': target }))
      expect(stamped?.dwarfs[0]?.capabilities?.attach).toBe(expected)
    }
  )

  it.each([
    ['a relay', { kind: 'claude-relay', sessionName: 'sample-project-70' } as const],
    ['a Codex queue', { kind: 'codex-queue', threadId: 't1' } as const],
    ['a hosted stdin', { kind: 'hosted-stdin', hostedId: 'claude:s1' } as const]
  ])('stamps no attach channel for %s, beside a sendText that still works', (_name, target) => {
    const [stamped] = stampTextDelivery([mine([dwarf()])], targetsFrom({ 'claude:s1': target }))
    expect(stamped?.dwarfs[0]?.capabilities?.sendText).not.toBeNull()
    expect(stamped?.dwarfs[0]?.capabilities?.attach).toBeNull()
  })

  /*
   * The machine, not the session (#366/#408). With no console to write into,
   * `terminal` degrades to the relay for a message — and the file cannot follow
   * it, because a relay carries one sentence to another session. macOS and
   * Linux therefore offer no attach control at all, and the panel reads that
   * here rather than inferring it from the platform.
   */
  it('drops the attach channel with the console tier when the host cannot be typed into', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } }),
      false
    )
    expect(stamped?.dwarfs[0]?.capabilities?.sendText).toBe('claude-relay')
    expect(stamped?.dwarfs[0]?.capabilities?.attach).toBeNull()
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
      adjustEffort: null,
      // AMENDED for #431: the matrix gained a per-route ceiling.
      maxTextChars: MAX_DWARF_TEXT_CHARS,
      // Null for the PROVIDER's sake rather than the channel's (#408): this
      // session is held over Antigravity's NDJSON, which has no measured image
      // block. A held Claude session on the same channel answers 'held-session'.
      attach: null
    })
  })

  it('stamps no attach channel for a held Antigravity session, whose protocol has none', () => {
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
          id: 'mine:c:\\work',
          path: 'C:\\work',
          name: 'work',
          tier: 'bronze',
          dwarfs: [held],
          tokensObserved: 0,
          updatedAt: 1
        }
      ],
      targetsFrom({ 'antigravity:agy-1': HELD })
    )
    expect(mine?.dwarfs[0]?.capabilities?.sendText).toBe('held-session')
    expect(mine?.dwarfs[0]?.capabilities?.attach).toBeNull()
  })
})

/**
 * A machine that cannot type into a console — macOS and Linux (#366).
 *
 * The capability reaches the SEND route only, and that split is the whole issue:
 * before it, a console this machine could not type into was removed from the
 * target itself, so the kick lost the console too and Kick meant "ask the agent
 * to stop by relay" on two platforms and "end the session" on the third.
 */
describe('a console this machine cannot type into (#366)', () => {
  const NAMED = {
    kind: 'terminal' as const,
    pid: 42,
    sessionName: 'sample-project-70'
  }
  const NAMELESS = { kind: 'terminal' as const, pid: 42 }

  it('sends a named console session over its relay instead', () => {
    expect(resolveTextDelivery('claude:s1', targetsFrom({ 'claude:s1': NAMED }), false)).toEqual({
      channel: 'claude-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      prefix: ''
    })
  })

  it('offers no send at all where the console has no relay address', () => {
    expect(
      resolveTextDelivery('claude:s1', targetsFrom({ 'claude:s1': NAMELESS }), false)
    ).toBeNull()
  })

  /*
   * A worker's chain keeps naming the HOP rather than the tier under it, before
   * and after the degrade: what the panel describes there is the foreman it
   * travels through.
   */
  it("keeps a worker's chain on 'foreman-relay' through the degrade", () => {
    const resolved = resolveTextDelivery(
      'claude:s1:w1',
      targetsFrom({
        'claude:s1:w1': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': NAMED
      }),
      false
    )
    expect(resolved).toMatchObject({
      channel: 'foreman-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'sample-project-70' },
      prefix: '[for agent Explorer] '
    })
  })

  /*
   * The kick keeps the console on the same target, and needs no capability
   * passed to say so: ending a session is a signal to a pid.
   */
  it('still routes a kick to that console, named or not', () => {
    for (const target of [NAMED, NAMELESS]) {
      expect(resolveKickDelivery('claude:s1', targetsFrom({ 'claude:s1': target }))).toEqual({
        channel: 'terminal',
        endpoint: target,
        prefix: ''
      })
    }
  })

  /*
   * And the stamped matrix says both, on one dwarf: the composer offers the
   * relay it will really use, and Kick says it ends the session, which it will.
   * The panel and the runtime read the same two functions, so they cannot
   * disagree about this dwarf.
   */
  it('stamps the relay for sending and the console for cancelling on one dwarf', () => {
    const [stamped] = stampTextDelivery(
      [
        {
          id: 'mine:c:\work',
          path: 'C:\work',
          name: 'work',
          tier: 'bronze',
          dwarfs: [
            {
              id: 'claude:s1',
              provider: 'claude',
              role: 'foreman',
              name: 'boss',
              status: 'working',
              sessionId: 's1'
            }
          ],
          tokensObserved: 0,
          updatedAt: 1
        }
      ],
      targetsFrom({ 'claude:s1': NAMED }),
      false
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBe('claude-relay')
    expect(stamped?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'claude-relay',
      cancel: 'terminal',
      adjustEffort: null,
      attach: null,
      // AMENDED for #431: the matrix gained a per-route ceiling.
      maxTextChars: MAX_DWARF_TEXT_CHARS
    })
  })
})

/* --- Message length (#431) — one block, appended ---------------------------- */

/*
 * Issue #431. The matrix gained a NUMBER: how much of a message this dwarf's
 * send route can carry. It is stamped here rather than derived in the panel
 * because only this file holds the endpoint, and the endpoint is what decides
 * — a worker's chain reports 'foreman-relay' while writing into its foreman's
 * own console, which is the tighter ceiling of the two.
 */
describe('stampTextDelivery: the per-route message ceiling (#431)', () => {
  // Local copies of the two builders the block above keeps to itself, rather
  // than widening their scope: this block is appended and changes nothing that
  // was already here.
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

  function stampedCapabilities(target: TextDeliveryTarget, consoleInput = true) {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': target }),
      consoleInput
    )
    return stamped?.dwarfs[0]?.capabilities
  }

  // AMENDED for #433 (was: 'gives a console endpoint the console ceiling',
  // asserting MAX_CONSOLE_TEXT_CHARS). The console write's script rides stdin
  // now, so the ceiling it used to carry is gone with the constant.
  it('gives a console endpoint the wire ceiling, like every other endpoint', () => {
    expect(stampedCapabilities({ kind: 'terminal', pid: 42 })?.maxTextChars).toBe(
      MAX_DWARF_TEXT_CHARS
    )
  })

  it('gives a named session with no console the wire ceiling', () => {
    expect(
      stampedCapabilities({ kind: 'claude-relay', sessionName: 'sample-project-70' })?.maxTextChars
    ).toBe(MAX_DWARF_TEXT_CHARS)
  })

  it('still reads a worker whose foreman is written to at its console off the endpoint', () => {
    // AMENDED for #433 (was: 'keeps the console ceiling for a worker whose
    // foreman is written to at its console'). The two answers agree now, so
    // what is left to pin is that the ENDPOINT is what is asked: the channel
    // says 'foreman-relay' while the send lands in a console, and only the
    // endpoint can tell those apart if a channel ever differs again.
    const [stamped] = stampTextDelivery(
      [mine([dwarf({ id: 'claude:s1:agent' }), dwarf()])],
      targetsFrom({
        'claude:s1:agent': {
          kind: 'foreman-relay',
          foremanDwarfId: 'claude:s1',
          workerName: 'Explorer'
        },
        'claude:s1': { kind: 'terminal', pid: 42 }
      })
    )
    const worker = stamped?.dwarfs.find((item) => item.id === 'claude:s1:agent')
    expect(worker?.capabilities?.sendText).toBe('foreman-relay')
    expect(worker?.capabilities?.maxTextChars).toBe(MAX_DWARF_TEXT_CHARS)
  })

  it('gives a console this machine cannot type into the relay ceiling it degrades to', () => {
    // #366's degrade moves the endpoint off the console, so the ceiling moves
    // with it rather than staying behind on a tier this send will not take.
    expect(
      stampedCapabilities({ kind: 'terminal', pid: 42, sessionName: 'sample-project-70' }, false)
        ?.maxTextChars
    ).toBe(MAX_DWARF_TEXT_CHARS)
  })

  it('reports the wire ceiling for a dwarf with no send channel at all', () => {
    // A launched process takes no messages; the number reaches a composer that
    // is already disabled, so it must not claim a limit this dwarf never had.
    expect(stampedCapabilities({ kind: 'launched-process', launchId: 'L1' })?.maxTextChars).toBe(
      MAX_DWARF_TEXT_CHARS
    )
  })

  /* --- The relay's prompt on stdin (#437) — appended ----------------------- */

  it("stamps the Codex queue its own command-line bound, which is nobody else's", () => {
    // #437 left exactly one endpoint with an argv-derived ceiling: `codex queue
    // --message <TEXT>` names no stdin form. The stamp is what the composer
    // reads, so a Codex dwarf's box has to refuse at the queue's number while
    // its neighbours refuse at the wire's.
    expect(stampedCapabilities({ kind: 'codex-queue', threadId: 't1' })?.maxTextChars).toBe(
      MAX_CODEX_QUEUE_TEXT_CHARS
    )
    expect(MAX_CODEX_QUEUE_TEXT_CHARS).toBeLessThan(MAX_DWARF_TEXT_CHARS)
  })
  /* --- end of the #437 block ----------------------------------------------- */

  /* --- The Codex resume channel (#450) — appended -------------------------- */

  /**
   * The third asymmetric channel, and the queue's mirror read the other way
   * (#450). A `codex exec` thread has no process left to interrupt, so there is
   * no cancel — but `codex exec resume <id> -` starts its next turn, so there
   * IS a send. The matrix therefore carries a sendText without a cancel, which
   * is the queue's shape arrived at from the opposite direction.
   */
  it('stamps the resume for sending and nothing for cancelling on an exec thread', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf({ id: 'codex:t1', provider: 'codex' })])],
      targetsFrom({
        'codex:t1': { kind: 'codex-exec-resume', threadId: 't1', cwd: 'C:\\work\\sample' }
      })
    )
    expect(stamped?.dwarfs[0]?.textDelivery).toBe('codex-exec-resume')
    expect(stamped?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'codex-exec-resume',
      cancel: null,
      adjustEffort: null,
      // The message is stdin and nothing else; no file was measured onto it.
      attach: null,
      // #437's split, taken the other way: this route's prompt is on stdin, so
      // no command line bounds it and the queue's tighter number would refuse
      // a message it can carry.
      maxTextChars: MAX_DWARF_TEXT_CHARS
    })
  })
  /* --- end of the #450 block ----------------------------------------------- */
})
/* --- end of the #431 block -------------------------------------------------- */

/* --- The Codex resume channel (#450) — appended ------------------------------ */

describe('resolving a resumed Codex thread (#450)', () => {
  const TARGET: TextDeliveryTarget = {
    kind: 'codex-exec-resume',
    threadId: 't1',
    cwd: 'C:\\work\\sample'
  }

  /**
   * The folder travels WITH the endpoint rather than being looked up later:
   * Codex declines to run outside a Git repository, and the working directory
   * of a packaged app is nothing anybody chose.
   */
  it('resolves an exec thread to its resume endpoint, folder and all', () => {
    expect(resolveTextDelivery('codex:t1', targetsFrom({ 'codex:t1': TARGET }))).toEqual({
      channel: 'codex-exec-resume',
      endpoint: TARGET,
      prefix: ''
    })
  })

  /**
   * The send/kick split again, and for a reason of its own: the turn a resume
   * starts runs in a process nothing on this board holds a handle to. The
   * launch this panel DID hold was the opening turn's, and it has exited — so a
   * kick routed here would have to invent a pid. The panel dismisses instead.
   */
  it('refuses to route a kick over it, because nothing here holds that process', () => {
    expect(resolveKickDelivery('codex:t1', targetsFrom({ 'codex:t1': TARGET }))).toBeNull()
  })
})
/* --- end of the #450 block --------------------------------------------------- */
