import { CATALOG_PROVIDER_IDS, type CatalogProviderId } from '../catalog'
import type { Tier } from '../wire'

/**
 * Typed app configuration, parsed from a flat map of string settings.
 * Invalid values fail fast at startup instead of being silently corrected.
 *
 * This module deliberately knows nothing about where those strings came from.
 * A development checkout gets them from a repo `.env` that dotenv has already
 * merged into `process.env`; an installed app gets them from the userData
 * config file, which `./configFile.ts` layers underneath the real environment
 * before calling in here (see #38). Keeping one string-map parser means both
 * transports share this file's validation and error messages instead of
 * growing a second, divergent set for a second format.
 *
 * Pure (05 §2.1 `config/`, R9): every reader takes its environment as an
 * argument. Reading `process.env` and the file on disk is the I/O half, which
 * lives with its callers (the Host's `FeatureFlagReader` in `host/wiring`,
 * ISSUE-211, per 16 §4.12 and 05 §5.1 R9; UI main for A-29).
 */
/**
 * The settings EVERY provider has, whatever its backend reads (issue #78).
 *
 * Provider settings used to be flat top-level `AppConfig` keys — nine of them
 * between two backends — so a third cost N more fields and N more parse calls
 * written into one flat literal, and provider-agnostic code had no way to ask
 * a provider for its own setting without knowing its name. This is the shared
 * half: what a new backend gets for free rather than having to plumb.
 *
 * The CLI override is the one that already had a provider-agnostic consumer —
 * `platformAdapters`'s `cliOverrides` used to spread two hand-written entries.
 */
export interface ProviderConfig {
  /**
   * Explicit path to this provider's CLI binary, overriding detection (#91).
   * Blank means "detect it" — the app looks in the known install locations and
   * then PATH. Set one when the install is somewhere the conventions do not
   * reach (npm global, Homebrew, a custom prefix), where an empty result would
   * otherwise be the only signal.
   */
  cliPath: string
}

/** Claude's settings block: which config roots to scan. */
export interface ClaudeConfig extends ProviderConfig {
  /**
   * Claude config roots to scan. Defaults to the single standard root; set
   * CLAUDE_CONFIG_DIRS (semicolon-separated) to scan more, which is what a
   * machine running several Claude accounts with separate dirs needs. Roots
   * that do not exist are skipped.
   */
  configDirs: string[]
}

/** Codex's settings block: where its rollouts and registry live, and its windows. */
export interface CodexConfig extends ProviderConfig {
  /** The Codex sessions root. A leading ~ is expanded against the real home dir. */
  sessionsRoot: string
  /**
   * Codex's authoritative thread registry (CODEX_HOME/state_5.sqlite). Read
   * read-only; a missing file simply disables registry-backed discovery.
   */
  stateDb: string
  /** Codex's structured log stream (CODEX_HOME/logs_2.sqlite), used as a liveness heartbeat. */
  logsDb: string
  /** Activity age that still counts as an open session, in seconds. */
  livenessWindowS: number
  /**
   * How recent a logs_2.sqlite row must be to count as a liveness heartbeat,
   * in seconds. Codex appends log rows continuously while a turn runs, which
   * is the signal a rollout's mtime fails to provide on Windows.
   */
  heartbeatWindowS: number
  /**
   * How many day-directories (today back N-1 days) to scan under the sessions
   * root. A rollout lives in its START-date directory forever, so scanning
   * only today/yesterday hides a session opened earlier that is still active;
   * mtime filtering keeps this cheap even at a week of days.
   */
  scanDays: number
  /**
   * How long a rollout stays visible past livenessWindowS while a codex
   * process is still running (an idle CLI writes nothing to its rollout, so
   * mtime alone can't tell "open but quiet" from "closed").
   */
  idleRetentionS: number
}

/**
 * Antigravity's settings block: where the CLI keeps its store, and the three
 * windows the observer judges a conversation by (#237).
 *
 * The windows are shaped differently from Codex's, because the evidence is:
 * the Antigravity CLI writes a presence LOCK per running conversation, which
 * is the CLI's own statement that a session exists rather than an inference
 * from a file's age. That is stronger than a mtime and still not a contract —
 * a crash leaves the lock behind, and nothing documents when the CLI removes
 * one — so it takes a grace window on disappearance and a bound on staleness
 * instead of Codex's liveness-plus-retention pair.
 */
export interface AntigravityConfig extends ProviderConfig {
  /** The `~/.gemini/antigravity-cli` store root. A leading ~ is expanded. */
  storeRoot: string
  /**
   * How recent a still-`RUNNING` transcript step has to be to count as an open
   * turn, in seconds. The step's `status` is written once and never rewritten,
   * so a crashed turn leaves a RUNNING record on disk forever; without this
   * bound its dwarf would mine for eternity.
   */
  busyWindowS: number
  /**
   * How long a conversation stays on the board after its presence lock stops
   * being listed, in seconds. A lock can be replaced between two reads, and
   * dropping a dwarf on one missed listing makes the board flicker.
   */
  lockGraceS: number
  /**
   * How silent a locked conversation may be before its lock is treated as
   * stale, in seconds. Generous on purpose: an interactive session
   * legitimately sits idle for hours between prompts, and this app takes the
   * generous side when the evidence runs out — raise it if a ghost dwarf is
   * less annoying than a real one leaving early.
   */
  staleLockWindowS: number
}

/**
 * OpenCode's settings block: where `opencode.db` lives (#444).
 *
 * The plainest block so far: one setting, no window of any kind. There is
 * nothing to bound because the provider takes no liveness signal off a file's
 * age at all — `event.seq` and the message rows themselves decide that (see
 * `opencodeProvider.ts`) — and no retention constant of its own, because
 * retention is `dwarfSilenceWindowMs(role, attendance)`, the same shared rule
 * every provider answers to.
 */
export interface OpenCodeConfig extends ProviderConfig {
  /** The `~/.local/share/opencode` store root; `opencode.db` lives directly under it. */
  storeRoot: string
}

/**
 * One settings block per provider identity.
 *
 * Keyed by `CatalogProviderId`, an open string (ADR-009 D2, BR-10): a provider
 * id is never a closed enum, so the compiler can no longer insist on a block
 * per provider. The promise is kept at run time instead: every id in
 * `CATALOG_PROVIDER_IDS` has a block and every block is a catalog id
 * (config.test.ts, "per-provider settings blocks"), and `cliOverridesFrom`
 * reads the blocks through the catalog list rather than by name.
 */
export interface ProviderConfigs extends Record<CatalogProviderId, ProviderConfig> {
  claude: ClaudeConfig
  codex: CodexConfig
  antigravity: AntigravityConfig
  opencode: OpenCodeConfig
  /**
   * The simulated provider (15 §4.12 `SimulatedDriver`, development builds only) has no CLI to point at,
   * so its block is the shared sub-shape alone and no variable overrides it; its world is configured by
   * `loadSimulationConfig` below. It still has a block because every catalog id does.
   */
  simulated: ProviderConfig
}

export interface AppConfig {
  /** How often the provider scanner polls for agent activity, in milliseconds. */
  pollIntervalMs: number
  /**
   * How long an agent counts as alive after its last observed activity, in
   * seconds. Reserved and general: a provider that measures liveness its own
   * way carries its own window in its block below (Codex does).
   */
  livenessWindowS: number
  /** How long a disappeared dwarf stays visible with status 'leaving' before being dropped. */
  dwarfLeaveGraceS: number
  /** How long a computed project tier stays cached, in seconds. */
  tierCacheTtlS: number
  // No tier thresholds here (ISSUE-010): they are the mines domain's `TierThresholds`, "defaults and
  // validated overrides" with their own shape and fallback rule (06 §0.2 row `TierThresholds`, 06 §4.1;
  // built by ISSUE-062). The legacy parser keeps TIER_COPPER_KB … TIER_URANIUM_KB until then.
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
  /**
   * Whether the guild areas are shown: the nav's Guild group and the Lab,
   * Market and Laboral Union pages (#635). They are designed in full and ship
   * hidden, so this is off by default and deliberately not a Settings row —
   * turning it on is one line of configuration, reachable from an installed
   * app through the userData file like every other setting here.
   */
  guildAreasEnabled: boolean
  /** Everything that belongs to one backend rather than to the panel (#78). */
  providers: ProviderConfigs
}

export function defaultConfig(): AppConfig {
  // Each block is built as its own typed value first: `ProviderConfigs` carries an open index signature
  // (ADR-009 D2), and a fresh object literal written straight into it is also checked against that
  // signature, which would reject every provider-specific field.
  const claude: ClaudeConfig = {
    cliPath: '',
    configDirs: ['~/.claude']
  }
  const codex: CodexConfig = {
    cliPath: '',
    sessionsRoot: '~/.codex/sessions',
    stateDb: '~/.codex/state_5.sqlite',
    logsDb: '~/.codex/logs_2.sqlite',
    livenessWindowS: 300,
    heartbeatWindowS: 300,
    scanDays: 7,
    idleRetentionS: 3600
  }
  const antigravity: AntigravityConfig = {
    cliPath: '',
    storeRoot: '~/.gemini/antigravity-cli',
    busyWindowS: 120,
    lockGraceS: 30,
    // A day. An Antigravity session left open overnight is still a session
    // its owner will come back to; a lock a crash left behind is not, and
    // this is the line between them.
    staleLockWindowS: 86_400
  }
  const opencode: OpenCodeConfig = {
    cliPath: '',
    storeRoot: '~/.local/share/opencode'
  }
  const simulated: ProviderConfig = {
    cliPath: ''
  }
  return {
    pollIntervalMs: 2000,
    livenessWindowS: 90,
    dwarfLeaveGraceS: 20,
    tierCacheTtlS: 600,
    sendTextRelayModel: 'haiku',
    sendTextTimeoutS: 60,
    hooksPort: 47821,
    guildAreasEnabled: false,
    providers: { claude, codex, antigravity, opencode, simulated }
  }
}

/**
 * The non-blank CLI overrides, keyed by provider (#78, #91).
 *
 * Derived from the provider table rather than written out at the composition
 * point, which used to spread one hand-written entry per backend: a third
 * provider's `*_CLI_PATH` would have been parsed into its block and then
 * silently dropped on the way to detection. Blank stays absent, because blank
 * means "detect it" and an empty string handed to the detector would override
 * detection with nothing.
 */
export function cliOverridesFrom(config: AppConfig): Partial<Record<CatalogProviderId, string>> {
  const overrides: Partial<Record<CatalogProviderId, string>> = {}
  for (const provider of CATALOG_PROVIDER_IDS) {
    // An open id may have no block (ADR-009 D2); no block means no override.
    const cliPath = config.providers[provider]?.cliPath
    if (cliPath !== undefined && cliPath !== '') {
      overrides[provider] = cliPath
    }
  }
  return overrides
}

/**
 * One layer of settings: keys are the documented variable names, values are
 * their raw unparsed text. Exported so a non-environment source (the userData
 * config file) can be layered into the same shape rather than parsed twice.
 */
export type ConfigEnv = Record<string, string | undefined>

function readPositiveInt(env: ConfigEnv, key: string, fallback: number): number {
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

/**
 * A count where zero is a meaningful answer rather than "unset" — unlike
 * readPositiveInt, whose callers all measure something that cannot be nothing
 * (an interval, a window, a port). Bounded above for the same reason a port is:
 * an out-of-range value is a typo, and a typo should stop startup.
 */
function readNonNegativeInt(env: ConfigEnv, key: string, fallback: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`[config] ${key} must be an integer between 0 and ${max}, got "${raw}"`)
  }
  return value
}

function readDirList(env: ConfigEnv, key: string, fallback: string[]): string[] {
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
function readPort(env: ConfigEnv, key: string, fallback: number): number {
  const port = readPositiveInt(env, key, fallback)
  if (port > 65535) {
    throw new Error(`[config] ${key} must be a port between 1 and 65535, got "${env[key]}"`)
  }
  return port
}

/**
 * A product switch: `true`/`1` or `false`/`0`, trimmed and case-insensitive,
 * with blank counting as unset. Anything else is a startup error naming the key
 * rather than a silent "off" (#635): unlike `readFlag`'s development switches,
 * a feature flag left off by a typo would look exactly like the flag not
 * working, which is the bug a bad value exists to surface.
 */
function readBoolean(env: ConfigEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  if (normalized === '0' || normalized === 'false') return false
  throw new Error(`[config] ${key} must be true, false, 1 or 0, got "${raw}"`)
}

/** A trimmed free-form string (a path, a model name); blank counts as unset. */
function readTrimmed(env: ConfigEnv, key: string, fallback: string): string {
  const raw = env[key]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

/**
 * The documented variable each shared provider setting is read from.
 *
 * Passed in rather than derived from the provider's name, because the names
 * are the USER's contract — they are in the README table and .env.example, and
 * #78 restructured the shape behind them without touching one of them. Two
 * backends happening to prefix theirs (`CLAUDE_`, `CODEX_`) is a convention,
 * not a rule the next one can be held to, and a derived name would silently
 * rename somebody's setting the day it stopped holding.
 */
interface ProviderEnvKeys {
  cliPath: string
}

/** One provider's shared settings — the half `readClaudeConfig` and its siblings never repeat. */
function readProviderConfig(
  env: ConfigEnv,
  keys: ProviderEnvKeys,
  fallback: ProviderConfig
): ProviderConfig {
  return {
    cliPath: readTrimmed(env, keys.cliPath, fallback.cliPath)
  }
}

function readClaudeConfig(env: ConfigEnv, fallback: ClaudeConfig): ClaudeConfig {
  return {
    ...readProviderConfig(env, { cliPath: 'CLAUDE_CLI_PATH' }, fallback),
    configDirs: readDirList(env, 'CLAUDE_CONFIG_DIRS', fallback.configDirs)
  }
}

function readCodexConfig(env: ConfigEnv, fallback: CodexConfig): CodexConfig {
  return {
    ...readProviderConfig(env, { cliPath: 'CODEX_CLI_PATH' }, fallback),
    sessionsRoot: readTrimmed(env, 'CODEX_SESSIONS_ROOT', fallback.sessionsRoot),
    stateDb: readTrimmed(env, 'CODEX_STATE_DB', fallback.stateDb),
    logsDb: readTrimmed(env, 'CODEX_LOGS_DB', fallback.logsDb),
    livenessWindowS: readPositiveInt(env, 'CODEX_LIVENESS_WINDOW_S', fallback.livenessWindowS),
    heartbeatWindowS: readPositiveInt(env, 'CODEX_HEARTBEAT_WINDOW_S', fallback.heartbeatWindowS),
    scanDays: readPositiveInt(env, 'CODEX_SCAN_DAYS', fallback.scanDays),
    idleRetentionS: readPositiveInt(env, 'CODEX_IDLE_RETENTION_S', fallback.idleRetentionS)
  }
}

function readAntigravityConfig(env: ConfigEnv, fallback: AntigravityConfig): AntigravityConfig {
  return {
    ...readProviderConfig(env, { cliPath: 'ANTIGRAVITY_CLI_PATH' }, fallback),
    storeRoot: readTrimmed(env, 'ANTIGRAVITY_STORE_ROOT', fallback.storeRoot),
    busyWindowS: readPositiveInt(env, 'ANTIGRAVITY_BUSY_WINDOW_S', fallback.busyWindowS),
    lockGraceS: readPositiveInt(env, 'ANTIGRAVITY_LOCK_GRACE_S', fallback.lockGraceS),
    staleLockWindowS: readPositiveInt(
      env,
      'ANTIGRAVITY_STALE_LOCK_WINDOW_S',
      fallback.staleLockWindowS
    )
  }
}

/**
 * OpenCode's block (#444). One setting: `readTrimmed` already gives blank the
 * fall-through-to-file behaviour every other setting has, so there is nothing
 * else here to parse — no window, and no `Platform` parameter, because the
 * default's shape does not branch on the host OS (D6).
 */
function readOpenCodeConfig(env: ConfigEnv, fallback: OpenCodeConfig): OpenCodeConfig {
  return {
    ...readProviderConfig(env, { cliPath: 'OPENCODE_CLI_PATH' }, fallback),
    storeRoot: readTrimmed(env, 'OPENCODE_STORE_ROOT', fallback.storeRoot)
  }
}

export function loadConfig(env: ConfigEnv): AppConfig {
  const defaults = defaultConfig()
  return {
    pollIntervalMs: readPositiveInt(env, 'POLL_INTERVAL_MS', defaults.pollIntervalMs),
    livenessWindowS: readPositiveInt(env, 'LIVENESS_WINDOW_S', defaults.livenessWindowS),
    dwarfLeaveGraceS: readPositiveInt(env, 'DWARF_LEAVE_GRACE_S', defaults.dwarfLeaveGraceS),
    tierCacheTtlS: readPositiveInt(env, 'TIER_CACHE_TTL_S', defaults.tierCacheTtlS),
    sendTextRelayModel: readTrimmed(env, 'SENDTEXT_RELAY_MODEL', defaults.sendTextRelayModel),
    sendTextTimeoutS: readPositiveInt(env, 'SENDTEXT_TIMEOUT_S', defaults.sendTextTimeoutS),
    hooksPort: readPort(env, 'HOOKS_PORT', defaults.hooksPort),
    guildAreasEnabled: readBoolean(env, 'GUILD_AREAS_ENABLED', defaults.guildAreasEnabled),
    // One line per backend, and one reader to read it: the whole point of #78's
    // second place. A third provider adds an entry here and its own reader,
    // and nothing above this line has to know it exists.
    providers: {
      claude: readClaudeConfig(env, defaults.providers.claude),
      codex: readCodexConfig(env, defaults.providers.codex),
      antigravity: readAntigravityConfig(env, defaults.providers.antigravity),
      opencode: readOpenCodeConfig(env, defaults.providers.opencode),
      simulated: defaults.providers.simulated
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * The simulated valley (issue #42)
 * ---------------------------------------------------------------------------
 *
 * Everything below is a DEVELOPMENT switch, and it is deliberately kept off
 * `AppConfig`.
 *
 * That separation is the whole security property. `loadConfig` above is fed by
 * `withConfigFileFallback`, which layers the userData config file underneath
 * the real environment — and #38 made that file something a PACKAGED, installed
 * app reads on every launch. Any key reachable from `loadConfig` is therefore a
 * key an installed app can be made to honour, which is exactly what a switch
 * that invents mines must never be. So the simulation has its own reader, fed
 * only by a real process environment, and `AppConfig` stays unable to express
 * "show this user twenty mines that do not exist".
 *
 * That is one of the two locks. The other lives in `providers/simulated/
 * simulation.ts`, which refuses to build a simulation in a packaged build at
 * all, whatever the environment says. This reader is the one a developer turns;
 * that one is the one a user is protected by.
 *
 * Same reasoning as `perf.ts`'s DWARFAI_PERF, and the same naming: a debugging
 * device, switched on for one run with `DWARFAI_SIMULATE=1 pnpm dev`, never a
 * product setting anybody is expected to persist.
 */

/** The master switch. Absent or non-affirmative means no simulation, ever. */
export const SIMULATION_ENV_VAR = 'DWARFAI_SIMULATE'

/**
 * Upper bounds on the invented world.
 *
 * These exist because this is a tool for looking at the panel, and a typo
 * (`DWARFAI_SIMULATE_MINES=100000`) must fail fast at startup rather than
 * freeze the very panel it was meant to demonstrate. They are generous: the
 * map has 13 authored sites and the cave has 4 veins, so the defaults already
 * overflow both several times over.
 */
const MAX_SIMULATED_MINES = 60
const MAX_SIMULATED_CREW = 40
/** A step shorter than this would re-roll the world faster than a poll can publish it. */
const MIN_SIMULATION_STEP_MS = 250
const MAX_SIMULATION_STEP_MS = 600_000
/** An absurd per-dwarf burn rate is the point; an infinite one is a typo. */
const MAX_SIMULATION_TOKENS_PER_STEP = 10_000_000

/** Every tier a simulated mine may be placed on, poorest first. */
const SIMULATED_TIERS: readonly Tier[] = ['bronze', 'copper', 'silver', 'gold', 'uranium']

export interface SimulationConfig {
  /** Seeds every choice the world makes; the same seed replays the same valley. */
  seed: string
  /** How many mines to invent. Above 13 the map's authored sites start sharing (#20). */
  mines: number
  /**
   * The largest crew a mine may hold, foreman included. Ordinary mines get a
   * deterministic share of it; the showcase mine always gets all of it, which
   * is what guarantees the crowded-anchor paths of #19 and #43 are on screen.
   */
  maxCrew: number
  /** The tiers to spread the mines across, so the vault shows more than one material. */
  tiers: Tier[]
  /** How long one simulated tick lasts, in milliseconds of the injected clock. */
  stepMs: number
  /**
   * Whether the crew churns. Off freezes WHO is present and WHAT they are
   * doing — a stable frame to screenshot — while chatter and ore keep flowing,
   * because a frozen layout is what a screenshot needs, not a dead panel.
   */
  animate: boolean
  /** Tokens each dwarf burns per tick. Deliberately huge: the pile caps are the target. */
  tokensPerStep: number
}

/**
 * The defaults, chosen to overflow every documented limit at once rather than
 * to look plausible: 20 mines against 13 authored map sites (#20), and a
 * showcase crew of 12 against 4 veins, 2 rest spots and 1 foreman post (#19,
 * #43). 75k tokens per dwarf per 4-second tick crosses the 21-nugget pile cap
 * (#22) of even the dearest material inside a minute.
 */
export function defaultSimulationConfig(): SimulationConfig {
  return {
    seed: 'dwarfai',
    mines: 20,
    maxCrew: 12,
    tiers: [...SIMULATED_TIERS],
    stepMs: 4_000,
    animate: true,
    tokensPerStep: 75_000
  }
}

/** A switch is on only for an explicit yes; anything else — including junk — is off. */
function readFlag(env: ConfigEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  if (normalized === '0' || normalized === 'false') return false
  // Anything else is not a considered answer, and for a switch that invents
  // mines the safe reading of an unconsidered answer is "no".
  return false
}

/** A bounded count; out of range is a startup error, not a silent clamp. */
function readBoundedInt(env: ConfigEnv, key: string, fallback: number, max: number): number {
  const value = readPositiveInt(env, key, fallback)
  if (value > max) {
    throw new Error(`[config] ${key} must be at most ${max}, got "${env[key]}"`)
  }
  return value
}

function readTierSpread(env: ConfigEnv, key: string, fallback: Tier[]): Tier[] {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return [...fallback]
  const names = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
  if (names.length === 0) {
    throw new Error(`[config] ${key} must name at least one tier, got "${raw}"`)
  }
  for (const name of names) {
    if (!SIMULATED_TIERS.includes(name as Tier)) {
      throw new Error(
        `[config] ${key} names the unknown tier "${name}"; valid tiers are ${SIMULATED_TIERS.join(', ')}`
      )
    }
  }
  return names as Tier[]
}

/**
 * The simulation settings for this run, or null when nothing asked for one.
 *
 * The caller hands in the REAL process environment on purpose — see the block
 * comment above. Never hand it a map that the userData config file has been
 * layered into; a caller that does has quietly given an installed app the
 * ability to invent mines.
 */
export function loadSimulationConfig(env: ConfigEnv): SimulationConfig | null {
  if (!readFlag(env, SIMULATION_ENV_VAR, false)) return null

  const defaults = defaultSimulationConfig()
  const stepMs = readBoundedInt(
    env,
    'DWARFAI_SIMULATE_STEP_MS',
    defaults.stepMs,
    MAX_SIMULATION_STEP_MS
  )
  if (stepMs < MIN_SIMULATION_STEP_MS) {
    throw new Error(
      `[config] DWARFAI_SIMULATE_STEP_MS must be at least ${MIN_SIMULATION_STEP_MS}, ` +
        `got "${env.DWARFAI_SIMULATE_STEP_MS}"`
    )
  }

  return {
    seed: readTrimmed(env, 'DWARFAI_SIMULATE_SEED', defaults.seed),
    mines: readBoundedInt(env, 'DWARFAI_SIMULATE_MINES', defaults.mines, MAX_SIMULATED_MINES),
    maxCrew: readBoundedInt(env, 'DWARFAI_SIMULATE_CREW', defaults.maxCrew, MAX_SIMULATED_CREW),
    tiers: readTierSpread(env, 'DWARFAI_SIMULATE_TIERS', defaults.tiers),
    stepMs,
    animate: readFlag(env, 'DWARFAI_SIMULATE_ANIMATE', defaults.animate),
    // Zero is a legitimate setting: a valley that mines nothing, for looking at
    // placement alone with every ore pile deliberately empty.
    tokensPerStep: readNonNegativeInt(
      env,
      'DWARFAI_SIMULATE_TOKENS',
      defaults.tokensPerStep,
      MAX_SIMULATION_TOKENS_PER_STEP
    )
  }
}

/*
 * REMOVED in ISSUE-010: DARWIN_CONSOLE_INPUT_ENV_VAR, darwinConsoleInputOverride,
 * LINUX_CONSOLE_INPUT_ENV_VAR and linuxConsoleInputOverride stay in the legacy
 * parser. They gate typing into a terminal (Terminal.app, tmux), and the new
 * architecture runs agents over structured protocols, never as TUIs (OQ-01,
 * ADR-031, ADR-002 D1), so they have no destination here; they are retired
 * with the legacy runtime (cut 5).
 */
