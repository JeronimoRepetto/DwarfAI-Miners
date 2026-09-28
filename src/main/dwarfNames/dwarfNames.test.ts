import { describe, expect, it, vi } from 'vitest'
import type { Dwarf, Mine, MineHistorySpeaker } from '../domain/types'
import { SqliteWriteError } from '../adapters/sqliteWritable'
import {
  createMemoryDwarfNameStore,
  createSqliteDwarfNameStore,
  type DwarfNameStore
} from './dwarfNameStore'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { createAppDatabase } from '../appDatabase/appDatabase'
import {
  DWARF_NAME_INPUT_LIMIT,
  DWARF_NAME_NOT_SAVED,
  DWARF_NAME_TOO_LONG,
  DwarfNames,
  parseDwarfNameRequest,
  stampCustomNames,
  stampSpeakerNames
} from './dwarfNames'

const WORKER: Pick<Dwarf, 'id' | 'provider' | 'name'> = {
  id: 'claude:session-1:agent-9',
  provider: 'claude',
  name: 'Explorer'
}

function names(store: DwarfNameStore = createMemoryDwarfNameStore(), warn = vi.fn()) {
  const clock = { now: 1_788_001_972_136 }
  return { names: new DwarfNames({ store, now: () => clock.now, warn }), store, warn, clock }
}

/** A store whose every call rejects the way a locked database does. */
function brokenStore(): DwarfNameStore {
  const fail = (): Promise<never> =>
    Promise.reject(new SqliteWriteError('locked', 'database is locked'))
  return { list: fail, put: fail, remove: fail }
}

describe('DwarfNames — giving a dwarf a name (#635)', () => {
  it('keeps the cleaned text as the custom name and writes it down', async () => {
    const { names: registry, store, clock } = names()

    await expect(registry.set(WORKER, '  Stone   beard ')).resolves.toEqual({
      saved: true,
      customName: 'Stone beard'
    })
    expect(registry.nameOf(WORKER.id)).toBe('Stone beard')
    await expect(store.list()).resolves.toEqual([
      { dwarfId: WORKER.id, provider: 'claude', customName: 'Stone beard', setAt: clock.now }
    ])
  })

  // Main never trusts what the renderer says it saved: the same rules run again here.
  it('cleans what it is handed, whatever the field let through', async () => {
    const { names: registry } = names()

    await expect(registry.set(WORKER, 'Stone\u0000beard 😀')).resolves.toEqual({
      saved: true,
      customName: 'Stone beard'
    })
  })

  it('removes the custom name when the text is saved empty', async () => {
    const { names: registry, store } = names()
    await registry.set(WORKER, 'Stonebeard')

    await expect(registry.set(WORKER, '   ')).resolves.toEqual({ saved: true })
    expect(registry.nameOf(WORKER.id)).toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })

  it('removes the custom name when the text is the base name', async () => {
    const { names: registry, store } = names()
    await registry.set(WORKER, 'Stonebeard')

    await expect(registry.set(WORKER, ' Explorer ')).resolves.toEqual({ saved: true })
    expect(registry.nameOf(WORKER.id)).toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })

  it('resets to the base name, and a reset with nothing to reset still succeeds', async () => {
    const { names: registry } = names()
    await registry.set(WORKER, 'Stonebeard')

    await expect(registry.reset(WORKER.id)).resolves.toEqual({ saved: true })
    expect(registry.nameOf(WORKER.id)).toBeUndefined()
    await expect(registry.reset(WORKER.id)).resolves.toEqual({ saved: true })
  })

  it('writes nothing when the name is already the one kept', async () => {
    const store = createMemoryDwarfNameStore()
    const put = vi.spyOn(store, 'put')
    const { names: registry } = names(store)
    await registry.set(WORKER, 'Stonebeard')

    await registry.set(WORKER, 'Stonebeard ')

    expect(put).toHaveBeenCalledTimes(1)
  })

  it('lets two dwarfs carry the same name', async () => {
    const { names: registry } = names()
    await registry.set(WORKER, 'Stonebeard')
    await registry.set(
      { id: 'codex:thread-1', provider: 'codex', name: 'codex-thread-1' },
      'Stonebeard'
    )

    expect(registry.nameOf(WORKER.id)).toBe('Stonebeard')
    expect(registry.nameOf('codex:thread-1')).toBe('Stonebeard')
  })

  // The field holds 24 characters; a payload far past anything it could send is refused rather
  // than segmented, so the renderer cannot make main walk an arbitrarily long string.
  it('refuses text far longer than any name the field could hold', async () => {
    const { names: registry, store } = names()

    await expect(registry.set(WORKER, 'a'.repeat(DWARF_NAME_INPUT_LIMIT + 1))).resolves.toEqual({
      saved: false,
      reason: DWARF_NAME_TOO_LONG
    })
    await expect(store.list()).resolves.toEqual([])
    await expect(registry.set(WORKER, 'a'.repeat(DWARF_NAME_INPUT_LIMIT))).resolves.toEqual({
      saved: true,
      customName: 'a'.repeat(24)
    })
  })
})

describe('DwarfNames — across runs (#635)', () => {
  it('reads the names an earlier run kept', async () => {
    const store = createMemoryDwarfNameStore()
    await names(store).names.set(WORKER, 'Stonebeard')

    const next = names(store).names
    expect(next.nameOf(WORKER.id)).toBeUndefined()
    await expect(next.load()).resolves.toBe(true)
    expect(next.nameOf(WORKER.id)).toBe('Stonebeard')
  })

  it('says a load changed nothing when nobody renamed a dwarf', async () => {
    await expect(names().names.load()).resolves.toBe(false)
  })

  it('loads once however often it is asked', async () => {
    const store = createMemoryDwarfNameStore()
    const list = vi.spyOn(store, 'list')
    const { names: registry } = names(store)

    await Promise.all([registry.load(), registry.load()])
    await registry.set(WORKER, 'Stonebeard')

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reads the kept names before a save, so a save never races the load', async () => {
    const store = createMemoryDwarfNameStore()
    await names(store).names.set({ ...WORKER, id: 'claude:other' }, 'Ironfoot')

    const next = names(store).names
    await next.set(WORKER, 'Stonebeard')

    expect(next.nameOf('claude:other')).toBe('Ironfoot')
  })
})

/*
 * A custom name is user data: kept per machine, never logged (decision log, Dwarf names). The
 * store failing is exactly when a log line is written, so that is where a leak would be.
 */
describe('DwarfNames — a database that will not answer (#635)', () => {
  it('refuses the save and keeps the name the dwarf had', async () => {
    const { names: registry } = names(brokenStore())

    await expect(registry.set(WORKER, 'Stonebeard')).resolves.toEqual({
      saved: false,
      reason: DWARF_NAME_NOT_SAVED
    })
    await expect(registry.reset(WORKER.id)).resolves.toEqual({ saved: true })
    expect(registry.nameOf(WORKER.id)).toBeUndefined()
  })

  it('says what failed without ever saying the name', async () => {
    const { names: registry, warn } = names(brokenStore())

    await registry.load()
    await registry.set(WORKER, 'Stonebeard')

    expect(warn).toHaveBeenCalled()
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('Stonebeard')
    }
  })
})

describe('stampCustomNames (#635)', () => {
  function mine(dwarfs: Dwarf[]): Mine {
    return { id: 'mine:a', name: 'project', path: 'C:\\work\\project', dwarfs } as unknown as Mine
  }
  function dwarf(id: string, extra: Partial<Dwarf> = {}): Dwarf {
    return {
      id,
      provider: 'claude',
      role: 'worker',
      name: 'Explorer',
      status: 'working',
      sessionId: 'session-1',
      ...extra
    }
  }

  it('puts a custom name beside the base name, which it never touches', () => {
    const [stamped] = stampCustomNames([mine([dwarf('claude:a')])], (id) =>
      id === 'claude:a' ? 'Stonebeard' : undefined
    )
    expect(stamped!.dwarfs[0]).toMatchObject({ name: 'Explorer', customName: 'Stonebeard' })
  })

  it('takes a custom name off a dwarf whose name was reset', () => {
    const [stamped] = stampCustomNames(
      [mine([dwarf('claude:a', { customName: 'Old' })])],
      () => undefined
    )
    expect(stamped!.dwarfs[0]).not.toHaveProperty('customName')
  })

  // The same board back is how the runtime knows a rename changed nothing it must republish.
  it('hands the same board back when no name changed', () => {
    const board = [mine([dwarf('claude:a', { customName: 'Stonebeard' }), dwarf('claude:b')])]
    expect(stampCustomNames(board, (id) => (id === 'claude:a' ? 'Stonebeard' : undefined))).toBe(
      board
    )
  })
})

describe('stampSpeakerNames (#635)', () => {
  it('puts a speaker’s custom name beside the name its transcript gave it', () => {
    const speakers: MineHistorySpeaker[] = [
      {
        id: 'claude:a',
        provider: 'claude',
        role: 'foreman',
        name: 'a1b2c3d4',
        lastMessageAt: 1,
        messages: []
      },
      {
        id: 'claude:b',
        provider: 'claude',
        role: 'worker',
        name: 'Explorer',
        lastMessageAt: 1,
        messages: []
      }
    ]
    const stamped = stampSpeakerNames(speakers, (id) =>
      id === 'claude:a' ? 'Stonebeard' : undefined
    )
    expect(stamped[0]).toMatchObject({ name: 'a1b2c3d4', customName: 'Stonebeard' })
    expect(stamped[1]).not.toHaveProperty('customName')
  })
})

/*
 * ADDED for #635 (verifier finding): what is saved, what is published and what a restart reads
 * back must be the same string. Round-tripped through the real node:sqlite driver behind
 * MemoryWritableSqlite, which is where a lone surrogate used to become U+FFFD.
 */
describe('DwarfNames — a name survives the database byte for byte (#635)', () => {
  it('reads back after a restart exactly the name it published, lone surrogate included', async () => {
    const sqlite = new MemoryWritableSqlite()
    const store = () =>
      createSqliteDwarfNameStore({
        database: createAppDatabase({ filePath: 'C:\\userData\\projects-v1.db', sqlite })
      })
    const first = names(store()).names
    const saved = await first.set(WORKER, 'Stone\uD800beard')
    const published = first.nameOf(WORKER.id)
    expect(saved).toEqual({ saved: true, customName: published })

    const next = names(store()).names
    await next.load()

    expect(next.nameOf(WORKER.id)).toBe(published)
  })
})

/*
 * ADDED for #635 (verifier finding): the IPC boundary's shape check. A payload whose name is not a
 * string is refused, never read as a reset — only a real empty string means "remove the custom
 * name" (screens/message.md: saved empty, it removes the custom name).
 */
describe('parseDwarfNameRequest (#635)', () => {
  it('takes a dwarf id and a name, and nothing else', () => {
    expect(
      parseDwarfNameRequest({ dwarfId: 'claude:s1', name: 'Stonebeard', provider: 'codex' })
    ).toEqual({ dwarfId: 'claude:s1', name: 'Stonebeard' })
  })

  it('keeps a real empty name, which removes the custom name', () => {
    expect(parseDwarfNameRequest({ dwarfId: 'claude:s1', name: '' })).toEqual({
      dwarfId: 'claude:s1',
      name: ''
    })
  })

  it('refuses a payload whose name is missing or not a string', () => {
    expect(parseDwarfNameRequest({ dwarfId: 'claude:s1' })).toBeNull()
    expect(parseDwarfNameRequest({ dwarfId: 'claude:s1', name: null })).toBeNull()
    expect(parseDwarfNameRequest({ dwarfId: 'claude:s1', name: 7 })).toBeNull()
  })

  it('refuses a payload with no dwarf id, or none at all', () => {
    expect(parseDwarfNameRequest({ dwarfId: '', name: 'Stonebeard' })).toBeNull()
    expect(parseDwarfNameRequest({ name: 'Stonebeard' })).toBeNull()
    expect(parseDwarfNameRequest(null)).toBeNull()
    expect(parseDwarfNameRequest('Stonebeard')).toBeNull()
  })
})
