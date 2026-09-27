import { describe, expect, it } from 'vitest'
import { DEFAULT_LAUNCH_VIEW, type LaunchView } from '../domain/types'
import {
  createLaunchViewStore,
  serializeLaunchView,
  type LaunchViewFsLike
} from './launchViewPreference'

/*
 * The page and the mine the app opens on (#635, PANEL-QUESTIONS 25): the last ones open, kept per
 * machine. What is pinned here is the store's half — what it reads back, and how few writes a
 * burst of changes costs the disk.
 */

const FILE = '/launch-view.json'

interface FakeFs extends LaunchViewFsLike {
  files: Map<string, string>
  /** Every write, in order, temp files included. */
  writes: string[]
  /** While set, each write waits for `release()` before it lands. */
  hold: boolean
  release: () => void
  /** The next write rejects once. */
  failNext: boolean
}

/** The in-memory shape the sibling preference tests use, plus a gate on writes. */
function fakeFs(initial?: string): FakeFs {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(FILE, initial)
  let waiting: (() => void)[] = []
  const fs: FakeFs = {
    files,
    writes: [],
    hold: false,
    failNext: false,
    release: () => {
      const now = waiting
      waiting = []
      for (const go of now) go()
    },
    readFile: (path) => {
      const held = files.get(path)
      if (held === undefined) return Promise.reject(new Error(`ENOENT ${path}`))
      return Promise.resolve(held)
    },
    writeFile: async (path, data) => {
      if (fs.hold) await new Promise<void>((resolve) => waiting.push(resolve))
      if (fs.failNext) {
        fs.failNext = false
        throw new Error('EACCES')
      }
      fs.writes.push(data)
      files.set(path, data)
    },
    rename: (from, to) => {
      const held = files.get(from)
      if (held === undefined) return Promise.reject(new Error(`ENOENT ${from}`))
      files.delete(from)
      files.set(to, held)
      return Promise.resolve()
    }
  }
  return fs
}

const MINES_OPEN: LaunchView = { area: 'mines', mineId: 'north-shaft' }

describe('serializeLaunchView', () => {
  it('writes the two fields, newline-terminated like the other markers', () => {
    expect(serializeLaunchView(MINES_OPEN)).toBe('{"area":"mines","mineId":"north-shaft"}\n')
  })

  it('parses on the way out, so the one writer cannot store what the next start would refuse', () => {
    expect(serializeLaunchView({ area: 'vault', mineId: '' } as unknown as LaunchView)).toBe(
      '{"area":"map","mineId":null}\n'
    )
  })
})

describe('createLaunchViewStore — reading', () => {
  it('opens the default view on a first run, with no file to read', async () => {
    const store = createLaunchViewStore({ filePath: FILE, fs: fakeFs() })
    expect(await store.load()).toEqual(DEFAULT_LAUNCH_VIEW)
  })

  it('reads back the page and the mine a previous run stored', async () => {
    const store = createLaunchViewStore({
      filePath: FILE,
      fs: fakeFs('{"area":"settings","mineId":"north-shaft"}\n')
    })
    expect(await store.load()).toEqual({ area: 'settings', mineId: 'north-shaft' })
  })

  it('reads unparseable bytes as nothing remembered, and says which file it discarded', async () => {
    const warnings: string[] = []
    const store = createLaunchViewStore({
      filePath: FILE,
      fs: fakeFs('{"area":'),
      onWarn: (message) => warnings.push(message)
    })
    expect(await store.load()).toEqual(DEFAULT_LAUNCH_VIEW)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(FILE)
  })

  it('reads a document that is not an object as nothing remembered', async () => {
    const store = createLaunchViewStore({
      filePath: FILE,
      fs: fakeFs('["mines"]'),
      onWarn: () => {}
    })
    expect(await store.load()).toEqual(DEFAULT_LAUNCH_VIEW)
  })
})

describe('createLaunchViewStore — remembering', () => {
  it('writes atomically: through a sibling temp file, renamed onto the document', async () => {
    const fs = fakeFs()
    const store = createLaunchViewStore({ filePath: FILE, fs })
    await store.remember(MINES_OPEN)
    expect(fs.files.get(FILE)).toBe(serializeLaunchView(MINES_OPEN))
    expect([...fs.files.keys()]).toEqual([FILE])
    expect(await store.load()).toEqual(MINES_OPEN)
  })

  it('coalesces a burst: one write in flight, and only the latest view waiting behind it', async () => {
    const fs = fakeFs()
    const store = createLaunchViewStore({ filePath: FILE, fs })
    fs.hold = true
    const first = store.remember({ area: 'mines', mineId: null })
    for (const area of ['settings', 'map', 'mines'] as const) {
      void store.remember({ area, mineId: 'north-shaft' })
    }
    const last = store.remember({ area: 'settings', mineId: 'south-shaft' })
    fs.hold = false
    fs.release()
    await Promise.all([first, last])
    expect(fs.writes).toEqual([
      serializeLaunchView({ area: 'mines', mineId: null }),
      serializeLaunchView({ area: 'settings', mineId: 'south-shaft' })
    ])
    expect(await store.load()).toEqual({ area: 'settings', mineId: 'south-shaft' })
  })

  it('writes nothing for the view already stored', async () => {
    const fs = fakeFs(serializeLaunchView(MINES_OPEN))
    const store = createLaunchViewStore({ filePath: FILE, fs })
    await store.load()
    await store.remember({ ...MINES_OPEN })
    expect(fs.writes).toEqual([])
    await store.remember({ area: 'map', mineId: null })
    await store.remember({ area: 'map', mineId: null })
    expect(fs.writes).toEqual([serializeLaunchView({ area: 'map', mineId: null })])
  })

  it('warns about a write that failed rather than rejecting, and the next change writes again', async () => {
    const warnings: string[] = []
    const fs = fakeFs()
    const store = createLaunchViewStore({
      filePath: FILE,
      fs,
      onWarn: (message) => warnings.push(message)
    })
    fs.failNext = true
    await expect(store.remember(MINES_OPEN)).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(FILE)
    await store.remember(MINES_OPEN)
    expect(fs.files.get(FILE)).toBe(serializeLaunchView(MINES_OPEN))
  })
})
