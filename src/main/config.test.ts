import { describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig } from './config'

describe('defaultConfig', () => {
  it('returns the documented defaults', () => {
    expect(defaultConfig()).toEqual({
      pollIntervalMs: 2000,
      livenessWindowS: 90,
      codexLivenessWindowS: 300,
      codexHeartbeatWindowS: 300,
      codexScanDays: 7,
      codexIdleRetentionS: 3600,
      dwarfLeaveGraceS: 20,
      tierCacheTtlS: 600,
      tierThresholds: { copperAt: 25, silverAt: 100, goldAt: 400, uraniumAt: 1500 },
      claudeConfigDirs: ['~/.claude', '~/.claude-multitec'],
      codexSessionsRoot: '~/.codex/sessions',
      codexStateDb: '~/.codex/state_5.sqlite',
      codexLogsDb: '~/.codex/logs_2.sqlite',
      sendTextRelayModel: 'haiku',
      sendTextTimeoutS: 60,
      hooksPort: 47821
    })
  })

  it('returns a fresh object on every call', () => {
    expect(defaultConfig()).not.toBe(defaultConfig())
    expect(defaultConfig().tierThresholds).not.toBe(defaultConfig().tierThresholds)
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
    expect(config.codexLivenessWindowS).toBe(900)
    expect(config.tierCacheTtlS).toBe(60)
    expect(config.codexScanDays).toBe(3)
    expect(config.codexIdleRetentionS).toBe(1800)
    expect(config.dwarfLeaveGraceS).toBe(45)
  })

  it('parses CODEX_SESSIONS_ROOT, keeping the leading ~ unexpanded', () => {
    expect(loadConfig({ CODEX_SESSIONS_ROOT: '~/custom/sessions' }).codexSessionsRoot).toBe(
      '~/custom/sessions'
    )
  })

  it('falls back to the default sessions root when CODEX_SESSIONS_ROOT is blank', () => {
    expect(() => loadConfig({ CODEX_SESSIONS_ROOT: '   ' })).not.toThrow()
    expect(loadConfig({ CODEX_SESSIONS_ROOT: '   ' }).codexSessionsRoot).toBe('~/.codex/sessions')
  })

  it('parses tier thresholds per key', () => {
    const config = loadConfig({ TIER_COPPER_AT: '10', TIER_URANIUM_AT: '2000' })
    expect(config.tierThresholds).toEqual({
      copperAt: 10,
      silverAt: 100,
      goldAt: 400,
      uraniumAt: 2000
    })
  })

  it('fails fast when tier thresholds are not strictly increasing', () => {
    expect(() => loadConfig({ TIER_COPPER_AT: '500' })).toThrowError(/threshold/i)
  })

  it('applies defaults per key independently', () => {
    expect(loadConfig({ POLL_INTERVAL_MS: '250' }).pollIntervalMs).toBe(250)
    expect(loadConfig({ POLL_INTERVAL_MS: '250' }).livenessWindowS).toBe(90)
  })

  it('parses CLAUDE_CONFIG_DIRS as a semicolon-separated list', () => {
    const config = loadConfig({ CLAUDE_CONFIG_DIRS: 'C:\\a ; C:\\b;;~/.claude ' })
    expect(config.claudeConfigDirs).toEqual(['C:\\a', 'C:\\b', '~/.claude'])
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
    expect(config.codexStateDb).toBe('~/.codex-alt/state_5.sqlite')
    expect(config.codexLogsDb).toBe('D:\\codex\\logs_2.sqlite')
    expect(config.codexHeartbeatWindowS).toBe(45)
  })

  it('falls back to the default registry paths when the vars are blank', () => {
    const config = loadConfig({ CODEX_STATE_DB: '  ', CODEX_LOGS_DB: '' })
    expect(config.codexStateDb).toBe('~/.codex/state_5.sqlite')
    expect(config.codexLogsDb).toBe('~/.codex/logs_2.sqlite')
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
})
