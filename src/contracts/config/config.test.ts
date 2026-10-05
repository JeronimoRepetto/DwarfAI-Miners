import { afterEach, describe, expect, it, vi } from 'vitest'
// AMENDED for ISSUE-010 (was: DWARF_PROVIDERS and TIER_WEIGHT_THRESHOLDS_KB from the legacy domain barrel).
// Provider ids come from the catalog, an open list (ADR-009 D2); tier thresholds are the mines domain's
// `TierThresholds` (06 §0.2, ISSUE-062), so they are not part of this parser.
import { CATALOG_PROVIDER_IDS } from '../catalog'
import {
  FEATURE_FLAG_KEYS,
  SIMULATION_ENV_VAR,
  cliOverridesFrom,
  defaultConfig,
  defaultSimulationConfig,
  loadConfig,
  loadSimulationConfig,
  readSwitchText
} from './config'

describe('defaultConfig', () => {
  it('returns the documented defaults', () => {
    expect(defaultConfig()).toEqual({
      pollIntervalMs: 2000,
      livenessWindowS: 90,
      dwarfLeaveGraceS: 20,
      tierCacheTtlS: 600,
      // AMENDED for ISSUE-065 (was: no measurement delay). A new mine is measured automatically
      // shortly after it is created (06 INV-04, 07 S3.08).
      mineMeasureDelayMs: 5000,
      // AMENDED for ISSUE-010 (was: tierThresholds). Tier thresholds are mines configuration
      // (06 §0.2 `TierThresholds`, defaults and validated overrides built by ISSUE-062).
      sendTextRelayModel: 'haiku',
      sendTextTimeoutS: 60,
      hooksPort: 47821,
      // AMENDED for #635 (was: no guild flag). The guild areas ship hidden.
      guildAreasEnabled: false,
      providers: {
        claude: {
          cliPath: '',
          configDirs: ['~/.claude']
        },
        codex: {
          cliPath: '',
          sessionsRoot: '~/.codex/sessions',
          stateDb: '~/.codex/state_5.sqlite',
          logsDb: '~/.codex/logs_2.sqlite',
          livenessWindowS: 300,
          heartbeatWindowS: 300,
          scanDays: 7,
          idleRetentionS: 3600
        },
        // AMENDED for #237 (was: no antigravity block). Its windows are about
        // a presence LOCK rather than a file's age — see AntigravityConfig.
        antigravity: {
          cliPath: '',
          storeRoot: '~/.gemini/antigravity-cli',
          busyWindowS: 120,
          lockGraceS: 30,
          staleLockWindowS: 86_400
        },
        // AMENDED for #444 (was: no opencode block). One setting: the store
        // root is OS-invariant, so there is no window and no per-OS branch.
        opencode: {
          cliPath: '',
          storeRoot: '~/.local/share/opencode'
        },
        // AMENDED for ISSUE-009/ISSUE-010 (was: no simulated block). The catalog gained the
        // simulated provider (15 §4.12); it has no CLI, so its block is the shared sub-shape alone.
        simulated: {
          cliPath: ''
        }
      }
    })
  })

  it('returns a fresh object on every call', () => {
    expect(defaultConfig()).not.toBe(defaultConfig())
    // AMENDED for ISSUE-010: the tierThresholds identity check left with the field (06 §0.2, ISSUE-062).
    expect(defaultConfig().providers).not.toBe(defaultConfig().providers)
    expect(defaultConfig().providers.claude.configDirs).not.toBe(
      defaultConfig().providers.claude.configDirs
    )
  })

  // REMOVED in ISSUE-010: 'draws its tier boundaries from the one shared constant, not a
  // duplicated literal' stays in the legacy file; the thresholds belong to the mines domain
  // (06 §0.2 `TierThresholds`, ISSUE-062).
})

/*
 * Issue #78. Provider settings used to be flat top-level keys, so a backend
 * cost N more AppConfig fields and N more parse calls scattered through one
 * flat literal. They are one block per provider now, keyed by the shared
 * provider table — which is what makes the block MANDATORY rather than
 * remembered: `ProviderConfigs` is a Record over DwarfProvider, so a member
 * added to DWARF_PROVIDERS stops compiling until its block exists.
 *
 * AMENDED for ISSUE-010: a provider id is an open string (ADR-009 D2), so the
 * compile-time guarantee is gone; the loop below over CATALOG_PROVIDER_IDS and
 * the catalog-key test after it hold the same promise at run time.
 *
 * The documented variable names did not change and must not: they are the
 * user contract, in the README table and in .env.example. Only the shape
 * behind them moved.
 */
describe('per-provider settings blocks', () => {
  it('carries one block for every provider identity, with the settings they share', () => {
    const config = defaultConfig()
    for (const provider of CATALOG_PROVIDER_IDS) {
      expect(config.providers[provider]).toBeDefined()
      // The shared sub-shape, which is what a new provider gets for free: the
      // platform composition honours a CLI override without knowing the name.
      expect(config.providers[provider]?.cliPath).toBe('')
    }
  })

  it('[ADR-009] keys every provider block by a catalog provider id', () => {
    // The other half of the open catalog: a block the catalog does not list is a
    // provider the app does not have, so it must not be configurable here.
    expect(Object.keys(defaultConfig().providers).sort()).toEqual([...CATALOG_PROVIDER_IDS].sort())
  })

  it('reads each block from the documented variable names, unchanged', () => {
    const config = loadConfig({
      CLAUDE_CONFIG_DIRS: '~/.claude-work',
      CLAUDE_CLI_PATH: '/opt/claude/bin/claude',
      CODEX_SESSIONS_ROOT: '~/custom/sessions',
      CODEX_STATE_DB: '~/.codex-alt/state_5.sqlite',
      CODEX_LOGS_DB: 'D:\\codex\\logs_2.sqlite',
      CODEX_LIVENESS_WINDOW_S: '900',
      CODEX_HEARTBEAT_WINDOW_S: '45',
      CODEX_SCAN_DAYS: '3',
      CODEX_IDLE_RETENTION_S: '1800',
      CODEX_CLI_PATH: '/opt/codex/codex'
    })
    expect(config.providers.claude).toEqual({
      cliPath: '/opt/claude/bin/claude',
      configDirs: ['~/.claude-work']
    })
    expect(config.providers.codex).toEqual({
      cliPath: '/opt/codex/codex',
      sessionsRoot: '~/custom/sessions',
      stateDb: '~/.codex-alt/state_5.sqlite',
      logsDb: 'D:\\codex\\logs_2.sqlite',
      livenessWindowS: 900,
      heartbeatWindowS: 45,
      scanDays: 3,
      idleRetentionS: 1800
    })
  })

  it('hands the platform every non-blank CLI override without naming a provider', () => {
    // The shared sub-shape's first payoff. The platform composition used to
    // spread one hand-written entry per backend, so a third provider's
    // CLI_PATH would have been parsed into config and then dropped on the way
    // to detection. Blank still means "detect it", so it must not appear.
    expect(cliOverridesFrom(loadConfig({ CODEX_CLI_PATH: '/opt/codex/codex' }))).toEqual({
      codex: '/opt/codex/codex'
    })
    expect(cliOverridesFrom(defaultConfig())).toEqual({})
  })

  it('leaves one provider on its defaults when only the other is configured', () => {
    // A block is read per provider, so a setting for one cannot reach or
    // disturb the other's — the property that stops the next backend needing
    // to know what the previous ones parse.
    const config = loadConfig({ CODEX_SCAN_DAYS: '3' })
    expect(config.providers.codex.scanDays).toBe(3)
    expect(config.providers.claude).toEqual(defaultConfig().providers.claude)
  })

  /*
   * Issue #237. The third block, and the first one whose windows are about a
   * LOCK rather than about a file's age: the Antigravity CLI writes a presence
   * lock per running conversation, which is stronger evidence than a mtime and
   * still not a contract — so the grace window covers a lock that vanishes for
   * a moment, and the stale window bounds one a crash left behind.
   */
  it('reads the Antigravity block from its own documented variable names', () => {
    const config = loadConfig({
      ANTIGRAVITY_STORE_ROOT: '~/custom/antigravity-cli',
      ANTIGRAVITY_BUSY_WINDOW_S: '90',
      ANTIGRAVITY_LOCK_GRACE_S: '45',
      ANTIGRAVITY_STALE_LOCK_WINDOW_S: '7200',
      ANTIGRAVITY_CLI_PATH: '/opt/agy/agy'
    })

    expect(config.providers.antigravity).toEqual({
      cliPath: '/opt/agy/agy',
      storeRoot: '~/custom/antigravity-cli',
      busyWindowS: 90,
      lockGraceS: 45,
      staleLockWindowS: 7200
    })
  })

  it('defaults the Antigravity store to where the CLI keeps it', () => {
    expect(defaultConfig().providers.antigravity.storeRoot).toBe('~/.gemini/antigravity-cli')
  })

  it('fails fast on an Antigravity window that is not a positive integer', () => {
    expect(() => loadConfig({ ANTIGRAVITY_LOCK_GRACE_S: '0' })).toThrow(/ANTIGRAVITY_LOCK_GRACE_S/)
  })

  /*
   * Issue #444. The fourth block, and the plainest: one setting, no window —
   * OpenCode's store is a database this provider reads and nothing else.
   */
  it('reads the OpenCode block from its own documented variable names', () => {
    const config = loadConfig({
      OPENCODE_STORE_ROOT: '~/custom/opencode',
      OPENCODE_CLI_PATH: '/opt/opencode/opencode'
    })
    expect(config.providers.opencode).toEqual({
      cliPath: '/opt/opencode/opencode',
      storeRoot: '~/custom/opencode'
    })
  })

  it('falls through to the default when OPENCODE_STORE_ROOT is blank rather than past it', () => {
    expect(loadConfig({ OPENCODE_STORE_ROOT: '   ' }).providers.opencode.storeRoot).toBe(
      '~/.local/share/opencode'
    )
  })

  /*
   * D6 / the detection spec's own requirement: the default's SHAPE never
   * branches on the host OS. There is no Platform parameter anywhere in
   * readOpenCodeConfig or defaultConfig to vary in the first place, so the
   * same fixed string is what every host reads, and process.platform is
   * never consulted to build it.
   */
  it('defaults the OpenCode store to the same OS-invariant path, whatever the host', () => {
    expect(defaultConfig().providers.opencode.storeRoot).toBe('~/.local/share/opencode')
    expect(loadConfig({}).providers.opencode.storeRoot).toBe('~/.local/share/opencode')
  })
})

describe('loadConfig', () => {
  it('returns defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual(defaultConfig())
  })

  it('treats empty or blank values as unset', () => {
    expect(loadConfig({ POLL_INTERVAL_MS: '', LIVENESS_WINDOW_S: '   ' })).toEqual(defaultConfig())
  })

  it('parses valid integer values', () => {
    const config = loadConfig({
      POLL_INTERVAL_MS: '5000',
      LIVENESS_WINDOW_S: '120',
      CODEX_LIVENESS_WINDOW_S: '900',
      TIER_CACHE_TTL_S: '60',
      CODEX_SCAN_DAYS: '3',
      CODEX_IDLE_RETENTION_S: '1800',
      DWARF_LEAVE_GRACE_S: '45'
    })
    expect(config.pollIntervalMs).toBe(5000)
    expect(config.livenessWindowS).toBe(120)
    expect(config.providers.codex.livenessWindowS).toBe(900)
    expect(config.tierCacheTtlS).toBe(60)
    expect(config.providers.codex.scanDays).toBe(3)
    expect(config.providers.codex.idleRetentionS).toBe(1800)
    expect(config.dwarfLeaveGraceS).toBe(45)
  })

  it('parses CODEX_SESSIONS_ROOT, keeping the leading ~ unexpanded', () => {
    expect(
      loadConfig({ CODEX_SESSIONS_ROOT: '~/custom/sessions' }).providers.codex.sessionsRoot
    ).toBe('~/custom/sessions')
  })

  it('falls back to the default sessions root when CODEX_SESSIONS_ROOT is blank', () => {
    expect(() => loadConfig({ CODEX_SESSIONS_ROOT: '   ' })).not.toThrow()
    expect(loadConfig({ CODEX_SESSIONS_ROOT: '   ' }).providers.codex.sessionsRoot).toBe(
      '~/.codex/sessions'
    )
  })

  // REMOVED in ISSUE-010: 'parses tier thresholds per key' and 'fails fast when tier thresholds
  // are not strictly increasing' stay in the legacy file; the thresholds belong to the mines
  // domain (06 §0.2 `TierThresholds`, ISSUE-062).

  it('applies defaults per key independently', () => {
    expect(loadConfig({ POLL_INTERVAL_MS: '250' }).pollIntervalMs).toBe(250)
    expect(loadConfig({ POLL_INTERVAL_MS: '250' }).livenessWindowS).toBe(90)
  })

  it('parses CLAUDE_CONFIG_DIRS as a semicolon-separated list', () => {
    const config = loadConfig({ CLAUDE_CONFIG_DIRS: 'C:\\a ; C:\\b;;~/.claude ' })
    expect(config.providers.claude.configDirs).toEqual(['C:\\a', 'C:\\b', '~/.claude'])
  })

  it('fails fast when CLAUDE_CONFIG_DIRS has no usable entries', () => {
    expect(() => loadConfig({ CLAUDE_CONFIG_DIRS: ' ; ; ' })).toThrowError(/CLAUDE_CONFIG_DIRS/)
  })

  it('parses the Codex registry database paths, keeping a leading ~ unexpanded', () => {
    const config = loadConfig({
      CODEX_STATE_DB: '~/.codex-alt/state_5.sqlite',
      CODEX_LOGS_DB: 'D:\\codex\\logs_2.sqlite',
      CODEX_HEARTBEAT_WINDOW_S: '45'
    })
    expect(config.providers.codex.stateDb).toBe('~/.codex-alt/state_5.sqlite')
    expect(config.providers.codex.logsDb).toBe('D:\\codex\\logs_2.sqlite')
    expect(config.providers.codex.heartbeatWindowS).toBe(45)
  })

  it('falls back to the default registry paths when the vars are blank', () => {
    const config = loadConfig({ CODEX_STATE_DB: '  ', CODEX_LOGS_DB: '' })
    expect(config.providers.codex.stateDb).toBe('~/.codex/state_5.sqlite')
    expect(config.providers.codex.logsDb).toBe('~/.codex/logs_2.sqlite')
  })

  it('fails fast on a non-integer CODEX_HEARTBEAT_WINDOW_S', () => {
    expect(() => loadConfig({ CODEX_HEARTBEAT_WINDOW_S: '0' })).toThrowError(
      /CODEX_HEARTBEAT_WINDOW_S/
    )
  })

  it('fails fast on a non-numeric value', () => {
    expect(() => loadConfig({ POLL_INTERVAL_MS: 'abc' })).toThrowError(/POLL_INTERVAL_MS/)
  })

  it('fails fast on zero', () => {
    expect(() => loadConfig({ POLL_INTERVAL_MS: '0' })).toThrowError(/POLL_INTERVAL_MS/)
  })

  it('fails fast on negative values', () => {
    expect(() => loadConfig({ LIVENESS_WINDOW_S: '-5' })).toThrowError(/LIVENESS_WINDOW_S/)
  })

  it('fails fast on non-integer values', () => {
    expect(() => loadConfig({ LIVENESS_WINDOW_S: '90.5' })).toThrowError(/LIVENESS_WINDOW_S/)
  })

  // ADDED for ISSUE-065: the delay of the automatic scoring walk of a new mine (07 S3.08).
  describe('automatic measurement delay', () => {
    it('reads MINE_MEASURE_DELAY_MS, where 0 means at once', () => {
      expect(loadConfig({ MINE_MEASURE_DELAY_MS: '12000' }).mineMeasureDelayMs).toBe(12000)
      expect(loadConfig({ MINE_MEASURE_DELAY_MS: '0' }).mineMeasureDelayMs).toBe(0)
      expect(loadConfig({ MINE_MEASURE_DELAY_MS: '  ' }).mineMeasureDelayMs).toBe(5000)
    })

    it.each(['-1', '2.5', 'abc', '600001'])('fails fast on the unusable delay %j', (value) => {
      expect(() => loadConfig({ MINE_MEASURE_DELAY_MS: value })).toThrowError(
        /MINE_MEASURE_DELAY_MS/
      )
    })
  })

  describe('send-text delivery', () => {
    it('overrides the relay model and the delivery timeout', () => {
      const config = loadConfig({ SENDTEXT_RELAY_MODEL: 'sonnet', SENDTEXT_TIMEOUT_S: '30' })
      expect(config.sendTextRelayModel).toBe('sonnet')
      expect(config.sendTextTimeoutS).toBe(30)
    })

    it('trims a padded model name', () => {
      expect(loadConfig({ SENDTEXT_RELAY_MODEL: '  opus  ' }).sendTextRelayModel).toBe('opus')
    })

    it('fails fast on an unusable timeout', () => {
      expect(() => loadConfig({ SENDTEXT_TIMEOUT_S: '0' })).toThrowError(/SENDTEXT_TIMEOUT_S/)
    })
  })

  describe('hook listener port', () => {
    it('overrides the loopback port the hook relay posts to', () => {
      expect(loadConfig({ HOOKS_PORT: '51000' }).hooksPort).toBe(51000)
    })

    it('falls back to the default when blank', () => {
      expect(loadConfig({ HOOKS_PORT: '  ' }).hooksPort).toBe(47821)
    })

    it.each(['0', '-1', '70000', '4782.5', 'abc'])(
      'fails fast on the unusable port %s',
      (value) => {
        expect(() => loadConfig({ HOOKS_PORT: value })).toThrowError(/HOOKS_PORT/)
      }
    )
  })

  /*
   * ADDED for #635. The guild areas ship designed in full and hidden: a flag
   * in the three layers, off by default and never a Settings row. A value
   * that is not a considered yes or no stops startup naming the key, as every
   * other bad value does — a switch left silently off would look exactly like
   * the flag not working.
   */
  describe('guild areas flag', () => {
    it('is off by default', () => {
      expect(loadConfig({}).guildAreasEnabled).toBe(false)
      expect(defaultConfig().guildAreasEnabled).toBe(false)
    })

    it.each([
      ['true', true],
      ['1', true],
      [' TRUE ', true],
      ['false', false],
      ['0', false]
    ])('reads %j as %s', (raw, expected) => {
      expect(loadConfig({ GUILD_AREAS_ENABLED: raw }).guildAreasEnabled).toBe(expected)
    })

    it('falls back to the default when blank', () => {
      expect(loadConfig({ GUILD_AREAS_ENABLED: '  ' }).guildAreasEnabled).toBe(false)
    })

    it.each(['yes', 'on', '2', 'enabled'])('fails fast on the unusable value %j', (value) => {
      expect(() => loadConfig({ GUILD_AREAS_ENABLED: value })).toThrowError(/GUILD_AREAS_ENABLED/)
    })
  })

  describe('CLI detection overrides', () => {
    it('reads and trims explicit claude and codex binary paths (#91)', () => {
      const config = loadConfig({
        CLAUDE_CLI_PATH: '  /opt/claude/bin/claude  ',
        CODEX_CLI_PATH: '/opt/codex/codex'
      })
      expect(config.providers.claude.cliPath).toBe('/opt/claude/bin/claude')
      expect(config.providers.codex.cliPath).toBe('/opt/codex/codex')
    })

    it('leaves the overrides blank when unset, meaning "detect it"', () => {
      const config = loadConfig({})
      expect(config.providers.claude.cliPath).toBe('')
      expect(config.providers.codex.cliPath).toBe('')
    })
  })
})

describe('loadSimulationConfig', () => {
  const ON = { [SIMULATION_ENV_VAR]: '1' }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('never leaks into AppConfig, so the userData config file cannot carry it', () => {
    // #38 landed a real config path a PACKAGED app reads. Simulation therefore
    // deliberately does not live on AppConfig at all: loadConfig is the only
    // thing withConfigFileFallback feeds, and it must stay unable to switch a
    // demo on. This assertion is the tripwire for that.
    expect(loadConfig({ ...ON, DWARFAI_SIMULATE_MINES: '30' })).toEqual(defaultConfig())
    expect('simulation' in loadConfig(ON)).toBe(false)
  })

  it('is off for an empty environment', () => {
    expect(loadSimulationConfig({})).toBeNull()
  })

  it.each(['1', 'true', 'TRUE', ' true '])('is on for the affirmative value %j', (value) => {
    expect(loadSimulationConfig({ [SIMULATION_ENV_VAR]: value })).not.toBeNull()
  })

  it.each(['0', 'false', 'off', 'no', 'yes', '', '   '])('stays off for the value %j', (value) => {
    expect(loadSimulationConfig({ [SIMULATION_ENV_VAR]: value })).toBeNull()
  })

  it('returns the documented defaults when switched on with nothing else set', () => {
    expect(loadSimulationConfig(ON)).toEqual(defaultSimulationConfig())
  })

  it('crowds the valley by default: more mines than sites, more crew than anchors', () => {
    const defaults = defaultSimulationConfig()
    // 13 authored map sites (#20) and 4 veins in the cave (#19).
    expect(defaults.mines).toBeGreaterThan(13)
    expect(defaults.maxCrew).toBeGreaterThan(4)
  })

  it('parses every tuning key', () => {
    expect(
      loadSimulationConfig({
        ...ON,
        DWARFAI_SIMULATE_SEED: 'repro-42',
        DWARFAI_SIMULATE_MINES: '30',
        DWARFAI_SIMULATE_CREW: '9',
        DWARFAI_SIMULATE_TIERS: 'gold, uranium',
        DWARFAI_SIMULATE_STEP_MS: '1500',
        DWARFAI_SIMULATE_ANIMATE: 'false',
        DWARFAI_SIMULATE_TOKENS: '1234'
      })
    ).toEqual({
      seed: 'repro-42',
      mines: 30,
      maxCrew: 9,
      tiers: ['gold', 'uranium'],
      stepMs: 1500,
      animate: false,
      tokensPerStep: 1234
    })
  })

  it('ignores tuning keys when the master switch is off', () => {
    expect(loadSimulationConfig({ DWARFAI_SIMULATE_MINES: '30' })).toBeNull()
  })

  it.each(['0', '-1', 'abc', '2.5'])('fails fast on the unusable mine count %j', (value) => {
    expect(() => loadSimulationConfig({ ...ON, DWARFAI_SIMULATE_MINES: value })).toThrowError(
      /DWARFAI_SIMULATE_MINES/
    )
  })

  it('refuses a mine count that would freeze the panel instead of demonstrating it', () => {
    expect(() => loadSimulationConfig({ ...ON, DWARFAI_SIMULATE_MINES: '100000' })).toThrowError(
      /DWARFAI_SIMULATE_MINES/
    )
  })

  it('refuses a crew size past its cap', () => {
    expect(() => loadSimulationConfig({ ...ON, DWARFAI_SIMULATE_CREW: '5000' })).toThrowError(
      /DWARFAI_SIMULATE_CREW/
    )
  })

  it.each(['platinum', 'gold,rubbish', ','])('fails fast on the tier spread %j', (value) => {
    expect(() => loadSimulationConfig({ ...ON, DWARFAI_SIMULATE_TIERS: value })).toThrowError(
      /DWARFAI_SIMULATE_TIERS/
    )
  })

  it('treats a blank tier spread as unset, like every other setting in this file', () => {
    expect(loadSimulationConfig({ ...ON, DWARFAI_SIMULATE_TIERS: '  ' })?.tiers).toEqual(
      defaultSimulationConfig().tiers
    )
  })

  it('refuses a step so short the panel would never finish a poll', () => {
    expect(() => loadSimulationConfig({ ...ON, DWARFAI_SIMULATE_STEP_MS: '1' })).toThrowError(
      /DWARFAI_SIMULATE_STEP_MS/
    )
  })

  it('accepts a zero token rate, which is a valley that mines nothing', () => {
    expect(loadSimulationConfig({ ...ON, DWARFAI_SIMULATE_TOKENS: '0' })?.tokensPerStep).toBe(0)
  })

  // REMOVED in ISSUE-010: 'reads process.env when no environment is passed' stays in the legacy
  // file. Reading the environment is the I/O half the issue sends to ISSUE-211; here the
  // environment is always passed in.
})

/*
 * REMOVED in ISSUE-010: DARWIN_CONSOLE_INPUT_ENV_VAR, darwinConsoleInputOverride,
 * LINUX_CONSOLE_INPUT_ENV_VAR and linuxConsoleInputOverride, and their two
 * suites, stay in the legacy test file. They gate typing into a terminal
 * (Terminal.app, tmux), and the new architecture runs agents over structured
 * protocols, never as TUIs (OQ-01,
 * ADR-031, ADR-002 D1), so they have no destination here; they are retired
 * with the legacy runtime (cut 5).
 */

/*
 * ADDED for ISSUE-211. The Host's FeatureFlagReader reads the same switch text
 * as UI main, but an invalid value there becomes the default and is logged
 * (16 §4.12, INV-110) instead of stopping startup, so the reading is exported
 * without the throw: the caller decides what an invalid value costs.
 */
describe('readSwitchText', () => {
  it.each([
    ['true', true],
    ['1', true],
    [' TRUE ', true],
    ['false', false],
    ['0', false],
    [' False', false]
  ])('[INV-110] reads %j as %s', (raw, expected) => {
    expect(readSwitchText(raw)).toBe(expected)
  })

  it.each([undefined, '', '   '])('[INV-110] reads %j as unset', (raw) => {
    expect(readSwitchText(raw)).toBe('unset')
  })

  it.each(['yes', 'on', '2', 'enabled'])('[INV-110] reads %j as invalid', (raw) => {
    expect(readSwitchText(raw)).toBe('invalid')
  })

  it('[INV-110] names the two feature flags by their documented variables', () => {
    expect(FEATURE_FLAG_KEYS).toStrictEqual({
      guildAreasEnabled: 'GUILD_AREAS_ENABLED',
      boostEnabled: 'BOOST_ENABLED'
    })
  })
})
