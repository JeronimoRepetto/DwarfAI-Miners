import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PINNED,
  createPinPreferenceStore,
  parsePinnedPreference,
  serializePinnedPreference,
  type PinPreferenceFsLike
} from './pinPreference'

/**
 * In-memory fs fake with real rename semantics (source must exist, target is
 * replaced), plus an event log so the atomic-write ordering can be asserted:
 * the final path must only ever appear as a rename target, never as a direct
 * write target.
 */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: string[] = []
  const fs: PinPreferenceFsLike = {
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

const FILE = 'C:/fake/userData/pin-preference-v1.json'

describe('parsePinnedPreference', () => {
  it('reads back both stored values', () => {
    expect(parsePinnedPreference('{"pinned":true}')).toBe(true)
    expect(parsePinnedPreference('{"pinned":false}')).toBe(false)
  })

  it('falls back to the pinned default on garbage content', () => {
    expect(parsePinnedPreference('not json at all')).toBe(DEFAULT_PINNED)
    expect(parsePinnedPreference('')).toBe(DEFAULT_PINNED)
  })

  it('falls back to the pinned default when the shape is wrong', () => {
    // A truthy-but-not-boolean value must never sneak in as "pinned".
    expect(parsePinnedPreference('{"pinned":"yes"}')).toBe(DEFAULT_PINNED)
    expect(parsePinnedPreference('{"pinned":1}')).toBe(DEFAULT_PINNED)
    expect(parsePinnedPreference('[]')).toBe(DEFAULT_PINNED)
    expect(parsePinnedPreference('null')).toBe(DEFAULT_PINNED)
    expect(parsePinnedPreference('{}')).toBe(DEFAULT_PINNED)
  })

  it('round-trips through serializePinnedPreference', () => {
    expect(parsePinnedPreference(serializePinnedPreference(false))).toBe(false)
    expect(parsePinnedPreference(serializePinnedPreference(true))).toBe(true)
  })
})

describe('createPinPreferenceStore', () => {
  it('defaults to pinned when no preference was ever saved', async () => {
    const { fs } = fakeFs()
    const store = createPinPreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe(true)
  })

  it('round-trips an explicit unpin across a "restart" (a fresh store on the same file)', async () => {
    const { fs } = fakeFs()
    await createPinPreferenceStore({ filePath: FILE, fs }).save(false)
    const rebooted = createPinPreferenceStore({ filePath: FILE, fs })
    await expect(rebooted.load()).resolves.toBe(false)
  })

  it('falls back to the pinned default when the stored file is corrupt', async () => {
    const { fs } = fakeFs({ [FILE]: '{"pinned":' })
    const store = createPinPreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe(true)
  })

  it('treats any read failure as "no preference" instead of blocking startup', async () => {
    const fs: PinPreferenceFsLike = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeFile: async () => undefined,
      rename: async () => undefined
    }
    const store = createPinPreferenceStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toBe(true)
  })

  it('writes atomically: a sibling temp file first, then a rename onto the final path', async () => {
    const { fs, events } = fakeFs()
    await createPinPreferenceStore({ filePath: FILE, fs }).save(false)
    expect(events).toHaveLength(2)
    // Defaults satisfy noUncheckedIndexedAccess; the length assertion above
    // already guarantees both events are present.
    const [write = '', rename = ''] = events
    // The write must target a sibling path (same directory, so the rename
    // stays on one volume), never the final file directly.
    expect(write.startsWith('write:')).toBe(true)
    expect(write).not.toBe(`write:${FILE}`)
    expect(write.startsWith(`write:${FILE}`)).toBe(true)
    expect(rename.endsWith(`->${FILE}`)).toBe(true)
  })

  it('replaces a previous value on save', async () => {
    const { fs } = fakeFs()
    const store = createPinPreferenceStore({ filePath: FILE, fs })
    await store.save(false)
    await store.save(true)
    await expect(store.load()).resolves.toBe(true)
  })
})
