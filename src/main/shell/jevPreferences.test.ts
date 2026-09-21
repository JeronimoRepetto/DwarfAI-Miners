import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJevPreferenceStore, type JevPreferenceFsLike } from './jevPreferences'
import type { DwarfProvider } from '../domain/types'

/**
 * The persisted routing profile and default launch behind Settings' Jev
 * section (#509 follow-up).
 *
 * Storage mirrors every other preference here (audioPreference.ts and its
 * siblings): one tiny JSON document under userData, rewritten atomically
 * through a sibling temp file plus a rename, with an injected fs so the
 * tests need no real disk. What makes THIS store different from an ordinary
 * preference is that a value can be wrong in a way no shape check can catch —
 * a default naming a provider this build cannot launch, or a model/effort
 * pairing the launch gate itself would refuse — so `save` re-validates
 * against that same gate and refuses to write anything the next launch could
 * not carry out.
 */
const USER_DATA_DIR = 'C:/fake/userData'
const FILE = join(USER_DATA_DIR, 'jev-preferences-v1.json')

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: string[] = []
  const fs: JevPreferenceFsLike = {
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

describe('createJevPreferenceStore — a fresh install', () => {
  it('answers the documented defaults on a first run, with no file to read', async () => {
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs: fakeFs().fs })
    expect(await store.load()).toEqual({ profile: 'balanced', default: {} })
  })
})

describe('createJevPreferenceStore — saving a valid default', () => {
  it('saves a profile alone, and reads it back after a "restart"', async () => {
    const { fs } = fakeFs()
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    expect(await store.save({ profile: 'premium', default: {} })).toEqual({ saved: true })

    const rebooted = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    expect(await rebooted.load()).toEqual({ profile: 'premium', default: {} })
  })

  it('saves a default that only pins a provider, leaving model and effort to the CLI', async () => {
    const { fs } = fakeFs()
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    const preferences = { profile: 'balanced' as const, default: { provider: 'claude' as const } }
    expect(await store.save(preferences)).toEqual({ saved: true })
    expect(await store.load()).toEqual(preferences)
  })

  it('saves a full default — provider, model and effort — once the gate accepts it', async () => {
    const { fs } = fakeFs()
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    const preferences = {
      profile: 'economy' as const,
      default: { provider: 'claude' as const, model: 'sonnet', effort: 'low' }
    }
    expect(await store.save(preferences)).toEqual({ saved: true })
    expect(await store.load()).toEqual(preferences)
  })

  it('writes atomically: a sibling temp file first, then a rename onto the final path', async () => {
    const { fs, events } = fakeFs()
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    await store.save({ profile: 'balanced', default: {} })
    expect(events).toHaveLength(2)
    const [write = '', rename = ''] = events
    expect(write.startsWith(`write:${FILE}`)).toBe(true)
    expect(write).not.toBe(`write:${FILE}`)
    expect(rename.endsWith(`->${FILE}`)).toBe(true)
  })
})

/*
 * AMENDED for #534 (was: `default: { provider: 'opencode' }`, relying on
 * OpenCode being the one detected provider this build never launched). #534
 * made OpenCode launchable, so every `DWARF_PROVIDERS` member now passes the
 * launch gate and no real value reaches the refusal these cases pin. The
 * branch still exists for the next provider that is read before it can be
 * started, so it is pinned with an id this build does not know, cast for the
 * type: the gate reads `LAUNCHABLE_PROVIDERS.includes`, which is exactly what
 * an unknown id fails.
 */
const NEVER_LAUNCHED = 'nonesuch' as DwarfProvider

describe('createJevPreferenceStore — refusing a default the launch gate would reject', () => {
  it('refuses a provider this build never launches, and never touches the file', async () => {
    const { fs, events } = fakeFs()
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    const result = await store.save({
      profile: 'balanced',
      default: { provider: NEVER_LAUNCHED }
    })
    expect(result).toEqual({ saved: false, reason: 'default-provider-not-launchable' })
    expect(events).toHaveLength(0)
  })

  it('refuses an effort level that provider does not accept, and never touches the file', async () => {
    const { fs, events } = fakeFs()
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    const result = await store.save({
      profile: 'balanced',
      default: { provider: 'claude', effort: 'ultra' }
    })
    expect(result).toEqual({ saved: false, reason: 'default-tuning-invalid' })
    expect(events).toHaveLength(0)
  })

  it('refuses a model or effort with no provider to validate it against', async () => {
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs: fakeFs().fs })
    expect(await store.save({ profile: 'balanced', default: { effort: 'high' } })).toEqual({
      saved: false,
      reason: 'default-tuning-invalid'
    })
    expect(await store.save({ profile: 'balanced', default: { model: 'sonnet' } })).toEqual({
      saved: false,
      reason: 'default-tuning-invalid'
    })
  })

  it('leaves a previously saved default in place when a later save is refused', async () => {
    const { fs } = fakeFs()
    const store = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    const good = { profile: 'balanced' as const, default: { provider: 'claude' as const } }
    await store.save(good)

    await store.save({ profile: 'premium', default: { provider: NEVER_LAUNCHED } })

    const rebooted = createJevPreferenceStore({ userDataDir: USER_DATA_DIR, fs })
    expect(await rebooted.load()).toEqual(good)
  })
})

describe('createJevPreferenceStore — a corrupt or malformed file', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('treats unparseable JSON as the defaults, never blocking Settings from opening', async () => {
    const store = createJevPreferenceStore({
      userDataDir: USER_DATA_DIR,
      fs: fakeFs({ [FILE]: '{ not json' }).fs
    })
    await expect(store.load()).resolves.toEqual({ profile: 'balanced', default: {} })
  })

  it('never throws on a corrupt file', async () => {
    const store = createJevPreferenceStore({
      userDataDir: USER_DATA_DIR,
      fs: fakeFs({ [FILE]: '[]' }).fs
    })
    await expect(store.load()).resolves.not.toThrow()
  })

  it('warns by name when a corrupt document is discarded, rather than degrading silently', async () => {
    // config-layering: "the loader warns by name when it discards a file" —
    // starting on defaults quietly would look exactly like the bug that
    // rule exists to catch.
    const store = createJevPreferenceStore({
      userDataDir: USER_DATA_DIR,
      fs: fakeFs({ [FILE]: '{ not json' }).fs
    })
    await store.load()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[jev]'), expect.anything())
  })
})
