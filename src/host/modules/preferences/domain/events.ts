// The public events of the preferences module (08 §1, §3; 16 §4.12). Published after commit (16 §2.3).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { HostPreferences } from './hostPreferences'
import type { ResetStep } from './resetSaga'

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

/** Every event this module publishes. */
export type PreferencesEvent =
  HostPreferencesChanged | MetricsResetStarted | MetricsResetFinished | MetricsResetFailed
