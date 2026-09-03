import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_EDGE,
  createPanelEdgePreferenceStore,
  parsePanelEdgePreference,
  serializePanelEdgePreference,
  type PanelEdgePreferenceFsLike
} from './panelEdgePreference'

/**
 * The persisted Settings position preference (#138) — the left/right choice
 * the position control makes, so it survives an app restart. Storage mirrors
 * pinPreference.ts exactly, including this fake: a Map-based fs with real
 * rename semantics (source must exist, target is replaced) plus an event log,
 * so the atomic-write ordering is provable rather than assumed.
 */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: string[] = []
  const fs: PanelEdgePreferenceFsLike = {
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

const FILE = 'C:/fake/userData/panel-edge-v1.json'

describe('parsePanelEdgePreference', () => {
  it('reads back both stored edges', () => {
    expect(parsePanelEdgePreference('{"edge":"left"}')).toBe('left')
    expect(parsePanelEdgePreference('{"edge":"right"}')).toBe('right')
  })

  it('falls back to the documented default (right) on garbage content', () => {
    expect(parsePanelEdgePreference('not json at all')).toBe(DEFAULT_PANEL_EDGE)
    expect(parsePanelEdgePreference('')).toBe(DEFAULT_PANEL_EDGE)
  })

  it('falls back to the documented default when the shape is wrong', () => {
    // An edge no build recognizes must never sneak in as a real choice.
    expect(parsePanelEdgePreference('{"edge":"top"}')).toBe(DEFAULT_PANEL_EDGE)
    expect(parsePanelEdgePreference('{"edge":7}')).toBe(DEFAULT_PANEL_EDGE)
    expect(parsePanelEdgePreference('[]')).toBe(DEFAULT_PANEL_EDGE)
    expect(parsePanelEdgePreference('null')).toBe(DEFAULT_PANEL_EDGE)
    expect(parsePanelEdgePreference('{}')).toBe(DEFAULT_PANEL_EDGE)
  })

  it('round-trips through serializePanelEdgePreference', () => {
    expect(parsePanelEdgePreference(serializePanelEdgePreference('left'))).toBe('left')
    expect(parsePanelEdgePreference(serializePanelEdgePreference('right'))).toBe('right')
  })
})

describe('createPanelEdgePreferenceStore', () => {
  it('defaults to right when no preference was ever saved', async () => {
    const { fs } = fakeFs()
    const store = createPanelEdgePreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe('right')
  })

  it('round-trips an explicit left across a "restart" (a fresh store on the same file)', async () => {
    const { fs } = fakeFs()
    await createPanelEdgePreferenceStore({ filePath: FILE, fs }).save('left')
    const rebooted = createPanelEdgePreferenceStore({ filePath: FILE, fs })
    await expect(rebooted.load()).resolves.toBe('left')
  })

  it('falls back to the documented default when the stored file is corrupt', async () => {
    const { fs } = fakeFs({ [FILE]: '{"edge":' })
    const store = createPanelEdgePreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe('right')
  })

  it('treats any read failure as "no preference" instead of blocking startup', async () => {
    const fs: PanelEdgePreferenceFsLike = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeFile: async () => undefined,
      rename: async () => undefined
    }
    const store = createPanelEdgePreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe('right')
  })

  it('writes atomically: a sibling temp file first, then a rename onto the final path', async () => {
    const { fs, events } = fakeFs()
    await createPanelEdgePreferenceStore({ filePath: FILE, fs }).save('left')
    expect(events).toHaveLength(2)
    const [write = '', rename = ''] = events
    expect(write.startsWith('write:')).toBe(true)
    expect(write).not.toBe(`write:${FILE}`)
    expect(write.startsWith(`write:${FILE}`)).toBe(true)
    expect(rename.endsWith(`->${FILE}`)).toBe(true)
  })

  it('replaces a previous value on save', async () => {
    const { fs } = fakeFs()
    const store = createPanelEdgePreferenceStore({ filePath: FILE, fs })
    await store.save('left')
    await store.save('right')
    await expect(store.load()).resolves.toBe('right')
  })
})
