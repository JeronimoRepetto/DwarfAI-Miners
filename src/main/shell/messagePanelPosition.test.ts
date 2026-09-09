import { describe, expect, it } from 'vitest'
import {
  createMessagePanelPositionStore,
  parseMessagePanelPosition,
  serializeMessagePanelPosition,
  type MessagePanelPositionFsLike
} from './messagePanelPosition'

/**
 * The persisted position of a message panel the person moved (#296) — so a
 * panel dragged onto the shell, or across the desktop, is still there after a
 * restart. Storage mirrors panelEdgePreference.ts exactly, including this fake:
 * a Map-based fs with real rename semantics (source must exist, target is
 * replaced) plus an event log, so the atomic-write ordering is provable rather
 * than assumed.
 */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: string[] = []
  const fs: MessagePanelPositionFsLike = {
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      }
      return content
    },
    writeFile: async (path, data) => {
      files.set(path, data)
      events.push(`write:${path}`)
    },
    rename: async (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, content)
      events.push(`rename:${from}->${to}`)
    }
  }
  return { fs, files, events }
}

const FILE = 'C:/fake/userData/message-panel-position-v1.json'

describe('parseMessagePanelPosition', () => {
  it('reads back a stored anchor', () => {
    expect(parseMessagePanelPosition('{"x":300,"bottom":900}')).toEqual({ x: 300, bottom: 900 })
  })

  it('reads a negative origin, because a second display can have one', () => {
    expect(parseMessagePanelPosition('{"x":-1600,"bottom":1000}')).toEqual({
      x: -1600,
      bottom: 1000
    })
  })

  it('rounds to whole pixels, which is all Electron accepts for bounds', () => {
    expect(parseMessagePanelPosition('{"x":300.6,"bottom":899.4}')).toEqual({ x: 301, bottom: 899 })
  })

  it('answers "docked" for garbage content', () => {
    // A broken file must behave like a missing one: the panel opens beside the
    // shell, which is where it opens on a first run anyway.
    expect(parseMessagePanelPosition('not json at all')).toBeNull()
    expect(parseMessagePanelPosition('')).toBeNull()
  })

  it('answers "docked" when the shape is wrong', () => {
    expect(parseMessagePanelPosition('{}')).toBeNull()
    expect(parseMessagePanelPosition('[]')).toBeNull()
    expect(parseMessagePanelPosition('null')).toBeNull()
    expect(parseMessagePanelPosition('{"x":300}')).toBeNull()
    expect(parseMessagePanelPosition('{"bottom":900}')).toBeNull()
    expect(parseMessagePanelPosition('{"x":"300","bottom":900}')).toBeNull()
  })

  it('answers "docked" for a coordinate no window could be placed at', () => {
    // A non-finite number reaches setBounds as a rectangle Electron cannot
    // apply, and the window would vanish with nothing saying why.
    expect(parseMessagePanelPosition('{"x":null,"bottom":900}')).toBeNull()
    expect(parseMessagePanelPosition(`{"x":1e999,"bottom":900}`)).toBeNull()
  })

  it('round-trips through serializeMessagePanelPosition, docked included', () => {
    const anchor = { x: 300, bottom: 900 }
    expect(parseMessagePanelPosition(serializeMessagePanelPosition(anchor))).toEqual(anchor)
    expect(parseMessagePanelPosition(serializeMessagePanelPosition(null))).toBeNull()
  })
})

describe('createMessagePanelPositionStore', () => {
  it('answers "docked" when no position was ever saved', async () => {
    const { fs } = fakeFs()
    const store = createMessagePanelPositionStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBeNull()
  })

  it('round-trips a moved panel across a "restart" (a fresh store on the same file)', async () => {
    const { fs } = fakeFs()
    await createMessagePanelPositionStore({ filePath: FILE, fs }).save({ x: 300, bottom: 900 })
    const rebooted = createMessagePanelPositionStore({ filePath: FILE, fs })
    await expect(rebooted.load()).resolves.toEqual({ x: 300, bottom: 900 })
  })

  it('forgets the position when the panel is snapped back to the shell', async () => {
    const { fs } = fakeFs()
    const store = createMessagePanelPositionStore({ filePath: FILE, fs })
    await store.save({ x: 300, bottom: 900 })
    await store.save(null)
    await expect(store.load()).resolves.toBeNull()
  })

  it('answers "docked" when the stored file is corrupt', async () => {
    const { fs } = fakeFs({ [FILE]: '{"x":' })
    const store = createMessagePanelPositionStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBeNull()
  })

  it('treats any read failure as "docked" instead of blocking startup', async () => {
    const fs: MessagePanelPositionFsLike = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeFile: async () => undefined,
      rename: async () => undefined
    }
    const store = createMessagePanelPositionStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBeNull()
  })

  it('writes atomically: a sibling temp file first, then a rename onto the final path', async () => {
    const { fs, events } = fakeFs()
    await createMessagePanelPositionStore({ filePath: FILE, fs }).save({ x: 300, bottom: 900 })
    expect(events).toHaveLength(2)
    const [write = '', rename = ''] = events
    expect(write.startsWith('write:')).toBe(true)
    expect(write).not.toBe(`write:${FILE}`)
    expect(write.startsWith(`write:${FILE}`)).toBe(true)
    expect(rename.endsWith(`->${FILE}`)).toBe(true)
  })
})
