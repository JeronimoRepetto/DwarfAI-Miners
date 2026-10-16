// The "Other…" profile (15 §4.11; 15 §3 row H1): the profile and the capability ceiling the
// HostedCommandDriver runs under. "Other…" is a launch way, not a supplier: this profile is never
// a catalog record, never part of `launchable()` and never a Default provider (INV-43). It is
// data, like a catalog record, and lives with its driver because no catalog names it.
import type { ProviderCapabilities } from '../../../domain/capabilities'
import type { ProviderProfile } from '../../../domain/profile'

/** The adapter family of every "Other…" fact (`sourceKey` `adapterId`, 15 §1.5). */
export const HOSTED_COMMAND_ADAPTER_ID = 'other'

export const HOSTED_COMMAND_PROFILE: ProviderProfile = {
  id: 'other',
  label: 'Other…',
  // No install detection of its own (15 §3 H1 `installDetection: 'none'`): the person's command
  // names its program, so there is no binary to resolve.
  binaries: [],
  models: [],
  efforts: [],
  // ADR-011 item 1: "Other…" launches with no permission select (`permissionMode: null`).
  permissionModes: [],
  drivers: ['stdio-raw'],
  publicLaunch: 'enabled'
}

/** 15 §3 row H1, Table A and Table B. */
export const HOSTED_COMMAND_CEILING: ProviderCapabilities = {
  launch: true,
  observe: false,
  sendTurn: true,
  interrupt: false,
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none',
  adopt: false,
  turnEnd: 'none',
  reactionEvidence: 'none',
  subagents: 'none',
  usage: { fidelity: 0, rateLimits: false },
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'exit-only',
  installDetection: 'none',
  observedPermission: 'none',
  observedQuestion: 'none'
}
