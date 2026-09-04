import { describe, expect, it, vi } from 'vitest'
import type { Dwarf, Mine } from '../domain/types'
import { LaunchedSessionRegistry, type LaunchedProcess } from './launchedSessions'

const MINE_PATH = 'C:\\work\\project'
const OTHER_PATH = 'C:\\work\\other'

function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return {
    id: `codex:${overrides.sessionId ?? 'thread-1'}`,
    provider: 'codex',
    role: 'worker',
    name: 'codex-01a04d79',
    status: 'working',
    sessionId: 'thread-1',
    ...overrides
  }
}

function mine(path: string, dwarfs: Dwarf[]): Mine {
  return {
    id: `mine:${path}`,
    path,
    name: 'project',
    tier: 'bronze',
    dwarfs,
    tokensObserved: 0,
    updatedAt: 1
  }
}

/** A retained handle whose exit can be fired by hand, as the real one is by libuv. */
function handle(pid: number): { process: LaunchedProcess; exit: () => void } {
  const listeners: Array<() => void> = []
  return {
    process: {
      pid,
      onExit(listener) {
        listeners.push(listener)
      }
    },
    exit: () => {
      for (const listener of listeners) listener()
    }
  }
}

function registry(endProcessTree = vi.fn().mockResolvedValue(true)) {
  return { registry: new LaunchedSessionRegistry({ endProcessTree }), endProcessTree }
}

describe('LaunchedSessionRegistry binding', () => {
  it('claims the first session that appears in the mine it launched into', () => {
    const { registry: launched } = registry()
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'thread-new' })])])

    expect(launched.launchIdOf('thread-new')).toBe(launchId)
  })

  /*
   * The one fact that makes the claim honest: a session already on the board
   * when the launch was made is somebody else's, whatever folder it is in.
   */
  it('never claims a session that was already on the board', () => {
    const { registry: launched } = registry()
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: ['thread-old']
    })

    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'thread-old' })])])

    expect(launched.launchIdOf('thread-old')).toBeUndefined()
  })

  it('never claims a session in another mine', () => {
    const { registry: launched } = registry()
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    launched.observe([mine(OTHER_PATH, [dwarf({ sessionId: 'elsewhere' })])])

    expect(launched.launchIdOf('elsewhere')).toBeUndefined()
  })

  it("never claims another provider's session", () => {
    const { registry: launched } = registry()
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    launched.observe([
      mine(MINE_PATH, [
        dwarf({ id: 'claude:s1', provider: 'claude', sessionId: 's1' }),
        dwarf({ sessionId: 'thread-new' })
      ])
    ])

    expect(launched.launchIdOf('s1')).toBeUndefined()
    expect(launched.launchIdOf('thread-new')).toBeTruthy()
  })

  /*
   * A spawned agent is not the session this panel started; #218's territory,
   * and ending its parent's process tree is not what a kick on it asks for.
   * The parent EDGE is the evidence, exactly as it is everywhere else.
   */
  it('never claims a spawned agent, only a session root', () => {
    const { registry: launched } = registry()
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'child', parentId: 'codex:parent' })])])

    expect(launched.launchIdOf('child')).toBeUndefined()
  })

  it('never claims a session whose agent has already finished', () => {
    const { registry: launched } = registry()
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'gone', status: 'leaving' })])])

    expect(launched.launchIdOf('gone')).toBeUndefined()
  })

  it('gives two launches in one mine two different sessions', () => {
    const { registry: launched } = registry()
    const first = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(1).process,
      knownSessionIds: []
    })
    const second = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(2).process,
      knownSessionIds: []
    })

    launched.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'thread-a' }), dwarf({ sessionId: 'thread-b' })])
    ])

    expect(launched.launchIdOf('thread-a')).toBe(first)
    expect(launched.launchIdOf('thread-b')).toBe(second)
  })

  it('keeps the session it claimed when a newer one appears beside it', () => {
    const { registry: launched } = registry()
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'thread-a' })])])
    launched.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'thread-a' }), dwarf({ sessionId: 'thread-b' })])
    ])

    expect(launched.launchIdOf('thread-a')).toBe(launchId)
    expect(launched.launchIdOf('thread-b')).toBeUndefined()
  })

  /*
   * Delivery channels are resolved per DWARF, and the board being stamped is
   * not the board this register was last shown — so the claim is indexed both
   * ways rather than followed through a lookup that would be a poll behind.
   */
  it('answers for the dwarf a channel is resolved for, not only the session', () => {
    const { registry: launched } = registry()
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'thread-new' })])])

    expect(launched.launchIdOfDwarf('codex:thread-new')).toBe(launchId)
    expect(launched.launchIdOfDwarf('codex:someone-else')).toBeUndefined()
  })
})

describe('LaunchedSessionRegistry.end', () => {
  it('ends the tree of the process the panel started, and says it ended', async () => {
    const { registry: launched, endProcessTree } = registry()
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    await expect(launched.end(launchId)).resolves.toBe('ended')
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  /*
   * The pid-reuse guard, and the reason the handle's own exit is subscribed to
   * rather than the pid being probed later: once that process has gone, its
   * number can belong to anything on this machine. Nothing is signalled.
   */
  it('signals nothing once the process has already gone on its own', async () => {
    const { registry: launched, endProcessTree } = registry()
    const retained = handle(4242)
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: retained.process,
      knownSessionIds: []
    })

    retained.exit()

    await expect(launched.end(launchId)).resolves.toBe('already-ended')
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('signals nothing on a second kick, having already ended that tree once', async () => {
    const { registry: launched, endProcessTree } = registry()
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    await launched.end(launchId)
    await expect(launched.end(launchId)).resolves.toBe('already-ended')
    expect(endProcessTree).toHaveBeenCalledTimes(1)
  })

  /*
   * A refused kill must never read as an ended session: the panel says the
   * session could not be ended, and the launch stays retained so a second
   * attempt is still possible.
   */
  it('reports a refusal when the tree could not be ended, and keeps the launch', async () => {
    const { registry: launched, endProcessTree } = registry(vi.fn().mockResolvedValue(false))
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })

    await expect(launched.end(launchId)).resolves.toBe('refused')
    await expect(launched.end(launchId)).resolves.toBe('refused')
    expect(endProcessTree).toHaveBeenCalledTimes(2)
  })

  it('knows nothing about a launch it never retained', async () => {
    const { registry: launched } = registry()
    await expect(launched.end('launch:nope')).resolves.toBe('already-ended')
    expect(launched.launchIdOf('thread-1')).toBeUndefined()
  })
})
