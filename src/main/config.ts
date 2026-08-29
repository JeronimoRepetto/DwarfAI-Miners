/**
 * Typed app configuration loaded from environment variables.
 * Invalid values fail fast at startup instead of being silently corrected.
 */
export interface AppConfig {
  /** How often the provider scanner polls for agent activity, in milliseconds. */
  pollIntervalMs: number
  /** How long an agent counts as alive after its last observed activity, in seconds. */
  livenessWindowS: number
}

export function defaultConfig(): AppConfig {
  return { pollIntervalMs: 2000, livenessWindowS: 90 }
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

export function loadConfig(env: Env = process.env): AppConfig {
  const defaults = defaultConfig()
  return {
    pollIntervalMs: readPositiveInt(env, 'POLL_INTERVAL_MS', defaults.pollIntervalMs),
    livenessWindowS: readPositiveInt(env, 'LIVENESS_WINDOW_S', defaults.livenessWindowS)
  }
}
