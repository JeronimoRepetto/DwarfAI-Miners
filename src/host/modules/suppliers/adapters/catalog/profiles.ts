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
// UNVERIFIED `U→x` value counted as its in-force `x` (INV-44). For an unordered enum (`resume`,
// `mcpInjection`, `console`, `earlyFailure`, `installDetection`) the type holds one value, so the
// record carries the preferred driver's row; the merge that reads ceilings is ISSUE-147's.
// `answerChannelGate` and `publicLaunch` are applied by the catalogue and the registry, never
// folded into the ceiling.
import type { ProviderCapabilities } from '../../domain/capabilities'
import type { CatalogRecord } from '../../domain/profile'

/** 15 §3 rows C2–C5 (preferred driver C3, `acp`). */
const CLAUDE_CEILING: ProviderCapabilities = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: true,
  staleAnswerSafe: true,
  resume: 'load',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'transcript',
  usage: { fidelity: 2, rateLimits: true },
  mcpInjection: 'ticket-file',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'detected',
  observedQuestion: 'detected'
}

/** 15 §3 rows X1–X3 (preferred driver X1, `app-server-rpc`). */
const CODEX_CEILING: ProviderCapabilities = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: true,
  staleAnswerSafe: true,
  resume: 'resume',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'events',
  usage: { fidelity: 2, rateLimits: true },
  mcpInjection: 'ticket-file',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'detected'
}

/** 15 §3 rows O1–O3 (preferred driver O1, `http-server`); the answer channel is gated (ADR-011 item 7). */
const OPENCODE_CEILING: ProviderCapabilities = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none',
  adopt: true,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'transcript',
  usage: { fidelity: 1, rateLimits: false },
  mcpInjection: 'ticket-file',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'detected',
  observedQuestion: 'none'
}

/** 15 §3 rows A1–A2 (driver A1, `ndjson`, development builds only: `publicLaunch: 'gated'`). */
const ANTIGRAVITY_CEILING: ProviderCapabilities = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: false,
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'cli-flag',
  adopt: false,
  turnEnd: 'none',
  reactionEvidence: 'none',
  subagents: 'none',
  usage: { fidelity: 1, rateLimits: false },
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'exit-only',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}

/**
 * The SimulatedDriver's set (15 §4.12: test configuration). It opens no ask, resumes nothing and
 * resolves no CLI, so those fields stay at their lowest values.
 */
const SIMULATED_CEILING: ProviderCapabilities = {
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
  ceiling: SIMULATED_CEILING,
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
      // ADR-009 D4 (AMENDMENT-2, OQ-52): a user-installed claude-agent-acp, then `claude -p`.
      drivers: ['acp', 'stream-json'],
      publicLaunch: 'enabled'
    },
    ceiling: CLAUDE_CEILING
  },
  {
    profile: {
      id: 'codex',
      label: 'Codex',
      binaries: ['codex'],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers: ['app-server-rpc', 'acp'],
      publicLaunch: 'enabled'
    },
    ceiling: CODEX_CEILING
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
