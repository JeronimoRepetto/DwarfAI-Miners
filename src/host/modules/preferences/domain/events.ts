// The public events of the preferences module (08 §1, §3; 16 §4.12). Published after commit (16 §2.3).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { IntegrationId, IntegrationState } from '../../../kernel/domain/values'
import type { HostPreferences } from './hostPreferences'
import type { ResetStep } from './resetSaga'
import type { WelcomeStepState } from './welcomeStep'

/** 08 `HostPreferencesChanged`: only when the stored preferences changed (ADR-024 D9). */
export type HostPreferencesChanged = DomainEvent<
  'HostPreferencesChanged',
  { preferences: HostPreferences }
>

/** 08 §0 `MetricsResetStarted`: the Reset saga's `db` transaction committed (07 S13.01). */
export type MetricsResetStarted = DomainEvent<
  'MetricsResetStarted',
  { resetId: string; epoch: number }
>

/** 08 §0 `MetricsResetFinished`: the saga reached `done` (07 S13.06). */
export type MetricsResetFinished = DomainEvent<
  'MetricsResetFinished',
  { resetId: string; epoch: number }
>

/** 08 §0 `MetricsResetFailed`: a step could not complete; it resumes at the next Host boot (07 S13.07). */
export type MetricsResetFailed = DomainEvent<
  'MetricsResetFailed',
  { resetId: string; step: ResetStep; reason: string; resumesOnNextStart: true }
>

/**
 * 16 §4.12 `WelcomeStepChanged` (AMENDMENT-7, OQ-68): the first-run consent step's state changed
 * (07 machine 41: the boot evaluation, S41.01, S41.02; later the answer, S41.05, and Reset, S41.07).
 * Published only when the state differs from the one the module held.
 */
export type WelcomeStepChanged = DomainEvent<'WelcomeStepChanged', { state: WelcomeStepState }>

/**
 * 16 §4.12 `IntegrationChanged { id: IntegrationId; state: IntegrationState }` (08 §0; ADR-011 item 7;
 * ADR-016 item 7): published after every enable, revert, failed write or failed revert (07 S14.02,
 * S14.04, S14.06, S14.07), a failed one carrying the unchanged state, so every window shows the real
 * state (16 §7.4). It never carries a channel token.
 */
export type IntegrationChanged = DomainEvent<
  'IntegrationChanged',
  { id: IntegrationId; state: IntegrationState }
>

/** Every event this module publishes. */
export type PreferencesEvent =
  | HostPreferencesChanged
  | IntegrationChanged
  | MetricsResetStarted
  | MetricsResetFinished
  | MetricsResetFailed
  | WelcomeStepChanged
