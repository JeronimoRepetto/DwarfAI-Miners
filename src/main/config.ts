import type { TierThresholds } from './tier/tierService'

/**
 * Typed app configuration loaded from environment variables.
 * Invalid values fail fast at startup instead of being silently corrected.
 */
export interface AppConfig {
  /** How often the provider scanner polls for agent activity, in milliseconds. */
  pollIntervalMs: number
  /** How long an agent counts as alive after its last observed activity, in seconds. */
  livenessWindowS: number
  /** Codex-specific liveness: rollout mtime age that still counts as an open session. */
  codexLivenessWindowS: number
  /**
   * How many day-directories (today back N-1 days) to scan under the Codex
   * sessions root. A rollout lives in its START-date directory forever, so
   * scanning only today/yesterday hides a session opened earlier that is
   * still active; mtime filtering keeps this cheap even at a week of days.
   */
  codexScanDays: number
  /**
   * How long a Codex rollout stays visible past codexLivenessWindowS while a
   * codex process is still running (idle CLI writes nothing to its rollout,
   * so mtime alone can't tell "open but quiet" from "closed").
   */
  codexIdleRetentionS: number
  /** How long a disappeared dwarf stays visible with status 'leaving' before being dropped. */
  dwarfLeaveGraceS: number
  /** How long a computed project tier stays cached, in seconds. */
  tierCacheTtlS: number
  /** Source-file counts at which a mine upgrades to the next tier. */
  tierThresholds: TierThresholds
  /**
   * Claude config roots to scan (semicolon-separated in the env var). This PC
   * runs two accounts with separate dirs; roots that do not exist are skipped.
   */
  claudeConfigDirs: string[]
  /** The Codex sessions root. A leading ~ is expanded against the real home dir. */
  codexSessionsRoot: string
}

export function defaultConfig(): AppConfig {
  return {
    pollIntervalMs: 2000,
    livenessWindowS: 90,
    codexLivenessWindowS: 300,
    codexScanDays: 7,
    codexIdleRetentionS: 3600,
    dwarfLeaveGraceS: 20,
    tierCacheTtlS: 600,
    tierThresholds: { copperAt: 25, silverAt: 100, goldAt: 400, uraniumAt: 1500 },
    claudeConfigDirs: ['~/.claude', '~/.claude-multitec'],
    codexSessionsRoot: '~/.codex/sessions'
  }
}

type Env = Record<string, string | undefined>

function readPositiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[config] ${key} must be a positive integer, got "${raw}"`)
  }
  return value
}

function readDirList(env: Env, key: string, fallback: string[]): string[] {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') {
    return [...fallback]
  }
  const dirs = raw
    .split(';')
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '')
  if (dirs.length === 0) {
    throw new Error(`[config] ${key} must contain at least one directory, got "${raw}"`)
  }
  return dirs
}

function readPath(env: Env, key: string, fallback: string): string {
  const raw = env[key]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

function readTierThresholds(env: Env, fallback: TierThresholds): TierThresholds {
  const thresholds: TierThresholds = {
    copperAt: readPositiveInt(env, 'TIER_COPPER_AT', fallback.copperAt),
    silverAt: readPositiveInt(env, 'TIER_SILVER_AT', fallback.silverAt),
    goldAt: readPositiveInt(env, 'TIER_GOLD_AT', fallback.goldAt),
    uraniumAt: readPositiveInt(env, 'TIER_URANIUM_AT', fallback.uraniumAt)
  }
  const ordered =
    thresholds.copperAt < thresholds.silverAt &&
    thresholds.silverAt < thresholds.goldAt &&
    thresholds.goldAt < thresholds.uraniumAt
  if (!ordered) {
    throw new Error(
      '[config] tier thresholds must be strictly increasing ' +
        '(TIER_COPPER_AT < TIER_SILVER_AT < TIER_GOLD_AT < TIER_URANIUM_AT)'
    )
  }
  return thresholds
}

export function loadConfig(env: Env = process.env): AppConfig {
  const defaults = defaultConfig()
  return {
    pollIntervalMs: readPositiveInt(env, 'POLL_INTERVAL_MS', defaults.pollIntervalMs),
    livenessWindowS: readPositiveInt(env, 'LIVENESS_WINDOW_S', defaults.livenessWindowS),
    codexLivenessWindowS: readPositiveInt(
      env,
      'CODEX_LIVENESS_WINDOW_S',
      defaults.codexLivenessWindowS
    ),
    codexScanDays: readPositiveInt(env, 'CODEX_SCAN_DAYS', defaults.codexScanDays),
    codexIdleRetentionS: readPositiveInt(
      env,
      'CODEX_IDLE_RETENTION_S',
      defaults.codexIdleRetentionS
    ),
    dwarfLeaveGraceS: readPositiveInt(env, 'DWARF_LEAVE_GRACE_S', defaults.dwarfLeaveGraceS),
    tierCacheTtlS: readPositiveInt(env, 'TIER_CACHE_TTL_S', defaults.tierCacheTtlS),
    tierThresholds: readTierThresholds(env, defaults.tierThresholds),
    claudeConfigDirs: readDirList(env, 'CLAUDE_CONFIG_DIRS', defaults.claudeConfigDirs),
    codexSessionsRoot: readPath(env, 'CODEX_SESSIONS_ROOT', defaults.codexSessionsRoot)
  }
}
