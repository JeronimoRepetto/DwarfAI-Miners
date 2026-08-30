import { describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../shared/accelerator'
import {
  createShortcutPreferenceStore,
  parseStoredAccelerator,
  serializeStoredAccelerator,
  type ShortcutPreferenceFsLike
} from './shortcutPreference'

/**
 * In-memory fs fake with real rename semantics (source must exist, target is
 * replaced), plus an event log so the atomic-write ordering can be asserted:
 * the final path must only ever appear as a rename target, never as a direct
 * write target. Mirrors the pin-preference fake for the same reasons.
 */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: string[] = []
  const fs: ShortcutPreferenceFsLike = {
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

const FILE = 'C:/fake/userData/shortcut-preference-v1.json'

describe('parseStoredAccelerator', () => {
  it('reads back a stored accelerator', () => {
    expect(parseStoredAccelerator('{"accelerator":"Control+Shift+K"}')).toBe('Control+Shift+K')
  })

  it('falls back to the default on garbage content', () => {
    expect(parseStoredAccelerator('not json at all')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('{"accelerator":')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('falls back to the default when the shape is wrong', () => {
    expect(parseStoredAccelerator('{"accelerator":42}')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('{"accelerator":null}')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('{}')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('[]')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('null')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('"Control+K"')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('falls back to the default when the stored string is not a shortcut we would register', () => {
    // A hand-edited file must not be able to talk the app into claiming a bare
    // key machine-wide, or into handing Electron a string it throws on.
    expect(parseStoredAccelerator('{"accelerator":"P"}')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('{"accelerator":"Shift+P"}')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('{"accelerator":"Control"}')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(parseStoredAccelerator('{"accelerator":"Control+NotAKey"}')).toBe(
      DEFAULT_TOGGLE_ACCELERATOR
    )
    expect(parseStoredAccelerator('{"accelerator":""}')).toBe(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('canonicalizes a valid but differently spelled stored accelerator', () => {
    // Hand-editing the file with 'ctrl+shift+k' should work, and must produce
    // the same string a recording would, so "is this the default?" stays honest.
    expect(parseStoredAccelerator('{"accelerator":"ctrl+shift+k"}')).toBe('Control+Shift+K')
  })

  it('round-trips through serializeStoredAccelerator', () => {
    expect(parseStoredAccelerator(serializeStoredAccelerator('Control+Alt+K'))).toBe(
      'Control+Alt+K'
    )
  })

  it('serializes as newline-terminated JSON, like the other preference files', () => {
    expect(serializeStoredAccelerator('Control+Alt+K')).toBe('{"accelerator":"Control+Alt+K"}\n')
  })
})

describe('createShortcutPreferenceStore', () => {
  it('defaults to Ctrl+Alt+Shift+P when no preference was ever saved', async () => {
    const { fs } = fakeFs()
    const store = createShortcutPreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('round-trips a chosen accelerator across a "restart" (a fresh store on the same file)', async () => {
    const { fs } = fakeFs()
    await createShortcutPreferenceStore({ filePath: FILE, fs }).save('Control+Alt+M')
    const rebooted = createShortcutPreferenceStore({ filePath: FILE, fs })
    await expect(rebooted.load()).resolves.toBe('Control+Alt+M')
  })

  it('falls back to the default when the stored file is corrupt', async () => {
    const { fs } = fakeFs({ [FILE]: '{"accelerator":' })
    const store = createShortcutPreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('treats any read failure as "no preference" instead of blocking startup', async () => {
    const fs: ShortcutPreferenceFsLike = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeFile: async () => undefined,
      rename: async () => undefined
    }
    const store = createShortcutPreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('writes atomically: a sibling temp file first, then a rename onto the final path', async () => {
    const { fs, events } = fakeFs()
    await createShortcutPreferenceStore({ filePath: FILE, fs }).save('Control+Alt+M')
    expect(events).toHaveLength(2)
    const [write = '', rename = ''] = events
    expect(write.startsWith(`write:${FILE}`)).toBe(true)
    expect(write).not.toBe(`write:${FILE}`)
    expect(rename.endsWith(`->${FILE}`)).toBe(true)
  })

  it('replaces a previous value on save', async () => {
    const { fs } = fakeFs()
    const store = createShortcutPreferenceStore({ filePath: FILE, fs })
    await store.save('Control+Alt+M')
    await store.save('Control+Alt+N')
    await expect(store.load()).resolves.toBe('Control+Alt+N')
  })

  it("stores the canonical spelling, never the caller's", async () => {
    const { fs, files } = fakeFs()
    await createShortcutPreferenceStore({ filePath: FILE, fs }).save('shift+ctrl+m')
    expect(files.get(FILE)).toBe('{"accelerator":"Control+Shift+M"}\n')
  })

  it('refuses to persist a value it would refuse to load back', async () => {
    // Writing an unusable accelerator would produce a file that silently falls
    // back on the next launch — the user's choice would vanish without a word.
    const { fs, events } = fakeFs()
    const store = createShortcutPreferenceStore({ filePath: FILE, fs })
    await expect(store.save('Shift+P')).rejects.toThrow()
    expect(events).toEqual([])
  })
})
