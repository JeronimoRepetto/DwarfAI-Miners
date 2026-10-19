import { describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig } from './config'
import {
  parseConfigFileEntries,
  serializeConfigFileEntries,
  withConfigFileFallback
} from './configFile'

// REMOVED in ISSUE-010: the fakeFs helper, the FILE path and the createConfigFileStore suite stay
// in the legacy file. Reading and writing the file is the I/O half the issue sends to ISSUE-211;
// only the pure text-to-settings half lives in contracts.

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
  })

  /*
   * #555, and the worst of that issue's three call sites. A bad SHAPE degrades
   * to no entries here by design (`config-layering`), which means a BOM — the
   * invisible EF BB BF a Windows editor writes — made the app ignore the whole
   * configuration file in silence. On the ONE document whose own comment says
   * it is "meant to be opened and edited by hand", so the likeliest file on
   * the machine to be saved by an editor that adds one.
   */
  it('reads a file a Windows editor saved with a BOM, rather than ignoring all of it', () => {
    const parsed = parseConfigFileEntries('\uFEFF{"CLAUDE_CONFIG_DIRS":"~/.claude;~/.claude2"}')
    expect(parsed.entries).toEqual({ CLAUDE_CONFIG_DIRS: '~/.claude;~/.claude2' })
  })

  it('still degrades to no entries for a file that is genuinely corrupt', () => {
    // Tolerating an encoding mark must not become tolerating corruption.
    expect(parseConfigFileEntries('\uFEFFnot json at all').entries).toEqual({})
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
    expect(config.providers.claude.configDirs).toEqual(['~/.claude', '~/.claude-work']) // file
    expect(config.hooksPort).toBe(defaultConfig().hooksPort) // default
  })

  /*
   * Issue #444. OPENCODE_STORE_ROOT is reachable through the userData config
   * file exactly like every other provider setting (config-layering) — not
   * only from a repo .env, which is what #38 exists to prevent recurring.
   */
  it('applies OPENCODE_STORE_ROOT from the file when the environment does not set it', () => {
    const layered = withConfigFileFallback({}, { OPENCODE_STORE_ROOT: '~/custom/opencode' })
    expect(loadConfig(layered).providers.opencode.storeRoot).toBe('~/custom/opencode')
  })

  it('lets a real OPENCODE_STORE_ROOT environment variable win over the file', () => {
    const layered = withConfigFileFallback(
      { OPENCODE_STORE_ROOT: '~/from-env/opencode' },
      { OPENCODE_STORE_ROOT: '~/from-file/opencode' }
    )
    expect(loadConfig(layered).providers.opencode.storeRoot).toBe('~/from-env/opencode')
  })

  /*
   * DET-R1 ("All three layers are present"): the blank-over-file fall-through
   * above (line ~109) is only pinned generically, through POLL_INTERVAL_MS —
   * this repeats it against OPENCODE_STORE_ROOT's own key, so the clause is
   * exercised for this provider's setting and not only inferred from a
   * different one.
   */
  it('does not let a blank OPENCODE_STORE_ROOT mask the file value', () => {
    const layered = withConfigFileFallback(
      { OPENCODE_STORE_ROOT: '   ' },
      { OPENCODE_STORE_ROOT: '~/from-file/opencode' }
    )
    expect(loadConfig(layered).providers.opencode.storeRoot).toBe('~/from-file/opencode')
  })

  /*
   * ADDED for #635. The guild areas flag reaches an installed app through the
   * userData file, not only a repo .env (config-layering), and the
   * environment still wins over it.
   */
  it('applies GUILD_AREAS_ENABLED from the file, and lets the environment win', () => {
    expect(
      loadConfig(withConfigFileFallback({}, { GUILD_AREAS_ENABLED: 'true' })).guildAreasEnabled
    ).toBe(true)
    expect(
      loadConfig(withConfigFileFallback({ GUILD_AREAS_ENABLED: '0' }, { GUILD_AREAS_ENABLED: '1' }))
        .guildAreasEnabled
    ).toBe(false)
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
