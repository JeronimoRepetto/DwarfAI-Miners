import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { createAppDatabase } from '../appDatabase/appDatabase'
import type { Dwarf, Mine } from '../domain/types'
import { createSqliteLaunchedSessionStore, type LaunchedSessionStore } from './launchedSessionStore'
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

/*
 * #231: a session launched before the panel restarted had no exit, because the
 * register above is in memory. What survives a restart is a ROW, and the danger
 * the issue names is exactly why a row is not enough on its own — a pid is
 * recycled, and this app owns a `taskkill /T` that would take an unrelated
 * process's children with it.
 *
 * So the row carries the pid AND that process's creation time, and the machine
 * is asked again before the row is believed. Every test below is about one of
 * the three answers the machine can give: the same process, a different one, or
 * nothing at all.
 */
describe('LaunchedSessionRegistry across a restart (#231)', () => {
  const PROC_START = 1_788_001_972_136

  /** A probe with a canned answer per pid, and a record of what was asked. */
  function probe(answers: Record<number, number | null> = {}) {
    const asked: number[] = []
    return {
      asked,
      answers,
      processStartTimeMs: async (pid: number): Promise<number | null> => {
        asked.push(pid)
        return answers[pid] ?? null
      }
    }
  }

  function store(sqlite = new MemoryWritableSqlite()): {
    store: LaunchedSessionStore
    sqlite: MemoryWritableSqlite
    /** The rows as written, past the store's own defensive read. */
    rows: () => Promise<Record<string, unknown>[]>
  } {
    const database = createAppDatabase({ filePath: 'C:\\userData\\projects-v1.db', sqlite })
    return {
      store: createSqliteLaunchedSessionStore({ database }),
      sqlite,
      rows: async () => (await database.connect()).all('SELECT * FROM launched_sessions')
    }
  }

  /** One run of the app: retain a launch, let the poll claim its session, settle the write. */
  async function runWithLaunch(
    launchStore: LaunchedSessionStore,
    options: { pid?: number; start?: number | null; sessionId?: string } = {}
  ) {
    const pid = options.pid ?? 4242
    const started = options.start === undefined ? PROC_START : options.start
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const launched = new LaunchedSessionRegistry({
      endProcessTree,
      processStartTimeMs: probe({ [pid]: started }).processStartTimeMs,
      store: launchStore
    })
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(pid).process,
      knownSessionIds: []
    })
    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: options.sessionId ?? 'thread-new' })])])
    await launched.settle()
    return { launched, launchId, endProcessTree }
  }

  it('writes down what it launched, once it knows which session that became', async () => {
    const { store: launchStore } = store()
    const { launchId } = await runWithLaunch(launchStore)

    await expect(launchStore.list()).resolves.toEqual([
      {
        launchId,
        provider: 'codex',
        sessionId: 'thread-new',
        minePath: MINE_PATH,
        pid: 4242,
        processStartTimeMs: PROC_START
      }
    ])
  })

  /*
   * A launch that has not been matched to a session yet cannot be re-adopted
   * after a restart under any rule: the claim it is waiting for reads "the
   * first session root that was not on the board a moment ago", and after a
   * restart every session was. So nothing is written until there is a session
   * id to write, and a run that ends before then leaves no row.
   */
  it('writes nothing down for a launch whose session it has not claimed yet', async () => {
    const { store: launchStore } = store()
    const launched = new LaunchedSessionRegistry({
      endProcessTree: vi.fn().mockResolvedValue(true),
      processStartTimeMs: probe({ 4242: PROC_START }).processStartTimeMs,
      store: launchStore
    })
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })
    await launched.settle()

    await expect(launchStore.list()).resolves.toEqual([])
  })

  /*
   * The bare-pid refusal, and the single most load-bearing rule here. A pid on
   * its own identifies nothing tomorrow, so a launch whose creation time the
   * machine would not report is not written down at all — an exit that cannot
   * be offered honestly is better than one aimed at a number.
   */
  it('writes nothing down for a launch whose creation time nothing could report', async () => {
    const { store: launchStore, rows } = store()
    await runWithLaunch(launchStore, { start: null })

    // Asserted on the raw table as well as through the store, so that the rule
    // is pinned where it is MADE. The store's own defensive read would drop
    // such a row on the way back out, and a register that wrote it anyway
    // would be relying on the reader to undo its mistake.
    await expect(rows()).resolves.toEqual([])
    await expect(launchStore.list()).resolves.toEqual([])
  })

  it('forgets a launch whose process exited on its own', async () => {
    const { store: launchStore } = store()
    const gone = handle(4242)
    const launched = new LaunchedSessionRegistry({
      endProcessTree: vi.fn().mockResolvedValue(true),
      processStartTimeMs: probe({ 4242: PROC_START }).processStartTimeMs,
      store: launchStore
    })
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: gone.process,
      knownSessionIds: []
    })
    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'thread-new' })])])
    await launched.settle()
    gone.exit()
    await launched.settle()

    await expect(launchStore.list()).resolves.toEqual([])
  })

  it('forgets a launch it has ended', async () => {
    const { store: launchStore } = store()
    const { launched, launchId } = await runWithLaunch(launchStore)

    await expect(launched.end(launchId)).resolves.toBe('ended')
    await launched.settle()

    await expect(launchStore.list()).resolves.toEqual([])
  })

  /*
   * The fix itself. A NEW register over the SAME database offers the exit the
   * old one had, because the machine still reports that pid's process as the
   * one the row was written about.
   */
  it('offers a previous run’s launch as an exit when the machine still shows that process', async () => {
    const { store: launchStore, sqlite } = store()
    const { launchId } = await runWithLaunch(launchStore)

    const { store: reopened } = store(sqlite)
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const machine = probe({ 4242: PROC_START })
    const nextRun = new LaunchedSessionRegistry({
      endProcessTree,
      processStartTimeMs: machine.processStartTimeMs,
      store: reopened
    })
    await nextRun.restore()

    expect(nextRun.launchIdOf('thread-new')).toBe(launchId)
    nextRun.observe([mine(MINE_PATH, [dwarf({ sessionId: 'thread-new' })])])
    expect(nextRun.launchIdOfDwarf('codex:thread-new')).toBe(launchId)
    await expect(nextRun.end(launchId)).resolves.toBe('ended')
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  /*
   * The mistake this whole design exists to avoid. The pid is live and belongs
   * to something else entirely, so nothing is signalled and the row goes: a
   * dead record kept around is one more chance to kill the wrong tree.
   */
  it('signals nothing and forgets the launch when that pid is now a different process', async () => {
    const { store: launchStore, sqlite } = store()
    await runWithLaunch(launchStore)

    const { store: reopened } = store(sqlite)
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const nextRun = new LaunchedSessionRegistry({
      endProcessTree,
      processStartTimeMs: probe({ 4242: PROC_START + 3_600_000 }).processStartTimeMs,
      store: reopened
    })
    await nextRun.restore()

    expect(nextRun.launchIdOf('thread-new')).toBeUndefined()
    expect(endProcessTree).not.toHaveBeenCalled()
    await expect(reopened.list()).resolves.toEqual([])
  })

  /*
   * "Cannot answer" never becomes "same process", and here that is the opposite
   * reading from the Claude registry's own guard (#45), deliberately. There a
   * null leaves a dwarf on the board — the worst case is a stale dwarf. Here a
   * null would end a process tree, and the worst case is somebody else's.
   *
   * A dead pid is also the ordinary way a probe answers nothing, which is what
   * every launch of a previous run looks like once its session has finished —
   * so this is the common path, not the edge.
   */
  it('signals nothing and forgets the launch when nothing can be asked about that pid', async () => {
    const { store: launchStore, sqlite } = store()
    await runWithLaunch(launchStore)

    const { store: reopened } = store(sqlite)
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const nextRun = new LaunchedSessionRegistry({
      endProcessTree,
      processStartTimeMs: probe().processStartTimeMs,
      store: reopened
    })
    await nextRun.restore()

    expect(nextRun.launchIdOf('thread-new')).toBeUndefined()
    expect(endProcessTree).not.toHaveBeenCalled()
    await expect(reopened.list()).resolves.toEqual([])
  })

  /*
   * A restored launch has no exit handle, so the fact that made an in-run kill
   * safe — libuv telling this process the child is gone — does not exist for
   * it. The number is therefore checked AGAIN at the moment of the kill, not
   * only at startup: a session can finish, and its pid be handed to something
   * else, in the minutes between the panel starting and somebody pressing Kick.
   */
  it('re-checks the process at the moment of the kill, and ends nothing once it has been recycled', async () => {
    const { store: launchStore, sqlite } = store()
    const { launchId } = await runWithLaunch(launchStore)

    const { store: reopened } = store(sqlite)
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const machine = probe({ 4242: PROC_START })
    const nextRun = new LaunchedSessionRegistry({
      endProcessTree,
      processStartTimeMs: machine.processStartTimeMs,
      store: reopened
    })
    await nextRun.restore()

    machine.answers[4242] = PROC_START + 3_600_000
    await expect(nextRun.end(launchId)).resolves.toBe('already-ended')
    expect(endProcessTree).not.toHaveBeenCalled()
    await nextRun.settle()
    await expect(reopened.list()).resolves.toEqual([])
  })

  /*
   * The launch id is minted from a counter that starts again every run, so the
   * first launch of this run would otherwise be handed the id a restored one
   * already answers to — and the two would share one record.
   */
  it('never mints an id a restored launch already answers to', async () => {
    const { store: launchStore, sqlite } = store()
    const { launchId: restoredId } = await runWithLaunch(launchStore)

    const { store: reopened } = store(sqlite)
    const nextRun = new LaunchedSessionRegistry({
      endProcessTree: vi.fn().mockResolvedValue(true),
      processStartTimeMs: probe({ 4242: PROC_START, 99: PROC_START }).processStartTimeMs,
      store: reopened
    })
    await nextRun.restore()
    const freshId = nextRun.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(99).process,
      knownSessionIds: []
    })

    expect(freshId).not.toBe(restoredId)
    nextRun.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'thread-new' }), dwarf({ sessionId: 'thread-second' })])
    ])
    expect(nextRun.launchIdOf('thread-new')).toBe(restoredId)
    expect(nextRun.launchIdOf('thread-second')).toBe(freshId)
  })

  /*
   * #230's register, unchanged: with no store wired the whole restart half is
   * absent — nothing is probed, nothing is written, and every rule above this
   * describe block still holds. That is the regression guard, and it is why
   * both new collaborators are optional.
   */
  it('keeps the in-run register whole with no store and no probe at all', async () => {
    const { registry: launched, endProcessTree } = registry()
    const launchId = launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: handle(4242).process,
      knownSessionIds: []
    })
    launched.observe([mine(MINE_PATH, [dwarf({ sessionId: 'thread-new' })])])

    await launched.restore()
    await launched.settle()

    expect(launched.launchIdOfDwarf('codex:thread-new')).toBe(launchId)
    await expect(launched.end(launchId)).resolves.toBe('ended')
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })
})
