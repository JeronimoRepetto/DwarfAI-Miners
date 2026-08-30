import { describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig } from './config'
import {
  CONFIG_FILE_NAME,
  createConfigFileStore,
  parseConfigFileEntries,
  serializeConfigFileEntries,
  withConfigFileFallback,
  type ConfigFileFsLike
} from './configFile'

/**
 * In-memory fs fake with real rename semantics (source must exist, target is
 * replaced), plus an event log so the atomic-write ordering can be asserted:
 * the final path must only ever appear as a rename target, never as a direct
 * write target. Mirrors the fake in pinPreference.test.ts on purpose — these
 * stores share one storage pattern, so they should share one test shape.
 */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: string[] = []
  const fs: ConfigFileFsLike = {
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

const FILE = `C:/fake/userData/${CONFIG_FILE_NAME}`

describe('parseConfigFileEntries', () => {
  it('reads string values as-is', () => {
    const parsed = parseConfigFileEntries('{"CLAUDE_CONFIG_DIRS":"~/.claude;~/.claude-work"}')
    expect(parsed.entries).toEqual({ CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work' })
    expect(parsed.ignoredKeys).toEqual([])
  })

  it('accepts JSON numbers, because a hand-editor writes 200 and not "200"', () => {
    const parsed = parseConfigFileEntries('{"TIER_COPPER_KB":200,"POLL_INTERVAL_MS":5000}')
    expect(parsed.entries).toEqual({ TIER_COPPER_KB: '200', POLL_INTERVAL_MS: '5000' })
  })

  it('yields no entries when the file is corrupt', () => {
    expect(parseConfigFileEntries('{"POLL_INTERVAL_MS":').entries).toEqual({})
    expect(parseConfigFileEntries('').entries).toEqual({})
    expect(parseConfigFileEntries('not json at all').entries).toEqual({})
  })

  it('yields no entries when the document is not an object', () => {
    expect(parseConfigFileEntries('[]').entries).toEqual({})
    expect(parseConfigFileEntries('null').entries).toEqual({})
    expect(parseConfigFileEntries('"POLL_INTERVAL_MS=5000"').entries).toEqual({})
    expect(parseConfigFileEntries('42').entries).toEqual({})
  })

  it('reports keys whose value shape no config parser could consume', () => {
    const parsed = parseConfigFileEntries(
      '{"POLL_INTERVAL_MS":5000,"CLAUDE_CONFIG_DIRS":["a","b"],"HOOKS_PORT":null,"X":{},"Y":true}'
    )
    // The usable entry survives; only the unusable shapes drop out, and every
    // dropped key is named so the user can be told which line to fix.
    expect(parsed.entries).toEqual({ POLL_INTERVAL_MS: '5000' })
    expect(parsed.ignoredKeys).toEqual(['CLAUDE_CONFIG_DIRS', 'HOOKS_PORT', 'X', 'Y'])
  })

  it('round-trips through serializeConfigFileEntries', () => {
    const entries = { CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work', TIER_COPPER_KB: '200' }
    expect(parseConfigFileEntries(serializeConfigFileEntries(entries)).entries).toEqual(entries)
  })
})

describe('serializeConfigFileEntries', () => {
  it('writes an indented, newline-terminated document, because a human edits this file', () => {
    const raw = serializeConfigFileEntries({ TIER_COPPER_KB: '200' })
    expect(raw).toBe('{\n  "TIER_COPPER_KB": "200"\n}\n')
  })
})

describe('withConfigFileFallback', () => {
  it('applies a file entry the environment does not set', () => {
    const layered = withConfigFileFallback({}, { POLL_INTERVAL_MS: '5000' })
    expect(loadConfig(layered).pollIntervalMs).toBe(5000)
  })

  it('lets a real environment variable win over the file', () => {
    const layered = withConfigFileFallback(
      { POLL_INTERVAL_MS: '250' },
      { POLL_INTERVAL_MS: '5000' }
    )
    expect(loadConfig(layered).pollIntervalMs).toBe(250)
  })

  it('does not let a blank environment variable mask the file value', () => {
    // Blank means "unset" at every layer (loadConfig already treats it that
    // way), so an empty var must fall through to the file, not past it.
    const layered = withConfigFileFallback(
      { POLL_INTERVAL_MS: '   ' },
      { POLL_INTERVAL_MS: '5000' }
    )
    expect(loadConfig(layered).pollIntervalMs).toBe(5000)
  })

  it('falls through to defaultConfig() when neither layer sets a key', () => {
    expect(loadConfig(withConfigFileFallback({}, {}))).toEqual(defaultConfig())
  })

  it('resolves all three layers at once, most specific first', () => {
    const config = loadConfig(
      withConfigFileFallback(
        { POLL_INTERVAL_MS: '250' },
        { POLL_INTERVAL_MS: '5000', CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work' }
      )
    )
    expect(config.pollIntervalMs).toBe(250) // environment
    expect(config.claudeConfigDirs).toEqual(['~/.claude', '~/.claude-work']) // file
    expect(config.hooksPort).toBe(defaultConfig().hooksPort) // default
  })

  it('still resolves keys the file never mentions', () => {
    const layered = withConfigFileFallback({ HOOKS_PORT: '51000' }, { POLL_INTERVAL_MS: '5000' })
    expect(loadConfig(layered).hooksPort).toBe(51000)
  })

  it('fails fast on an invalid file value, with the message loadConfig already produces', () => {
    const layered = withConfigFileFallback({}, { HOOKS_PORT: '70000' })
    expect(() => loadConfig(layered)).toThrowError(/HOOKS_PORT/)
  })

  it('lets the environment rescue a value the file gets wrong', () => {
    // The escape hatch when a hand-edited file blocks startup: an env var
    // overrides it without the user having to find and repair the file first.
    const layered = withConfigFileFallback({ HOOKS_PORT: '51000' }, { HOOKS_PORT: '70000' })
    expect(loadConfig(layered).hooksPort).toBe(51000)
  })

  it('changes nothing for a checkout whose .env dotenv already loaded', () => {
    // The promise #38 makes to existing users: with no config file present,
    // layering must be indistinguishable from calling loadConfig(env) direct.
    const env = {
      POLL_INTERVAL_MS: '250',
      CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work',
      HOOKS_PORT: '51000',
      PATH: '/usr/bin' // an unrelated variable, as a real environment has
    }
    expect(loadConfig(withConfigFileFallback(env, {}))).toEqual(loadConfig(env))
  })

  it('leaves the caller-supplied environment untouched', () => {
    const env = { POLL_INTERVAL_MS: '250' }
    withConfigFileFallback(env, { CLAUDE_CONFIG_DIRS: '~/.claude-work' })
    expect(env).toEqual({ POLL_INTERVAL_MS: '250' })
  })
})

describe('createConfigFileStore', () => {
  it('yields no entries when the app has never written a config file', async () => {
    const { fs } = fakeFs()
    const store = createConfigFileStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toEqual({})
  })

  it('round-trips settings across a "restart" (a fresh store on the same file)', async () => {
    const { fs } = fakeFs()
    await createConfigFileStore({ filePath: FILE, fs }).save({
      CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work'
    })
    const rebooted = createConfigFileStore({ filePath: FILE, fs })
    await expect(rebooted.load()).resolves.toEqual({
      CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude-work'
    })
  })

  it('falls back to no entries when the stored file is corrupt, instead of blocking startup', async () => {
    const { fs } = fakeFs({ [FILE]: '{"POLL_INTERVAL_MS":' })
    const store = createConfigFileStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toEqual({})
  })

  it('treats any read failure as "no config file" instead of blocking startup', async () => {
    const fs: ConfigFileFsLike = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeFile: async () => undefined,
      rename: async () => undefined
    }
    const store = createConfigFileStore({ filePath: FILE, fs })
    await expect(store.load()).resolves.toEqual({})
  })

  it('warns, naming the file and the keys, when it drops unusable entries', async () => {
    const { fs } = fakeFs({ [FILE]: '{"CLAUDE_CONFIG_DIRS":["a"],"POLL_INTERVAL_MS":5000}' })
    const warnings: string[] = []
    const store = createConfigFileStore({ filePath: FILE, fs, onWarn: (m) => warnings.push(m) })
    await expect(store.load()).resolves.toEqual({ POLL_INTERVAL_MS: '5000' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(FILE)
    expect(warnings[0]).toContain('CLAUDE_CONFIG_DIRS')
  })

  it('warns once when the file exists but is corrupt', async () => {
    const { fs } = fakeFs({ [FILE]: 'not json at all' })
    const warnings: string[] = []
    const store = createConfigFileStore({ filePath: FILE, fs, onWarn: (m) => warnings.push(m) })
    await store.load()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(FILE)
  })

  it('stays silent when there is simply no file yet', async () => {
    const { fs } = fakeFs()
    const warnings: string[] = []
    await createConfigFileStore({ filePath: FILE, fs, onWarn: (m) => warnings.push(m) }).load()
    expect(warnings).toEqual([])
  })

  it('writes atomically: a sibling temp file first, then a rename onto the final path', async () => {
    const { fs, events } = fakeFs()
    await createConfigFileStore({ filePath: FILE, fs }).save({ POLL_INTERVAL_MS: '5000' })
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

  it('replaces the whole document on save', async () => {
    const { fs } = fakeFs()
    const store = createConfigFileStore({ filePath: FILE, fs })
    await store.save({ POLL_INTERVAL_MS: '5000' })
    await store.save({ HOOKS_PORT: '51000' })
    await expect(store.load()).resolves.toEqual({ HOOKS_PORT: '51000' })
  })

  it('refuses to persist entries that would fail the next startup', async () => {
    const { fs, files } = fakeFs()
    const store = createConfigFileStore({ filePath: FILE, fs })
    await store.save({ POLL_INTERVAL_MS: '5000' })
    await expect(store.save({ HOOKS_PORT: '70000' })).rejects.toThrow(/HOOKS_PORT/)
    // The previous good document must survive a rejected save untouched.
    expect(files.get(FILE)).toBe(serializeConfigFileEntries({ POLL_INTERVAL_MS: '5000' }))
  })

  it('refuses entries that are only invalid in combination', async () => {
    const { fs } = fakeFs()
    const store = createConfigFileStore({ filePath: FILE, fs })
    // Tier thresholds must stay strictly increasing; copper above silver is
    // rejected even though each value is a fine positive integer on its own.
    await expect(store.save({ TIER_COPPER_KB: '5000' })).rejects.toThrow(/threshold/i)
  })
})
