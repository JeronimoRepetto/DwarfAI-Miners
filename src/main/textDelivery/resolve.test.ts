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
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'ai-tools-70' } })
    )
    expect(resolved).toEqual({
      channel: 'claude-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'ai-tools-70' },
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
        'claude:s1': { kind: 'claude-relay', sessionName: 'ai-tools-70' }
      })
    )
    expect(resolved).toEqual({
      channel: 'foreman-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'ai-tools-70' },
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
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'ai-tools-70' } })
    )
    expect(resolved).toEqual({
      channel: 'claude-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'ai-tools-70' },
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
        'claude:s1': { kind: 'claude-relay', sessionName: 'ai-tools-70' }
      })
    )
    expect(resolved).toEqual({
      channel: 'foreman-relay',
      endpoint: { kind: 'claude-relay', sessionName: 'ai-tools-70' },
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

  it('always reports adjustEffort as null: no provider exposes a channel for it yet', () => {
    const [stamped] = stampTextDelivery(
      [mine([dwarf()])],
      targetsFrom({ 'claude:s1': { kind: 'claude-relay', sessionName: 'ai-tools-70' } })
    )
    expect(stamped?.dwarfs[0]?.capabilities?.adjustEffort).toBeNull()
  })
})
