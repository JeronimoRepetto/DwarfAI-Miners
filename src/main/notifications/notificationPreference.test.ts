import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATIONS_ENABLED } from '../domain/types'
import {
  createNotificationPreferenceStore,
  parseNotificationsEnabled,
  serializeNotificationsEnabled,
  type NotificationPreferenceFsLike
} from './notificationPreference'

/**
 * The persisted Settings switch (#316), stored the way every other preference
 * under userData is.
 *
 * The fake mirrors pinPreference.test.ts's exactly — real rename semantics plus
 * an event log — because the atomic-write ordering is the same property here:
 * the final path may only ever appear as a rename target.
 */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: string[] = []
  const fs: NotificationPreferenceFsLike = {
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

const FILE = 'C:/fake/userData/notification-preference-v1.json'

describe('parseNotificationsEnabled', () => {
  it('is on until somebody turns it off, which is what #316 asks for', () => {
    expect(DEFAULT_NOTIFICATIONS_ENABLED).toBe(true)
  })

  it('reads back both stored values', () => {
    expect(parseNotificationsEnabled('{"enabled":true}')).toBe(true)
    expect(parseNotificationsEnabled('{"enabled":false}')).toBe(false)
  })

  it('falls back to the default on garbage content', () => {
    expect(parseNotificationsEnabled('not json at all')).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
    expect(parseNotificationsEnabled('')).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
  })

  it('falls back to the default when the shape is wrong', () => {
    // A truthy-but-not-boolean value must never read as a choice somebody made.
    expect(parseNotificationsEnabled('{"enabled":"yes"}')).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
    expect(parseNotificationsEnabled('{"enabled":0}')).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
    expect(parseNotificationsEnabled('[]')).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
    expect(parseNotificationsEnabled('null')).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
    expect(parseNotificationsEnabled('{}')).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
  })

  it('round-trips through serializeNotificationsEnabled', () => {
    expect(parseNotificationsEnabled(serializeNotificationsEnabled(false))).toBe(false)
    expect(parseNotificationsEnabled(serializeNotificationsEnabled(true))).toBe(true)
  })
})

describe('createNotificationPreferenceStore', () => {
  it('defaults to on when no preference was ever saved', async () => {
    const { fs } = fakeFs()
    await expect(createNotificationPreferenceStore({ filePath: FILE, fs }).load()).resolves.toBe(
      true
    )
  })

  it('round-trips an explicit off across a "restart" (a fresh store on the same file)', async () => {
    const { fs } = fakeFs()
    await createNotificationPreferenceStore({ filePath: FILE, fs }).save(false)
    const rebooted = createNotificationPreferenceStore({ filePath: FILE, fs })
    await expect(rebooted.load()).resolves.toBe(false)
  })

  it('falls back to on when the stored file is corrupt', async () => {
    const { fs } = fakeFs({ [FILE]: '{"enabled":' })
    await expect(createNotificationPreferenceStore({ filePath: FILE, fs }).load()).resolves.toBe(
      true
    )
  })

  it('treats any read failure as "no preference" instead of blocking startup', async () => {
    const fs: NotificationPreferenceFsLike = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeFile: async () => undefined,
      rename: async () => undefined
    }
    await expect(createNotificationPreferenceStore({ filePath: FILE, fs }).load()).resolves.toBe(
      true
    )
  })

  it('writes atomically: a sibling temp file first, then a rename onto the final path', async () => {
    const { fs, events } = fakeFs()
    await createNotificationPreferenceStore({ filePath: FILE, fs }).save(false)
    expect(events).toHaveLength(2)
    const [write = '', rename = ''] = events
    expect(write.startsWith('write:')).toBe(true)
    expect(write).not.toBe(`write:${FILE}`)
    expect(write.startsWith(`write:${FILE}`)).toBe(true)
    expect(rename.endsWith(`->${FILE}`)).toBe(true)
  })

  it('replaces a previous value on save', async () => {
    const { fs } = fakeFs()
    const store = createNotificationPreferenceStore({ filePath: FILE, fs })
    await store.save(false)
    await store.save(true)
    await expect(store.load()).resolves.toBe(true)
  })
})
