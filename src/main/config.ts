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
  /** Codex-specific liveness: activity age that still counts as an open session. */
  codexLivenessWindowS: number
  /**
   * How recent a Codex logs_2.sqlite row must be to count as a liveness
   * heartbeat, in seconds. Codex appends log rows continuously while a turn
   * runs, which is the signal a rollout's mtime fails to provide on Windows.
   */
  codexHeartbeatWindowS: number
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
  /** Source-byte-weight (KB) thresholds at which a mine upgrades to the next tier. */
  tierThresholds: TierThresholds
  /**
   * Claude config roots to scan. Defaults to the single standard root; set
   * CLAUDE_CONFIG_DIRS (semicolon-separated) to scan more, which is what a
   * machine running several Claude accounts with separate dirs needs. Roots
   * that do not exist are skipped.
   */
  claudeConfigDirs: string[]
  /** The Codex sessions root. A leading ~ is expanded against the real home dir. */
  codexSessionsRoot: string
  /**
   * Codex's authoritative thread registry (CODEX_HOME/state_5.sqlite). Read
   * read-only; a missing file simply disables registry-backed discovery.
   */
  codexStateDb: string
  /** Codex's structured log stream (CODEX_HOME/logs_2.sqlite), used as a liveness heartbeat. */
  codexLogsDb: string
  /**
   * Model the one-shot `claude -p` relay runs on when delivering a message to
   * a headless session. The relay only forwards a string, so the cheapest
   * model is the right default.
   */
  sendTextRelayModel: string
  /** How long a message delivery may take before it is reported as timed out, in seconds. */
  sendTextTimeoutS: number
  /**
   * Loopback TCP port the optional hook listener binds, and the port the hook
   * commands written into Claude's settings.json post to. Nothing listens here
   * until the user enables "Instant updates" in the tray.
   */
  hooksPort: number
}

export function defaultConfig(): AppConfig {
  return {
    pollIntervalMs: 2000,
    livenessWindowS: 90,
    codexLivenessWindowS: 300,
    codexHeartbeatWindowS: 300,
    codexScanDays: 7,
    codexIdleRetentionS: 3600,
    dwarfLeaveGraceS: 20,
    tierCacheTtlS: 600,
    tierThresholds: { copperKb: 100, silverKb: 500, goldKb: 2048, uraniumKb: 8192 },
    claudeConfigDirs: ['~/.claude'],
    codexSessionsRoot: '~/.codex/sessions',
    codexStateDb: '~/.codex/state_5.sqlite',
    codexLogsDb: '~/.codex/logs_2.sqlite',
    sendTextRelayModel: 'haiku',
    sendTextTimeoutS: 60,
    hooksPort: 47821
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

/** A TCP port number; anything outside 1-65535 is a startup error, not a silent clamp. */
function readPort(env: Env, key: string, fallback: number): number {
  const port = readPositiveInt(env, key, fallback)
  if (port > 65535) {
    throw new Error(`[config] ${key} must be a port between 1 and 65535, got "${env[key]}"`)
  }
  return port
}

/** A trimmed free-form string (a path, a model name); blank counts as unset. */
function readTrimmed(env: Env, key: string, fallback: string): string {
  const raw = env[key]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

function readTierThresholds(env: Env, fallback: TierThresholds): TierThresholds {
  const thresholds: TierThresholds = {
    copperKb: readPositiveInt(env, 'TIER_COPPER_KB', fallback.copperKb),
    silverKb: readPositiveInt(env, 'TIER_SILVER_KB', fallback.silverKb),
    goldKb: readPositiveInt(env, 'TIER_GOLD_KB', fallback.goldKb),
    uraniumKb: readPositiveInt(env, 'TIER_URANIUM_KB', fallback.uraniumKb)
  }
  const ordered =
    thresholds.copperKb < thresholds.silverKb &&
    thresholds.silverKb < thresholds.goldKb &&
    thresholds.goldKb < thresholds.uraniumKb
  if (!ordered) {
    throw new Error(
      '[config] tier thresholds must be strictly increasing ' +
        '(TIER_COPPER_KB < TIER_SILVER_KB < TIER_GOLD_KB < TIER_URANIUM_KB)'
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
    codexHeartbeatWindowS: readPositiveInt(
      env,
      'CODEX_HEARTBEAT_WINDOW_S',
      defaults.codexHeartbeatWindowS
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
    codexSessionsRoot: readTrimmed(env, 'CODEX_SESSIONS_ROOT', defaults.codexSessionsRoot),
    codexStateDb: readTrimmed(env, 'CODEX_STATE_DB', defaults.codexStateDb),
    codexLogsDb: readTrimmed(env, 'CODEX_LOGS_DB', defaults.codexLogsDb),
    sendTextRelayModel: readTrimmed(env, 'SENDTEXT_RELAY_MODEL', defaults.sendTextRelayModel),
    sendTextTimeoutS: readPositiveInt(env, 'SENDTEXT_TIMEOUT_S', defaults.sendTextTimeoutS),
    hooksPort: readPort(env, 'HOOKS_PORT', defaults.hooksPort)
  }
}
