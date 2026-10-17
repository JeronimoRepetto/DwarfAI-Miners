// The v1 catalog (ADR-009 D4, D6): one record per provider, as data. Adding a provider is one
// appended record here plus its id in `CATALOG_PROVIDER_IDS`; nothing else changes (BR-10,
// INV-40). This adapter is the one place that names providers (R12 exempts adapters). "Other…" is
// never a record (INV-43): it is a launch way, not a supplier.
//
// Drivers attach later, one issue each (ISSUE-150…158); until a driver is attached, the
// registry offers none for that transport. Models, efforts and permission modes arrive with the
// catalog transplant (ISSUE-147). Labels are the providers' own plain-text names (ADR-008 item 7).
//
// Ceilings (ADR-009 D2 "each profile declares a ceiling"; 15 §0): the field-wise upper bound of
// the provider's rows in 15 §3 (driver rows and observed rows, C1 excluded: not offered in v1), an
// UNVERIFIED `U→x` value counted as its in-force `x` (INV-44). An unordered enum (`resume`,
// `mcpInjection`, `console`, `earlyFailure`, `installDetection`) holds the set of values those
// rows list, preferred driver's first (AMENDMENT-18, owner, 2026-10-16): a value a committed spike
// record has proven counts too (C2 `resume: cli-flag`, SP-15); a target a spike has not yet
// opened does not (`→ protocol after SP-12`). An `n/a` cell lists nothing.
// `answerChannelGate` and `publicLaunch` are applied by the catalogue and the registry, never
// folded into the ceiling.
import {
  ceilingOf,
  type CapabilityCeiling,
  type ProviderCapabilities
} from '../../domain/capabilities'
import type { CatalogRecord, PermissionModeCatalog, ProviderProfile } from '../../domain/profile'

/** 15 §3 rows C2–C5 (preferred driver C3, `acp`). */
const CLAUDE_CEILING: CapabilityCeiling = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: true,
  staleAnswerSafe: true,
  resume: ['load', 'cli-flag', 'none'], // C3 load, C2 cli-flag (SP-15), C4/C5 none
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'transcript',
  usage: { fidelity: 2, rateLimits: true },
  mcpInjection: ['ticket-file', 'none'], // C2/C3 ticket-file, C4/C5 none
  console: ['log', 'focus-terminal'], // C2/C3 log, C4/C5 focus-terminal
  earlyFailure: ['handshake', 'exit-only'], // C3 handshake, C2 exit-only (handshake after S-020-1)
  installDetection: ['user-binary'],
  observedPermission: 'detected',
  observedQuestion: 'detected'
}

/** 15 §3 rows X1–X3 (preferred driver X1, `app-server-rpc`). */
const CODEX_CEILING: CapabilityCeiling = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: true,
  staleAnswerSafe: true,
  resume: ['resume', 'load', 'none'], // X1 resume, X2 load, X3 none
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'events',
  usage: { fidelity: 2, rateLimits: true },
  mcpInjection: ['ticket-file', 'none'], // X1 ticket-file, X2 U→none, X3 none
  console: ['log'],
  earlyFailure: ['handshake'],
  installDetection: ['user-binary'],
  observedPermission: 'none',
  observedQuestion: 'detected'
}

/** 15 §3 rows O1–O3 (preferred driver O1, `http-server`); the answer channel is gated (ADR-011 item 7). */
const OPENCODE_CEILING: CapabilityCeiling = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: ['none'], // O1/O2 U→none, O3 none
  adopt: true,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'transcript',
  usage: { fidelity: 1, rateLimits: false },
  mcpInjection: ['ticket-file', 'none'], // O1 ticket-file, O2 U→none, O3 none
  console: ['log', 'focus-terminal'], // O1/O2 log, O3 focus-terminal
  earlyFailure: ['handshake'],
  installDetection: ['user-binary'],
  observedPermission: 'detected',
  observedQuestion: 'none'
}

/** 15 §3 rows A1–A2 (driver A1, `ndjson`, development builds only: `publicLaunch: 'gated'`). */
const ANTIGRAVITY_CEILING: CapabilityCeiling = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: false,
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: ['cli-flag', 'none'], // A1 cli-flag (AMENDMENT-13), A2 none
  adopt: false,
  turnEnd: 'none',
  reactionEvidence: 'none',
  subagents: 'none',
  usage: { fidelity: 1, rateLimits: false },
  mcpInjection: ['none'],
  console: ['log'],
  earlyFailure: ['exit-only'],
  installDetection: ['user-binary'],
  observedPermission: 'none',
  observedQuestion: 'none'
}

/**
 * The SimulatedDriver's set (15 §4.12: test configuration). It opens no ask, resumes nothing and
 * resolves no CLI, so those fields stay at their lowest values. One driver, one row: its ceiling
 * allows exactly the row's own values (`ceilingOf`).
 */
export const SIMULATED_CAPABILITIES: Readonly<ProviderCapabilities> = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'none',
  usage: { fidelity: 0, rateLimits: false },
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'none',
  observedPermission: 'none',
  observedQuestion: 'none'
}

/** The simulated provider (15 §4.12): development builds only. */
export const SIMULATED_RECORD: CatalogRecord = {
  profile: {
    id: 'simulated',
    label: 'Simulated',
    binaries: [],
    models: [],
    efforts: [],
    permissionModes: [],
    // The reference implementation stands in for the default driver kind (ADR-009 D4: ACP).
    drivers: ['acp'],
    publicLaunch: 'enabled'
  },
  ceiling: ceilingOf(SIMULATED_CAPABILITIES),
  developmentOnly: true
}

/** Every catalog record, in the order of `CATALOG_PROVIDER_IDS`. */
export const CATALOG_RECORDS: readonly CatalogRecord[] = [
  {
    profile: {
      id: 'claude',
      label: 'Claude Code',
      binaries: ['claude'],
      models: [],
      efforts: [],
      permissionModes: [],
      // ADR-009 D4 (AMENDMENT-2, OQ-52): a user-installed claude-agent-acp, then `claude -p`
      // (ClaudeStreamJsonDriver, ISSUE-150: offered only once SP-08 passes).
      drivers: ['acp', 'stream-json'],
      publicLaunch: 'enabled'
    },
    ceiling: CLAUDE_CEILING,
    // 15 §4 `childEnv`: the Claude Code variable a launched `claude` must share with the person's
    // own (15 §5 Claude row: honour CLAUDE_CONFIG_DIR, HO-09), so its config, login and transcripts
    // are the ones the observer reads. A path, never a credential (ADR-008 item 2).
    providerEnvVars: ['CLAUDE_CONFIG_DIR']
  },
  {
    profile: {
      id: 'codex',
      label: 'Codex',
      binaries: ['codex'],
      models: [],
      efforts: [],
      permissionModes: [],
      // ADR-009 D4: the person's `codex app-server` (CodexAppServerDriver, ISSUE-152), then
      // `codex-acp` when the probe finds no app-server subcommand (15 §2.3, §4.5).
      drivers: ['app-server-rpc', 'acp'],
      publicLaunch: 'enabled'
    },
    ceiling: CODEX_CEILING,
    // 15 §4 `childEnv`: the Codex variable a launched `codex` must share with the person's own (15
    // §5 Codex row: honour CODEX_HOME), so its config, login and rollouts are the ones the observer
    // reads. A path, never a credential (ADR-008 item 2).
    providerEnvVars: ['CODEX_HOME']
  },
  {
    profile: {
      id: 'antigravity',
      label: 'Antigravity',
      binaries: ['agy'],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers: ['ndjson'],
      // OQ-15: observed in public v1, launched in development builds only (ADR-009 D6).
      publicLaunch: 'gated'
    },
    ceiling: ANTIGRAVITY_CEILING
  },
  {
    profile: {
      id: 'opencode',
      label: 'OpenCode',
      binaries: ['opencode'],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers: ['http-server', 'acp'],
      publicLaunch: 'enabled',
      answerChannelGate: 'opencode-permissions'
    },
    ceiling: OPENCODE_CEILING
  },
  SIMULATED_RECORD
]

/**
 * ADR-011 item 1 and 15 §2.8 row "Kiro / other ACP": a provider whose permission ceiling is
 * `none` and that has no verified non-interactive deny policy is not launchable in public builds
 * (it may still be observed). Its record states it as `publicLaunch: 'gated'`, which the
 * catalogue and the registry apply; the catalog test holds every record to this rule, so an ACP
 * agent documenting no permission request (ISSUE-154; Kiro, ISSUE-158) cannot be offered.
 */
export function publicLaunchOf(
  ceiling: Pick<CapabilityCeiling, 'permission'>,
  modes?: PermissionModeCatalog
): ProviderProfile['publicLaunch'] {
  return ceiling.permission === 'none' && modes?.denyPolicyVerified !== true ? 'gated' : 'enabled'
}
